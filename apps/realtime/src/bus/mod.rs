//! RabbitMQ: the event consumer, the bus envelope crypto and the TLS client identity.
mod consumer;
pub mod crypto;
pub mod tls;

pub use consumer::run_consumer;
