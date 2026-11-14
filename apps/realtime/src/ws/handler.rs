use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, Notify};

use super::ticket::verify_ws_ticket;
use crate::{
    metrics,
    room::presence::{clear_presence, refresh_presence, set_presence},
    room::relay,
    state::AppState,
};

#[derive(Debug, Deserialize)]
struct AuthMessage {
    #[serde(rename = "type")]
    kind: String,
    payload: AuthPayload,
}

#[derive(Debug, Deserialize)]
struct AuthPayload {
    ticket: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", content = "payload")]
enum ClientEvent {
    #[serde(rename = "leave")]
    Leave {
        #[serde(rename = "roomId")]
        room_id: String,
    },
    #[serde(rename = "typing")]
    Typing {
        #[serde(rename = "roomId")]
        room_id: String,
        typing: bool,
    },
    #[serde(rename = "ping")]
    Ping,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Client frames are tiny (auth ticket, typing, ping, leave). Without a cap the
    // library accepts tens of megabytes per message, enough for a couple of
    // sockets to run the pod out of memory.
    ws.max_message_size(MAX_CLIENT_MESSAGE)
        .max_frame_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| handle_socket(socket, state))
}

const MAX_CLIENT_MESSAGE: usize = 4 * 1024;

/// Pings refresh presence in Redis; more often than this they only get a pong.
const PING_PRESENCE_EVERY: Duration = Duration::from_secs(10);

async fn consume_ticket(state: &AppState, ticket: &str) -> anyhow::Result<(String, String)> {
    let secret =
        std::env::var("WS_TICKET_SECRET").map_err(|_| anyhow::anyhow!("missing secret"))?;
    let claims = verify_ws_ticket(ticket, &secret)?;
    let key = format!("wsticket:{}", claims.jti);
    let mut redis = state.redis.clone();
    let stored: Option<String> = redis::cmd("GETDEL")
        .arg(&key)
        .query_async(&mut redis)
        .await?;
    let Some(raw) = stored else {
        anyhow::bail!("ticket already used or unknown");
    };
    let value: serde_json::Value = serde_json::from_str(&raw)?;
    let session_hash = value
        .get("sessionHash")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let room_id = value
        .get("roomId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    if session_hash != claims.session_hash || room_id != claims.room_id {
        anyhow::bail!("ticket binding mismatch");
    }
    Ok((claims.session_hash, claims.room_id))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    // First message must be auth { type: "auth", payload: { ticket } } within 5s.
    let auth = tokio::time::timeout(Duration::from_secs(5), receiver.next()).await;
    let (session_id, allowed_room) = match auth {
        Ok(Some(Ok(Message::Text(text)))) => match serde_json::from_str::<AuthMessage>(&text) {
            Ok(msg) if msg.kind == "auth" => {
                match consume_ticket(&state, &msg.payload.ticket).await {
                    Ok(pair) => {
                        metrics::ticket_consumed();
                        pair
                    }
                    Err(err) => {
                        tracing::warn!(error = %err, "ws ticket rejected");
                        metrics::auth_failure();
                        let _ = sender.send(Message::Close(None)).await;
                        return;
                    }
                }
            }
            _ => {
                metrics::auth_failure();
                let _ = sender.send(Message::Close(None)).await;
                return;
            }
        },
        _ => {
            metrics::auth_failure();
            let _ = sender.send(Message::Close(None)).await;
            return;
        }
    };

    metrics::connection_opened();
    let (tx, mut rx) = mpsc::channel::<Outgoing>(64);

    let mut send_task = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let frame = match out {
                Outgoing::Text(msg) => Message::Text(msg.into()),
                Outgoing::Close => {
                    let _ = sender.send(Message::Close(None)).await;
                    break;
                }
            };
            if sender.send(frame).await.is_err() {
                break;
            }
        }
    });

    // Tells this socket apart from the session's other sockets in presence.
    let conn_id = uuid::Uuid::new_v4().simple().to_string();
    let subscription = state.subscribe_room(&allowed_room, &session_id);
    let feed_gen = subscription.gen;
    let mut sub = subscription.rx;
    // Set when the session's feed is dropped (it left the room or ended).
    let removed = Arc::new(Notify::new());
    let online = set_presence(&state, &allowed_room, &session_id, &conn_id)
        .await
        .unwrap_or(0);
    relay::presence(&state, &allowed_room, online).await;

    let forward_tx = tx.clone();
    let forward_removed = removed.clone();
    let forward = tokio::spawn(async move {
        loop {
            match sub.recv().await {
                Ok(msg) => {
                    if forward_tx.send(Outgoing::Text(msg)).await.is_err() {
                        break;
                    }
                }
                // Dropped frames — ask the client to resync history instead of staying stale.
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    let ping = serde_json::json!({
                        "type": "resync",
                        "payload": { "reason": "lagged" }
                    })
                    .to_string();
                    if forward_tx.send(Outgoing::Text(ping)).await.is_err() {
                        break;
                    }
                }
                // The feed was dropped: this session is no longer in the room.
                // Say so, close the socket, and end the connection's loop.
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    let note = serde_json::json!({ "type": "room.removed" }).to_string();
                    let _ = forward_tx.send(Outgoing::Text(note)).await;
                    let _ = forward_tx.send(Outgoing::Close).await;
                    forward_removed.notify_one();
                    break;
                }
            }
        }
    });

    let _ = tx
        .send(Outgoing::Text(
            serde_json::json!({
                "type": "welcome",
                "payload": { "roomId": allowed_room }
            })
            .to_string(),
        ))
        .await;

    let heartbeat_state = state.clone();
    let heartbeat_room = allowed_room.clone();
    let heartbeat_session = session_id.clone();
    let heartbeat_conn = conn_id.clone();
    let heartbeat = tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop {
            interval.tick().await;
            if refresh_presence(
                &heartbeat_state,
                &heartbeat_room,
                &heartbeat_session,
                &heartbeat_conn,
            )
            .await
            .is_err()
            {
                break;
            }
        }
    });

    let mut last_presence_ping = Instant::now()
        .checked_sub(PING_PRESENCE_EVERY)
        .unwrap_or_else(Instant::now);

    // Cap typing broadcasts (~4/s) so a stuck client cannot flood the room.
    let mut last_typing = Instant::now()
        .checked_sub(Duration::from_secs(1))
        .unwrap_or_else(Instant::now);

    let mut was_removed = false;
    loop {
        let msg = tokio::select! {
            next = receiver.next() => match next {
                Some(Ok(msg)) => msg,
                _ => break,
            },
            _ = removed.notified() => {
                was_removed = true;
                break;
            }
        };
        match msg {
            Message::Text(text) => {
                if let Ok(event) = serde_json::from_str::<ClientEvent>(&text) {
                    match event {
                        ClientEvent::Leave { room_id } => {
                            metrics::message("leave");
                            if room_id == allowed_room {
                                let online =
                                    clear_presence(&state, &room_id, &session_id, &conn_id)
                                        .await
                                        .unwrap_or(0);
                                relay::presence(&state, &room_id, online).await;
                                break;
                            }
                        }
                        ClientEvent::Typing { room_id, typing } => {
                            metrics::message("typing");
                            if room_id == allowed_room {
                                let now = Instant::now();
                                if now.duration_since(last_typing) < Duration::from_millis(250) {
                                    continue;
                                }
                                last_typing = now;
                                // Not echoed back to the sender's session — client sessionId is
                                // a DB UUID while WS identity is sessionHash, so self-filters miss.
                                relay::typing(&state, &room_id, &session_id, typing).await;
                            }
                        }
                        ClientEvent::Ping => {
                            metrics::message("ping");
                            // A flood of pings cost four Redis operations each.
                            if last_presence_ping.elapsed() >= PING_PRESENCE_EVERY {
                                last_presence_ping = Instant::now();
                                let _ =
                                    refresh_presence(&state, &allowed_room, &session_id, &conn_id)
                                        .await;
                            }
                            let _ = tx
                                .send(Outgoing::Text(
                                    serde_json::json!({ "type": "pong" }).to_string(),
                                ))
                                .await;
                        }
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    heartbeat.abort();
    let online = clear_presence(&state, &allowed_room, &session_id, &conn_id)
        .await
        .unwrap_or(0);
    relay::presence(&state, &allowed_room, online).await;
    state.unsubscribe_room(&allowed_room, &session_id, feed_gen);
    forward.abort();
    if was_removed {
        // Let the "room.removed" note and the close frame go out first.
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut send_task).await;
    }
    send_task.abort();
    metrics::connection_closed();
}

/// What the socket's writer sends: a text frame, or a close that ends it.
enum Outgoing {
    Text(String),
    Close,
}
