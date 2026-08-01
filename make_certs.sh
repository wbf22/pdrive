#!/usr/bin/env bash
# Generate a local Certificate Authority + server certificate so PDrive can be
# served over HTTPS on your LAN and installed as a PWA.
#
# Service workers / PWA install require a secure context. Serving over plain
# HTTP on a LAN IP is not secure, so browsers only offer "Add to Home Screen"
# (a bookmark) and never register the service worker (no offline mode).
#
# This script creates:
#   certs/pdrive-ca.crt             — root CA (install this on each phone once)
#   certs/pdrive.key                — server private key
#   certs/pdrive.crt                — server certificate (signed by the CA)
#
# The CA is created once and reused, so phones only need to trust it a single
# time even after the server certificate is regenerated (e.g. when your LAN IP
# changes). Re-run this script any time your IP changes to mint a new cert.
#
# Usage:
#   ./make_certs.sh                      # uses your current LAN IP
#   PDRIVE_IP=192.168.1.50 ./make_certs.sh
set -euo pipefail

CERTS_DIR="${PDRIVE_CERTS_DIR:-$(cd "$(dirname "$0")" && pwd)/certs}"
mkdir -p "$CERTS_DIR"

CA_KEY="$CERTS_DIR/pdrive-ca.key"
CA_CRT="$CERTS_DIR/pdrive-ca.crt"
SERVER_KEY="$CERTS_DIR/pdrive.key"
SERVER_CSR="$CERTS_DIR/pdrive.csr"
SERVER_CRT="$CERTS_DIR/pdrive.crt"
DAYS=3650

LAN_IP="${PDRIVE_IP:-}"
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.*src \([0-9.]*\).*/\1/p')
fi
if [ -z "$LAN_IP" ]; then
  LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
LAN_IP="${LAN_IP:-127.0.0.1}"

HOST="$(hostname -s)"
HOSTNAMES=(localhost pdrive.local "$HOST" "$HOST.local")

echo "Creating certificates for IP $LAN_IP ..."

# Root CA — created once and reused so each phone trusts it only one time.
if [ ! -f "$CA_KEY" ] || [ ! -f "$CA_CRT" ]; then
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days "$DAYS" \
    -keyout "$CA_KEY" -out "$CA_CRT" \
    -subj "/O=PDrive Local/CN=PDrive Local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" 2>/dev/null
  echo "Created CA: $CA_CRT"
else
  echo "Reusing existing CA: $CA_CRT"
fi

# Server key + CSR
openssl req -newkey rsa:3072 -nodes -sha256 \
  -keyout "$SERVER_KEY" -out "$SERVER_CSR" \
  -subj "/O=PDrive Local/CN=$LAN_IP" 2>/dev/null

# SANs must match every hostname/IP you'll use to reach the server
SAN="IP:$LAN_IP,IP:127.0.0.1"
for h in "${HOSTNAMES[@]}"; do
  SAN="$SAN,DNS:$h"
done

# Sign the server certificate
openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CRT" -CAkey "$CA_KEY" -CAcreateserial \
  -out "$SERVER_CRT" -days "$DAYS" -sha256 \
  -extfile <(printf "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=%s\n" "$SAN") 2>/dev/null

rm -f "$SERVER_CSR"

echo
echo "Certificates written to $CERTS_DIR:"
echo "  CA  : $CA_CRT    (install this on each phone, once)"
echo "  Key : $SERVER_KEY"
echo "  Crt : $SERVER_CRT"
echo
echo "SANs: $SAN"
echo
echo "Start PDrive over HTTPS with:"
echo "  python3 server.py --cert $SERVER_CRT --key $SERVER_KEY \\"
echo "      --ca-cert $CA_CRT"
