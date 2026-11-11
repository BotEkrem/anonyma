use dashmap::DashMap;
use redis::aio::ConnectionManager;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tokio::sync::broadcast;

pub type RoomId = String;
pub type SessionId = String;

/// One session's feed for one room. A session can hold several sockets for the
/// same room (a second tab, or a reconnect that overlaps the old socket), so the
/// feed stays until the last of them closes.
struct RoomSub {
    tx: broadcast::Sender<String>,
    conns: usize,
    /// Which feed this is: an evicted session that rejoins gets a new one, and a
    /// late close of an old socket must not count against it.
    gen: u64,
}

/// A socket's handle on its feed: what it reads, and which feed it belongs to.
pub struct Subscription {
    pub rx: broadcast::Receiver<String>,
    pub gen: u64,
}

/// room_id -> session_id -> outbound feed, for the sockets on this pod.
#[derive(Default)]
pub struct Feeds {
    rooms: DashMap<RoomId, DashMap<SessionId, RoomSub>>,
    next_gen: AtomicU64,
}

impl Feeds {
    pub fn subscribe(&self, room_id: &str, session_id: &str) -> Subscription {
        let room = self
            .rooms
            .entry(room_id.to_string())
            .or_insert_with(DashMap::new);
        let mut sub = room
            .entry(session_id.to_string())
            .or_insert_with(|| RoomSub {
                tx: broadcast::channel(256).0,
                conns: 0,
                gen: self.next_gen.fetch_add(1, Ordering::Relaxed),
            });
        sub.conns += 1;
        Subscription {
            rx: sub.tx.subscribe(),
            gen: sub.gen,
        }
    }

    /// Called when one socket closes. Before, a closing socket dropped the
    /// session from every room on the pod, and its other sockets went deaf.
    pub fn unsubscribe(&self, room_id: &str, session_id: &str, gen: u64) {
        let now_empty = match self.rooms.get(room_id) {
            Some(room) => {
                room.remove_if_mut(session_id, |_, sub| {
                    if sub.gen != gen {
                        return false;
                    }
                    sub.conns = sub.conns.saturating_sub(1);
                    sub.conns == 0
                });
                room.is_empty()
            }
            None => false,
        };
        // The read guard above is gone: removing under it would deadlock the shard.
        if now_empty {
            self.rooms.remove_if(room_id, |_, room| room.is_empty());
        }
    }

    /// The session left the room (or ended): drop its feed on this pod. Every
    /// socket reading it sees the channel close and shuts down. Leaving used to
    /// stop nothing: an open socket kept receiving the room's messages.
    pub fn evict(&self, room_id: &str, session_id: &str) -> bool {
        let (removed, now_empty) = match self.rooms.get(room_id) {
            Some(room) => (room.remove(session_id).is_some(), room.is_empty()),
            None => (false, false),
        };
        if now_empty {
            self.rooms.remove_if(room_id, |_, room| room.is_empty());
        }
        removed
    }

    pub fn broadcast_room(&self, room_id: &str, payload: &str) {
        if let Some(room) = self.rooms.get(room_id) {
            for entry in room.iter() {
                let _ = entry.value().tx.send(payload.to_string());
            }
        }
    }

    /// Sends one payload to every connected session in every room.
    pub fn broadcast_all(&self, payload: &str) {
        for room in self.rooms.iter() {
            for entry in room.value().iter() {
                let _ = entry.value().tx.send(payload.to_string());
            }
        }
    }

    /// Same as broadcast_room but skips one session (e.g. typing echo to self).
    pub fn broadcast_room_except(&self, room_id: &str, except_session: &str, payload: &str) {
        if let Some(room) = self.rooms.get(room_id) {
            for entry in room.iter() {
                if entry.key() == except_session {
                    continue;
                }
                let _ = entry.value().tx.send(payload.to_string());
            }
        }
    }
}

pub struct AppState {
    pub redis: ConnectionManager,
    pub feeds: Feeds,
    /// Bus exchange and the key that seals events on it.
    pub exchange: String,
    pub message_key: [u8; 32],
    /// Publishing channel, present while the consumer's RabbitMQ connection is up.
    publisher: Mutex<Option<lapin::Channel>>,
}

impl AppState {
    pub async fn new(
        redis_url: &str,
        exchange: String,
        message_key: [u8; 32],
    ) -> anyhow::Result<Self> {
        let client = redis::Client::open(redis_url)?;
        let redis = ConnectionManager::new(client).await?;
        Ok(Self {
            redis,
            feeds: Feeds::default(),
            exchange,
            message_key,
            publisher: Mutex::new(None),
        })
    }

    pub fn set_publisher(&self, channel: Option<lapin::Channel>) {
        *self.publisher.lock().unwrap_or_else(|e| e.into_inner()) = channel;
    }

    pub fn publisher(&self) -> Option<lapin::Channel> {
        self.publisher
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn subscribe_room(&self, room_id: &str, session_id: &str) -> Subscription {
        self.feeds.subscribe(room_id, session_id)
    }

    pub fn unsubscribe_room(&self, room_id: &str, session_id: &str, gen: u64) {
        self.feeds.unsubscribe(room_id, session_id, gen)
    }

    pub fn evict_from_room(&self, room_id: &str, session_id: &str) -> bool {
        self.feeds.evict(room_id, session_id)
    }

    pub fn broadcast_room(&self, room_id: &str, payload: &str) {
        self.feeds.broadcast_room(room_id, payload)
    }

    pub fn broadcast_all(&self, payload: &str) {
        self.feeds.broadcast_all(payload)
    }

    pub fn broadcast_room_except(&self, room_id: &str, except_session: &str, payload: &str) {
        self.feeds
            .broadcast_room_except(room_id, except_session, payload)
    }
}

#[cfg(test)]
mod tests {
    use super::Feeds;
    use tokio::sync::broadcast::error::TryRecvError;

    #[test]
    fn second_socket_keeps_receiving_after_the_first_closes() {
        let feeds = Feeds::default();
        let first = feeds.subscribe("room", "s1");
        let mut second = feeds.subscribe("room", "s1");
        feeds.unsubscribe("room", "s1", first.gen);
        feeds.broadcast_room("room", "hi");
        assert_eq!(second.rx.try_recv().unwrap(), "hi");
    }

    #[test]
    fn closing_in_one_room_leaves_the_others() {
        let feeds = Feeds::default();
        let a = feeds.subscribe("a", "s1");
        let mut b = feeds.subscribe("b", "s1");
        feeds.unsubscribe("a", "s1", a.gen);
        feeds.broadcast_room("b", "hi");
        assert_eq!(b.rx.try_recv().unwrap(), "hi");
    }

    #[test]
    fn last_socket_out_drops_the_room() {
        let feeds = Feeds::default();
        let first = feeds.subscribe("room", "s1");
        let second = feeds.subscribe("room", "s1");
        feeds.unsubscribe("room", "s1", first.gen);
        assert!(feeds.rooms.contains_key("room"));
        feeds.unsubscribe("room", "s1", second.gen);
        assert!(!feeds.rooms.contains_key("room"));
        // A stray extra close does nothing.
        feeds.unsubscribe("room", "s1", second.gen);
        let mut again = feeds.subscribe("room", "s1");
        feeds.broadcast_room("room", "back");
        assert_eq!(again.rx.try_recv().unwrap(), "back");
    }

    #[test]
    fn except_skips_only_that_session() {
        let feeds = Feeds::default();
        let mut me = feeds.subscribe("room", "s1");
        let mut peer = feeds.subscribe("room", "s2");
        feeds.broadcast_room_except("room", "s1", "typing");
        assert!(me.rx.try_recv().is_err());
        assert_eq!(peer.rx.try_recv().unwrap(), "typing");
    }

    #[test]
    fn eviction_cuts_every_socket_of_that_session_and_only_that_session() {
        let feeds = Feeds::default();
        let mut gone_a = feeds.subscribe("room", "leaver");
        let mut gone_b = feeds.subscribe("room", "leaver");
        let mut stays = feeds.subscribe("room", "peer");
        assert!(feeds.evict("room", "leaver"));
        feeds.broadcast_room("room", "after");
        assert_eq!(gone_a.rx.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(gone_b.rx.try_recv(), Err(TryRecvError::Closed));
        assert_eq!(stays.rx.try_recv().unwrap(), "after");
    }

    #[test]
    fn a_late_close_of_an_evicted_socket_does_not_hurt_the_rejoined_feed() {
        let feeds = Feeds::default();
        let old = feeds.subscribe("room", "s1");
        feeds.evict("room", "s1");
        let mut fresh = feeds.subscribe("room", "s1");
        // The evicted socket closes after the session already came back.
        feeds.unsubscribe("room", "s1", old.gen);
        feeds.broadcast_room("room", "still here");
        assert_eq!(fresh.rx.try_recv().unwrap(), "still here");
    }
}
