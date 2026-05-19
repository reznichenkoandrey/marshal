#!/usr/bin/env bash
# scripts/setup-codesign-cert.sh
#
# Creates a stable self-signed code-signing certificate and imports it into the
# login keychain. electron-builder then signs every release with the same
# identity, so macOS TCC sees the same Designated Requirement across versions
# and KEEPS the user's Microphone / Accessibility / Screen Recording
# permissions through updates.
#
# WHY THIS EXISTS:
# Without an Apple Developer ID, electron-builder falls back to ad-hoc signing.
# Ad-hoc DR is `cdhash H"<…>"` — the binary's own hash — which changes on
# every release, so TCC re-prompts on every install. With a stable cert the
# DR becomes `anchor leaf = H"<cert>" and identifier "com.marshal.desktop"`
# and stays the same release-to-release.
#
# Run once on the BUILD machine. Idempotent — re-running with the cert already
# present is a no-op aside from a notice.

set -euo pipefail

CERT_DIR="$(cd "$(dirname "$0")/.." && pwd)/.codesign"
CERT_NAME="Marshal Self-Signed"
KEY_FILE="$CERT_DIR/marshal-codesign.key"
CSR_FILE="$CERT_DIR/marshal-codesign.csr"
CRT_FILE="$CERT_DIR/marshal-codesign.crt"
P12_FILE="$CERT_DIR/marshal-codesign.p12"
P12_PASS="marshal"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"

mkdir -p "$CERT_DIR"

# Clean slate: drop every copy of the prior cert from the login keychain.
# Stale entries left over from earlier runs hide the regenerated one and
# `security find-identity` keeps reporting "Invalid Key Usage for policy".
# (Trust entries in System.keychain need sudo to remove — see post-run hint.)
while security find-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1; do
  security delete-certificate -c "$CERT_NAME" "$KEYCHAIN" >/dev/null 2>&1 || break
done

echo "[setup-codesign-cert] Generating 2048-bit RSA key…"
openssl genrsa -out "$KEY_FILE" 2048 2>/dev/null

echo "[setup-codesign-cert] Creating certificate signing request…"
openssl req -new -key "$KEY_FILE" -out "$CSR_FILE" \
  -subj "/CN=$CERT_NAME/O=Marshal/C=UA" 2>/dev/null

echo "[setup-codesign-cert] Self-signing certificate (valid 10 years)…"
# macOS Code Signing policy requires extendedKeyUsage be CRITICAL — without
# the `critical` flag, `security find-identity -p codesigning` lists the
# cert but reports "Invalid Key Usage for policy" and codesign refuses to
# use it. keyUsage=digitalSignature is also required.
openssl x509 -req -days 3650 -in "$CSR_FILE" -signkey "$KEY_FILE" \
  -extfile <(printf "extendedKeyUsage = critical, codeSigning\nkeyUsage = critical, digitalSignature\nbasicConstraints = critical, CA:FALSE\n") \
  -out "$CRT_FILE" 2>/dev/null

echo "[setup-codesign-cert] Packaging into PKCS#12…"
# `-legacy` is required: modern openssl 3.x defaults to AES-256-CBC for the
# PKCS#12 keybag, which macOS `security` cannot decrypt and aborts with
# "MAC verification failed". Legacy mode falls back to PBE-SHA1-3DES which
# Apple's Security framework reads natively.
openssl pkcs12 -export -inkey "$KEY_FILE" -in "$CRT_FILE" \
  -out "$P12_FILE" -passout "pass:$P12_PASS" -name "$CERT_NAME" \
  -legacy 2>/dev/null

echo "[setup-codesign-cert] Importing into login keychain…"
# -T grants the listed tools partition access to the private key without
# triggering an interactive prompt during codesign runs.
security import "$P12_FILE" \
  -k "$KEYCHAIN" \
  -P "$P12_PASS" \
  -T /usr/bin/codesign \
  -T /usr/bin/security \
  -T /usr/bin/productsign

# Avoids the interactive "always allow" pop-up during electron-builder runs.
security set-key-partition-list -S "apple-tool:,apple:,codesign:" \
  -s -k "" "$KEYCHAIN" >/dev/null 2>&1 || true

cat <<MSG

[setup-codesign-cert] Cert imported into login keychain. Two manual steps left
(both require a real terminal — sudo can't read its password from this script):

  1. Remove any earlier trust entry (no-op if this is your first run):

     sudo security remove-trusted-cert -d "$CRT_FILE"

  2. Trust the new cert for code signing:

     sudo security add-trusted-cert -d -r trustRoot -p codeSign \\
       -k /Library/Keychains/System.keychain "$CRT_FILE"

  Confirm it took:

     security find-identity -v -p codesigning | grep "$CERT_NAME"

  You should see exactly one line with no "Invalid Key Usage" suffix.
MSG
