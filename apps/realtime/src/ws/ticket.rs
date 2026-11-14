use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
pub struct WsTicketClaims {
    #[serde(rename = "sessionHash")]
    pub session_hash: String,
    #[serde(rename = "roomId")]
    pub room_id: String,
    pub exp: u64,
    pub jti: String,
}

fn ticket_aes_key(secret: &str) -> [u8; 32] {
    let mut mac = HmacSha256::new_from_slice(b"anonyma-ws-ticket-v2").expect("hmac key");
    mac.update(secret.as_bytes());
    let out = mac.finalize().into_bytes();
    let mut key = [0u8; 32];
    key.copy_from_slice(&out);
    key
}

pub fn verify_ws_ticket(ticket: &str, secret: &str) -> Result<WsTicketClaims> {
    let (body, sig) = ticket
        .split_once('.')
        .ok_or_else(|| anyhow!("invalid ticket format"))?;

    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).map_err(|_| anyhow!("bad ticket secret"))?;
    mac.update(body.as_bytes());
    let expected = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());

    if !constant_time_eq(sig.as_bytes(), expected.as_bytes()) {
        bail!("invalid ticket signature");
    }

    let packed = URL_SAFE_NO_PAD
        .decode(body.as_bytes())
        .map_err(|_| anyhow!("invalid ticket body"))?;
    if packed.len() <= 12 {
        bail!("invalid ticket body length");
    }
    let iv = &packed[..12];
    let ciphertext = &packed[12..];
    let key = ticket_aes_key(secret);
    let json = decrypt_aes_gcm(ciphertext, iv, &key)?;
    let claims: WsTicketClaims = serde_json::from_slice(&json)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs();
    if claims.exp < now {
        bail!("ticket expired");
    }
    if claims.session_hash.is_empty() || claims.room_id.is_empty() || claims.jti.is_empty() {
        bail!("invalid ticket claims");
    }
    Ok(claims)
}

fn decrypt_aes_gcm(ciphertext_with_tag: &[u8], iv: &[u8], key: &[u8; 32]) -> Result<Vec<u8>> {
    use aes_gcm::{
        aead::{Aead, KeyInit},
        Aes256Gcm, Nonce,
    };
    if ciphertext_with_tag.len() <= 16 {
        bail!("invalid ciphertext");
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| anyhow!("bad aes key"))?;
    let nonce = Nonce::from_slice(iv);
    cipher
        .decrypt(nonce, ciphertext_with_tag)
        .map_err(|_| anyhow!("ticket decrypt failed"))
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}
