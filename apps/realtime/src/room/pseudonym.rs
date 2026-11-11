//! A session's id inside one room, as other people see it: the same person gets
//! an unrelated id in every room. Must match `roomPseudonym` in
//! packages/shared/src/crypto/crypto.ts (same subkey label, input and length).

use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

pub fn room_pseudonym(master_key: &[u8; 32], room_id: &str, session_hash: &str) -> String {
    let mut sub = HmacSha256::new_from_slice(master_key).expect("hmac accepts any key length");
    sub.update(b"anonyma-pseudonym-v1");
    let subkey = sub.finalize().into_bytes();

    let prefix: String = session_hash
        .chars()
        .take(16)
        .collect::<String>()
        .to_lowercase();
    let mut mac = HmacSha256::new_from_slice(&subkey).expect("hmac accepts any key length");
    mac.update(format!("{room_id}:{prefix}").as_bytes());
    hex::encode(mac.finalize().into_bytes())[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::room_pseudonym;

    // The same values as apps/core/src/crypto/pseudonym.test.ts.
    #[test]
    fn matches_the_node_implementation() {
        let key = [7u8; 32];
        assert_eq!(
            room_pseudonym(&key, "room-1", "0123456789ABCDEF0123456789abcdef"),
            "4d172428cfcacae7"
        );
        assert_eq!(
            room_pseudonym(&key, "room-2", "0123456789abcdef"),
            "e24e4c3dcc850d2d"
        );
    }
}
