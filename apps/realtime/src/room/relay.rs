//! Typing and presence go out through RabbitMQ like chat events, so every
//! realtime pod hands them to its own sockets. Broadcasting them on the pod
//! that saw them reached only the peers connected to that same pod (two
//! replicas, no session affinity). When the bus is down they fall back to this
//! pod's sockets.

use lapin::{options::BasicPublishOptions, BasicProperties};
use serde_json::{json, Value};
use std::time::Duration;

use crate::bus::crypto::encrypt_bus_payload;
use crate::room::pseudonym::room_pseudonym;
use crate::state::AppState;

pub const TYPING_KEY: &str = "chat.typing";
pub const PRESENCE_KEY: &str = "presence.updated";

/// The frame sockets get for a typing event: the typist appears as their
/// per-room pseudonym, never the session hash (which stays inside the bus).
pub fn typing_frame(state: &AppState, payload: &Value) -> String {
    let room_id = payload
        .get("roomId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let session = payload
        .get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let typing = payload
        .get("typing")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    json!({
        "type": "typing",
        "payload": {
            "roomId": room_id,
            "sessionId": room_pseudonym(&state.message_key, room_id, session),
            "typing": typing,
        }
    })
    .to_string()
}

/// The frame sockets get for a presence event.
pub fn presence_frame(payload: &Value) -> String {
    json!({ "type": "presence", "payload": payload }).to_string()
}

/// A stalled bus (flow control, half-dead link) must not hold up the socket
/// loop or its cleanup on close: past this, deliver on this pod instead.
const PUBLISH_TIMEOUT: Duration = Duration::from_millis(500);

async fn publish(state: &AppState, routing_key: &str, body: String) -> bool {
    let Some(channel) = state.publisher() else {
        return false;
    };
    let sent = tokio::time::timeout(
        PUBLISH_TIMEOUT,
        channel.basic_publish(
            &state.exchange,
            routing_key,
            BasicPublishOptions::default(),
            body.as_bytes(),
            BasicProperties::default().with_content_type("application/json".into()),
        ),
    )
    .await;
    match sent {
        Ok(Ok(_)) => true,
        Ok(Err(err)) => {
            tracing::warn!(error = %err, routing_key, "bus publish failed; delivering on this pod only");
            false
        }
        Err(_) => {
            tracing::warn!(
                routing_key,
                "bus publish timed out; delivering on this pod only"
            );
            false
        }
    }
}

/// Typing carries the session hash, so it is sealed like the other chat events.
pub async fn typing(state: &AppState, room_id: &str, session_id: &str, typing: bool) {
    let payload = json!({ "roomId": room_id, "sessionId": session_id, "typing": typing });
    let sent = match encrypt_bus_payload(&payload, &state.message_key) {
        Ok(envelope) => {
            let body = json!({ "roomId": room_id, "envelope": envelope }).to_string();
            publish(state, TYPING_KEY, body).await
        }
        Err(err) => {
            tracing::warn!(error = %err, "typing event not sealed");
            false
        }
    };
    if !sent {
        state.broadcast_room_except(room_id, session_id, &typing_frame(state, &payload));
    }
}

/// The online count comes from Redis, shared by the pods; only counts travel.
pub async fn presence(state: &AppState, room_id: &str, online: usize) {
    let payload = json!({ "roomId": room_id, "onlineCount": online });
    if !publish(state, PRESENCE_KEY, payload.to_string()).await {
        state.broadcast_room(room_id, &presence_frame(&payload));
    }
}
