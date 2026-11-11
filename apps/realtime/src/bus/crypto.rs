use aes_gcm::{
    aead::{Aead, AeadCore, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, bail, Result};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Deserialize)]
pub struct BusEnvelope {
    pub c: String,
    pub iv: String,
}

pub fn parse_encryption_key(hex_or_b64: &str) -> Result<[u8; 32]> {
    let trimmed = hex_or_b64.trim();
    if trimmed.len() == 64 && trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        let bytes = hex::decode(trimmed)?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&bytes);
        return Ok(key);
    }
    let bytes = STANDARD.decode(trimmed)?;
    if bytes.len() != 32 {
        bail!("MESSAGE_ENCRYPTION_KEY must be 32 bytes");
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes);
    Ok(key)
}

/// Node layout: ciphertext || authTag(16)
pub fn decrypt_bus_payload(envelope: &BusEnvelope, key: &[u8; 32]) -> Result<serde_json::Value> {
    let ct_with_tag = STANDARD
        .decode(&envelope.c)
        .map_err(|_| anyhow!("bad ciphertext b64"))?;
    let iv = STANDARD
        .decode(&envelope.iv)
        .map_err(|_| anyhow!("bad iv b64"))?;
    if iv.len() != 12 {
        bail!("iv must be 12 bytes");
    }
    if ct_with_tag.len() <= 16 {
        bail!("ciphertext too short");
    }
    let nonce = Nonce::from_slice(&iv);
    // The bus subkey first; envelopes sealed before it existed used the key itself.
    for candidate in [bus_key(key), *key] {
        let cipher = Aes256Gcm::new_from_slice(&candidate).map_err(|_| anyhow!("bad key"))?;
        if let Ok(plaintext) = cipher.decrypt(nonce, ct_with_tag.as_ref()) {
            return Ok(serde_json::from_slice(&plaintext)?);
        }
    }
    Err(anyhow!("decrypt failed"))
}

/// The event bus's own key, derived from the configured one (Node's
/// `deriveSubkey(master, 'bus')` in packages/shared/src/crypto/crypto.ts).
pub fn bus_key(master: &[u8; 32]) -> [u8; 32] {
    let mut mac = <HmacSha256 as Mac>::new_from_slice(master).expect("hmac accepts any key length");
    mac.update(b"anonyma-key-v1:bus");
    mac.finalize().into_bytes().into()
}

/// Same layout as the Node side: base64 ciphertext || authTag(16), 12-byte IV.
pub fn encrypt_bus_payload(value: &serde_json::Value, key: &[u8; 32]) -> Result<serde_json::Value> {
    let cipher = Aes256Gcm::new_from_slice(&bus_key(key)).map_err(|_| anyhow!("bad key"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let ct_with_tag = cipher
        .encrypt(&nonce, serde_json::to_vec(value)?.as_ref())
        .map_err(|_| anyhow!("encrypt failed"))?;
    Ok(serde_json::json!({
        "c": STANDARD.encode(ct_with_tag),
        "iv": STANDARD.encode(nonce),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_payload_opens_with_the_same_key() {
        let key = [7u8; 32];
        let value = serde_json::json!({ "roomId": "r1", "sessionId": "s1", "typing": true });
        let sealed = encrypt_bus_payload(&value, &key).unwrap();
        let envelope: BusEnvelope = serde_json::from_value(sealed).unwrap();
        assert_eq!(decrypt_bus_payload(&envelope, &key).unwrap(), value);
        assert!(decrypt_bus_payload(&envelope, &[8u8; 32]).is_err());
    }

    #[test]
    fn bus_subkey_matches_node() {
        assert_eq!(
            hex::encode(bus_key(&[7u8; 32])),
            "9b3f7c521355689a0b5efe0405346af007af1aaeeb8a9ad2178599a9d4c7882c"
        );
    }

    #[test]
    fn envelopes_sealed_with_the_plain_key_still_open() {
        let key = [7u8; 32];
        let value = serde_json::json!({ "old": true });
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ct = cipher
            .encrypt(&nonce, serde_json::to_vec(&value).unwrap().as_ref())
            .unwrap();
        let envelope = BusEnvelope {
            c: STANDARD.encode(ct),
            iv: STANDARD.encode(nonce),
        };
        assert_eq!(decrypt_bus_payload(&envelope, &key).unwrap(), value);
    }
}
