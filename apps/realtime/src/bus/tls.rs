//! TLS for the RabbitMQ link: trust the internal CA and present the client
//! certificate, so the broker can refuse clients that have none (the Nest
//! services already present theirs).

use anyhow::{bail, Context, Result};
use lapin::tcp::{OwnedIdentity, OwnedTLSConfig};
use p12_keystore::{Certificate, KeyStore, KeyStoreEntry, PrivateKeyChain};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivatePkcs8KeyDer};
use std::path::Path;

/// Only protects the in-memory PKCS#12 bundle the TLS library asks for.
const BUNDLE_PASSWORD: &str = "anonyma-realtime";

/// TLS settings for `dir` (ca.pem, client.pem, client-key.pem). Without a
/// usable client certificate it still trusts the CA and logs why, so a broker
/// that does not demand one keeps working.
pub fn tls_config(dir: &Path) -> OwnedTLSConfig {
    let cert_chain = std::fs::read_to_string(dir.join("ca.pem")).ok();
    let identity = match client_identity(dir) {
        Ok(identity) => Some(identity),
        Err(err) => {
            tracing::error!(error = %err, "RabbitMQ client certificate not loaded");
            None
        }
    };
    OwnedTLSConfig {
        identity,
        cert_chain,
    }
}

fn client_identity(dir: &Path) -> Result<OwnedIdentity> {
    let cert_pem = std::fs::read(dir.join("client.pem")).context("read client.pem")?;
    let key_pem = std::fs::read(dir.join("client-key.pem")).context("read client-key.pem")?;
    Ok(OwnedIdentity {
        der: pkcs12_from_pem(&cert_pem, &key_pem)?,
        password: BUNDLE_PASSWORD.to_string(),
    })
}

/// The TLS library takes the client identity only as PKCS#12, and reads the
/// key inside it as PKCS#8.
pub fn pkcs12_from_pem(cert_pem: &[u8], key_pem: &[u8]) -> Result<Vec<u8>> {
    let mut chain = Vec::new();
    for cert in CertificateDer::pem_slice_iter(cert_pem) {
        let cert = cert.map_err(|e| anyhow::anyhow!("parse client.pem: {e:?}"))?;
        chain.push(Certificate::from_der(cert.as_ref()).context("client certificate")?);
    }
    if chain.is_empty() {
        bail!("client.pem holds no certificate");
    }
    let key = PrivatePkcs8KeyDer::from_pem_slice(key_pem)
        .map_err(|_| anyhow::anyhow!("client-key.pem must hold a PKCS#8 key (BEGIN PRIVATE KEY)"))?
        .secret_pkcs8_der()
        .to_vec();
    let mut store = KeyStore::new();
    store.add_entry(
        "client",
        KeyStoreEntry::PrivateKeyChain(PrivateKeyChain::new(key, b"anonyma-client", chain)),
    );
    store
        .writer(BUNDLE_PASSWORD)
        .write()
        .context("build PKCS#12 bundle")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against real files when ANONYMA_TEST_CERT_DIR names a folder with
    /// client.pem + client-key.pem (`openssl req -x509 -newkey rsa:2048 -nodes
    /// -keyout client-key.pem -out client.pem -subj /CN=t`); skipped otherwise.
    #[test]
    fn bundle_opens_the_way_the_tls_library_reads_it() {
        let Ok(dir) = std::env::var("ANONYMA_TEST_CERT_DIR") else {
            return;
        };
        let dir = Path::new(&dir);
        let der = pkcs12_from_pem(
            &std::fs::read(dir.join("client.pem")).unwrap(),
            &std::fs::read(dir.join("client-key.pem")).unwrap(),
        )
        .unwrap();
        // Same calls tcp-stream makes before handing the key to rustls.
        let store = KeyStore::from_pkcs12(&der, BUNDLE_PASSWORD).unwrap();
        let (_, chain) = store.private_key_chain().expect("a key chain");
        assert!(!chain.key().is_empty());
        assert_eq!(chain.chain().len(), 1);
    }

    #[test]
    fn rejects_files_without_a_certificate_or_key() {
        assert!(pkcs12_from_pem(b"", b"").is_err());
    }
}
