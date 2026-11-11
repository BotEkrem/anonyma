use futures_util::StreamExt;
use lapin::{
    options::{
        BasicAckOptions, BasicConsumeOptions, ExchangeDeclareOptions, QueueBindOptions,
        QueueDeclareOptions,
    },
    types::FieldTable,
    Connection, ConnectionProperties, ExchangeKind,
};
use serde::Deserialize;
use serde_json::Value;
use std::sync::Arc;

use crate::bus::crypto::{decrypt_bus_payload, BusEnvelope};
use crate::room::relay;
use crate::state::AppState;

#[derive(Debug, Deserialize)]
struct EncryptedMessageEvent {
    #[serde(rename = "roomId")]
    room_id: String,
    envelope: BusEnvelope,
}

fn sanitize_lifecycle(mut v: Value) -> Value {
    if let Some(obj) = v.as_object_mut() {
        obj.remove("inviteCode");
        // Only for this server (who to cut off on leave); never sent to clients.
        obj.remove("sessionHash");
    }
    v
}

pub async fn run_consumer(
    state: Arc<AppState>,
    rmq_url: String,
    exchange: String,
    message_key: [u8; 32],
    reconnect: bool,
    tls_dir: Option<std::path::PathBuf>,
) -> anyhow::Result<()> {
    let exchange = exchange.as_str();
    let conn = match &tls_dir {
        // Read on every attempt, so renewed certificates are picked up.
        Some(dir) => {
            Connection::connect_with_config(
                &rmq_url,
                ConnectionProperties::default(),
                crate::bus::tls::tls_config(dir),
            )
            .await?
        }
        None => Connection::connect(&rmq_url, ConnectionProperties::default()).await?,
    };
    let channel = conn.create_channel().await?;

    channel
        .exchange_declare(
            exchange,
            ExchangeKind::Topic,
            ExchangeDeclareOptions {
                durable: true,
                ..Default::default()
            },
            FieldTable::default(),
        )
        .await?;

    let queue = channel
        .queue_declare(
            "",
            QueueDeclareOptions {
                exclusive: true,
                auto_delete: true,
                ..Default::default()
            },
            FieldTable::default(),
        )
        .await?;

    for key in [
        "chat.message.created",
        "chat.message.updated",
        "chat.message.deleted",
        "chat.reaction.updated",
        "chat.read.updated",
        "presence.updated",
        relay::TYPING_KEY,
        "match.paired",
        "room.joined",
        "room.left",
    ] {
        channel
            .queue_bind(
                queue.name().as_str(),
                exchange,
                key,
                QueueBindOptions::default(),
                FieldTable::default(),
            )
            .await?;
    }

    let mut consumer = channel
        .basic_consume(
            queue.name().as_str(),
            "anonyma-realtime",
            BasicConsumeOptions::default(),
            FieldTable::default(),
        )
        .await?;

    // Typing and presence go out on their own channel of this connection; the
    // supervisor clears it when this attempt ends.
    state.set_publisher(Some(conn.create_channel().await?));
    tracing::info!("RMQ consumer ready");
    if reconnect {
        // Events published while the consumer was down never reached anyone:
        // have every open client fetch its history again.
        state.broadcast_all(
            &serde_json::json!({ "type": "resync", "payload": { "reason": "bus" } }).to_string(),
        );
    }

    while let Some(delivery) = consumer.next().await {
        let delivery = delivery?;
        let routing_key = delivery.routing_key.to_string();
        let payload = String::from_utf8_lossy(&delivery.data).to_string();

        match routing_key.as_str() {
            "chat.message.created" | "chat.message.updated" | "chat.message.deleted" => {
                if let Ok(env) = serde_json::from_str::<EncryptedMessageEvent>(&payload) {
                    match decrypt_bus_payload(&env.envelope, &message_key) {
                        Ok(message) => {
                            let event_type = match routing_key.as_str() {
                                "chat.message.updated" => "message_updated",
                                "chat.message.deleted" => "message_deleted",
                                _ => "message",
                            };
                            state.broadcast_room(
                                &env.room_id,
                                &serde_json::json!({
                                    "type": event_type,
                                    "payload": message
                                })
                                .to_string(),
                            );
                        }
                        Err(err) => tracing::warn!(error = %err, "failed to decrypt bus message"),
                    }
                }
            }
            "chat.reaction.updated" | "chat.read.updated" => {
                if let Ok(env) = serde_json::from_str::<EncryptedMessageEvent>(&payload) {
                    match decrypt_bus_payload(&env.envelope, &message_key) {
                        Ok(v) => {
                            let event_type = if routing_key == "chat.reaction.updated" {
                                "reaction"
                            } else {
                                "read"
                            };
                            state.broadcast_room(
                                &env.room_id,
                                &serde_json::json!({ "type": event_type, "payload": v })
                                    .to_string(),
                            );
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "failed to decrypt bus meta event")
                        }
                    }
                }
            }
            "presence.updated" => {
                if let Ok(v) = serde_json::from_str::<Value>(&payload) {
                    if let Some(room_id) = v.get("roomId").and_then(|x| x.as_str()) {
                        state.broadcast_room(room_id, &relay::presence_frame(&v));
                    }
                }
            }
            relay::TYPING_KEY => {
                if let Ok(env) = serde_json::from_str::<EncryptedMessageEvent>(&payload) {
                    match decrypt_bus_payload(&env.envelope, &message_key) {
                        Ok(v) => {
                            let from = v
                                .get("sessionId")
                                .and_then(|x| x.as_str())
                                .unwrap_or_default()
                                .to_string();
                            state.broadcast_room_except(
                                &env.room_id,
                                &from,
                                &relay::typing_frame(&state, &v),
                            );
                        }
                        Err(err) => tracing::warn!(error = %err, "failed to decrypt typing event"),
                    }
                }
            }
            "match.paired" | "room.joined" | "room.left" => {
                // Every publisher seals these (core and match); anything else is dropped.
                if let Ok(env) = serde_json::from_str::<EncryptedMessageEvent>(&payload) {
                    match decrypt_bus_payload(&env.envelope, &message_key) {
                        Ok(v) => {
                            // A member left (or their session ended): cut their live
                            // feed on this pod. Leaving used to stop nothing.
                            if routing_key == "room.left" {
                                if let Some(hash) = v.get("sessionHash").and_then(|h| h.as_str()) {
                                    state.evict_from_room(&env.room_id, hash);
                                }
                            }
                            let sanitized = sanitize_lifecycle(v);
                            state.broadcast_room(
                                &env.room_id,
                                &serde_json::json!({
                                    "type": routing_key,
                                    "payload": sanitized
                                })
                                .to_string(),
                            );
                        }
                        Err(err) => {
                            tracing::warn!(error = %err, "failed to decrypt lifecycle bus event")
                        }
                    }
                }
            }
            _ => {}
        }

        delivery.ack(BasicAckOptions::default()).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::sanitize_lifecycle;
    use serde_json::json;

    #[test]
    fn lifecycle_frames_never_carry_the_session_hash_or_invite() {
        let out = sanitize_lifecycle(json!({
            "roomId": "r1",
            "sessionId": "s1",
            "sessionHash": "secret-hash",
            "inviteCode": "ABCD",
            "memberCount": 1
        }));
        assert!(out.get("sessionHash").is_none());
        assert!(out.get("inviteCode").is_none());
        assert_eq!(out["memberCount"], 1);
    }
}
