#!/usr/bin/env bash
# Regenerates cert fixtures used by probe/channel-setup tests.
# Run once from repo root: bash tests/__fixtures__/gen-fixtures.sh
# Fixtures are committed to the repo; regenerate only if shapes change.
set -euo pipefail
cd "$(dirname "$0")"

# ca-valid: self-signed, 100-year validity, CN=localhost, O="Acme, Inc."
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca-valid.key -out ca-valid.pem -days 36500 \
  -subj '/CN=localhost/O=Acme, Inc.' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'

# ca-other: a DIFFERENT self-signed cert for 'wrong CA' tests
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout ca-other.key -out ca-other.pem -days 36500 \
  -subj '/CN=localhost/O=OtherCorp' \
  -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'

# ca-expired: validity period ends yesterday (faked via -not_before and -not_after)
# OpenSSL 3.x `req -x509` uses -not_before/-not_after from OpenSSL 3.2+
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /tmp/ca-expired.key -out ca-expired.pem \
  -not_before "20200101000000Z" -not_after "20200102000000Z" \
  -subj '/CN=expired.example/O=ExpiredCorp'
rm -f /tmp/ca-expired.key

# chain-bundle: ca-valid + ca-other concatenated (emulates leaf+intermediate style)
cat ca-valid.pem ca-other.pem > chain-bundle.pem

echo "Fixtures regenerated:"
ls -la *.pem *.key
