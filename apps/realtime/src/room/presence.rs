use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

use redis::AsyncCommands;

use crate::state::AppState;

/// Seconds a socket stays counted without a heartbeat (sockets beat every 30 s).
const TTL_SECS: i64 = 90;

// Presence is kept per socket, not per session: with one entry per session a
// second tab (or an overlapping reconnect) closing took the session offline
// while it was still connected. Each entry carries its last heartbeat, so the
// sockets of a pod that died age out on their own. The online count is the
// number of distinct sessions. New key name: the old `presence:` keys were sets.
// core reads these keys too (apps/core/src/db/purge.service.ts): a room with a
// live socket is kept instead of purged. Keep the key, member and score in step.
fn key(room_id: &str) -> String {
    format!("online:{room_id}")
}

fn member(session_id: &str, conn_id: &str) -> String {
    format!("{session_id}|{conn_id}")
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub async fn set_presence(
    state: &AppState,
    room_id: &str,
    session_id: &str,
    conn_id: &str,
) -> anyhow::Result<usize> {
    let key = key(room_id);
    let mut redis = state.redis.clone();
    let now = now_secs();
    let _: () = redis.zadd(&key, member(session_id, conn_id), now).await?;
    online_sessions(&mut redis, &key, now).await
}

pub async fn refresh_presence(
    state: &AppState,
    room_id: &str,
    session_id: &str,
    conn_id: &str,
) -> anyhow::Result<usize> {
    set_presence(state, room_id, session_id, conn_id).await
}

pub async fn clear_presence(
    state: &AppState,
    room_id: &str,
    session_id: &str,
    conn_id: &str,
) -> anyhow::Result<usize> {
    let key = key(room_id);
    let mut redis = state.redis.clone();
    let _: () = redis.zrem(&key, member(session_id, conn_id)).await?;
    online_sessions(&mut redis, &key, now_secs()).await
}

async fn online_sessions(
    redis: &mut redis::aio::ConnectionManager,
    key: &str,
    now: i64,
) -> anyhow::Result<usize> {
    let _: () = redis.zrembyscore(key, "-inf", now - TTL_SECS).await?;
    let _: () = redis.expire(key, TTL_SECS).await?;
    let members: Vec<String> = redis.zrange(key, 0, -1).await?;
    let sessions: HashSet<&str> = members
        .iter()
        .map(|m| m.split('|').next().unwrap_or_default())
        .collect();
    Ok(sessions.len())
}
