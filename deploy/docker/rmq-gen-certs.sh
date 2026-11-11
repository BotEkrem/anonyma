#!/bin/sh
# Generate an internal CA + server/client certs for RabbitMQ mTLS (shared volume).
set -eu
DIR="${1:-/certs}"
OPENSSL=openssl
[ -x /opt/openssl/bin/openssl ] && OPENSSL=/opt/openssl/bin/openssl
mkdir -p "$DIR"
cd "$DIR"

if [ -f ca.pem ] && [ -f server.pem ] && [ -f client.pem ] && [ -f client-key.pem ] && [ -f server-key.pem ]; then
  echo "rmq certs already present in $DIR"
  exit 0
fi

echo "generating RabbitMQ TLS materials in $DIR"
"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=anonyma-rmq-ca" \
  -keyout ca-key.pem -out ca.pem

"$OPENSSL" req -newkey rsa:2048 -nodes \
  -subj "/CN=rabbitmq" \
  -keyout server-key.pem -out server.csr
"$OPENSSL" x509 -req -in server.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out server.pem -days 3650 \
  -extfile /dev/stdin <<EOF
subjectAltName=DNS:rabbitmq,DNS:localhost,IP:127.0.0.1
extendedKeyUsage=serverAuth
EOF

"$OPENSSL" req -newkey rsa:2048 -nodes \
  -subj "/CN=anonyma-client" \
  -keyout client-key.pem -out client.csr
"$OPENSSL" x509 -req -in client.csr -CA ca.pem -CAkey ca-key.pem -CAcreateserial \
  -out client.pem -days 3650 \
  -extfile /dev/stdin <<EOF
extendedKeyUsage=clientAuth
EOF

rm -f server.csr client.csr ca.srl
# Shared internal volume — readable by rabbitmq + app containers.
chmod 644 ca.pem server.pem client.pem server-key.pem client-key.pem
# Nothing needs the CA key once both certificates exist (rotating means
# generating a new set), and this directory is shared with other containers.
rm -f ca-key.pem
echo "rmq certs ready"
