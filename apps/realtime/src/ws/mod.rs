//! The browser WebSocket: ticket check, room feed, typing and presence.
mod handler;
mod ticket;

pub use handler::ws_handler;
