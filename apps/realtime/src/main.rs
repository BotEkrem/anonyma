mod bus;
mod metrics;
mod room;
mod state;
mod ws;

use axum::{http::header, routing::get, Router};
use std::{
    env,
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tracing_subscriber::EnvFilter;

use crate::{bus::crypto::parse_encryption_key, state::AppState};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse()?))
        .init();

    // One process-wide TLS provider, chosen here rather than guessed by rustls
    // from crate features (two providers in the build made the RabbitMQ
    // consumer panic at startup and realtime relayed nothing).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let redis_url = env::var("REDIS_URL").unwrap_or_else(|_| "redis://localhost:6379".into());
    let mut rmq_url =
        env::var("RABBITMQ_URL").unwrap_or_else(|_| "amqp://anonyma:anonyma@localhost:5672".into());
    // When TLS certs are mounted, use amqps and present the client certificate.
    let rmq_tls_dir = env::var("RABBITMQ_TLS_DIR")
        .ok()
        .map(std::path::PathBuf::from);
    if rmq_tls_dir.is_some() {
        if rmq_url.starts_with("amqp://") {
            rmq_url = format!("amqps://{}", &rmq_url["amqp://".len()..]);
        }
        rmq_url = rmq_url.replace(":5672", ":5671");
    }
    let exchange = env::var("RABBITMQ_EXCHANGE").unwrap_or_else(|_| "anonyma.events".into());
    let port: u16 = env::var("REALTIME_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(3003);
    let message_key = parse_encryption_key(
        &env::var("MESSAGE_ENCRYPTION_KEY").expect("MESSAGE_ENCRYPTION_KEY is required"),
    )?;
    let web_origin =
        env::var("PUBLIC_WEB_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".into());

    let state = Arc::new(AppState::new(&redis_url, exchange.clone(), message_key).await?);
    let _metrics = metrics::init();

    let bus_state = state.clone();
    let exchange_clone = exchange.clone();
    // Keep the consumer alive: it ends when RabbitMQ restarts or the link
    // drops, and each attempt runs in its own task so a panic is seen here too.
    tokio::spawn(async move {
        let mut delay = Duration::from_secs(1);
        let mut reconnect = false;
        loop {
            let started = Instant::now();
            let attempt = tokio::spawn(bus::run_consumer(
                bus_state.clone(),
                rmq_url.clone(),
                exchange_clone.clone(),
                message_key,
                reconnect,
                rmq_tls_dir.clone(),
            ))
            .await;
            bus_state.set_publisher(None);
            match attempt {
                Ok(Ok(())) => tracing::warn!("RMQ consumer stopped; reconnecting"),
                Ok(Err(err)) => tracing::error!(error = %err, "RMQ consumer failed; reconnecting"),
                Err(err) => tracing::error!(error = %err, "RMQ consumer panicked; reconnecting"),
            }
            reconnect = true;
            if started.elapsed() > Duration::from_secs(60) {
                delay = Duration::from_secs(1);
            }
            tokio::time::sleep(delay).await;
            delay = (delay * 2).min(Duration::from_secs(30));
        }
    });

    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::exact(web_origin.parse()?))
        .allow_methods([axum::http::Method::GET])
        .allow_headers(tower_http::cors::Any);

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .route("/readyz", get(|| async { "ready" }))
        .route(
            "/metrics",
            get(|| async {
                (
                    [(
                        header::CONTENT_TYPE,
                        "text/plain; version=0.0.4; charset=utf-8",
                    )],
                    metrics::render(),
                )
            }),
        )
        .route("/ws", get(ws::ws_handler))
        .layer(cors)
        .with_state(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(%addr, "realtime listening");
    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}
