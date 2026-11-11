use metrics::{counter, describe_counter, describe_gauge, gauge};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};
use once_cell::sync::OnceCell;
use std::sync::atomic::{AtomicU64, Ordering};

static HANDLE: OnceCell<PrometheusHandle> = OnceCell::new();
static WS_CONNECTIONS: AtomicU64 = AtomicU64::new(0);

pub fn init() -> PrometheusHandle {
    HANDLE
        .get_or_init(|| {
            describe_gauge!(
                "ws_connections",
                "Active authenticated WebSocket connections"
            );
            describe_counter!("ws_messages_total", "WebSocket client messages by kind");
            describe_counter!("ws_auth_failures_total", "WebSocket auth / ticket failures");
            describe_counter!(
                "ws_tickets_consumed_total",
                "Successfully consumed one-time WS tickets"
            );

            let handle = PrometheusBuilder::new()
                .install_recorder()
                .expect("prometheus recorder");
            gauge!("ws_connections").set(0.0);
            handle
        })
        .clone()
}

pub fn render() -> String {
    HANDLE
        .get()
        .map(|h| h.render())
        .unwrap_or_else(|| String::new())
}

pub fn connection_opened() {
    let n = WS_CONNECTIONS.fetch_add(1, Ordering::Relaxed) + 1;
    gauge!("ws_connections").set(n as f64);
}

pub fn connection_closed() {
    let n = WS_CONNECTIONS
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |v| {
            Some(v.saturating_sub(1))
        })
        .unwrap_or(0);
    let after = n.saturating_sub(1);
    gauge!("ws_connections").set(after as f64);
}

pub fn auth_failure() {
    counter!("ws_auth_failures_total").increment(1);
}

pub fn ticket_consumed() {
    counter!("ws_tickets_consumed_total").increment(1);
}

pub fn message(kind: &'static str) {
    counter!("ws_messages_total", "kind" => kind).increment(1);
}
