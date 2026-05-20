#!/usr/bin/env bash
# scripts/patch-electron-info-plist.sh
# Patch the dev Electron.app bundle with usage descriptions so macOS TCC lets
# our child processes touch the microphone / screen. Without them dev recorder
# gets SIGKILL'd on AVCaptureDevice.authorizationStatus (see #50).
#
# Also pins the bundle to a stable identifier + signs it with a stable
# self-signed certificate (if present). Without this every `npm run build`
# produces a fresh ad-hoc CDHash, which invalidates TCC grants — macOS keeps
# re-prompting for Microphone / Screen Recording on every dev run (see #84).
# Run `npm run setup:codesign-cert` once to provision the cert.
#
# Packaged builds already receive the same keys via electron-builder's
# `build.mac.extendInfo` (package.json). This script is a no-op on non-macOS
# and is idempotent on repeat runs.

set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  exit 0
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT_DIR/node_modules/electron/dist/Electron.app"
PLIST="$APP/Contents/Info.plist"
# Distinct from the packaged release identifier (`com.marshal.desktop`) so dev
# TCC grants live in their own slot and don't collide with an installed build.
DEV_BUNDLE_ID="com.marshal.desktop.dev"
DEV_BUNDLE_NAME="Marshal (Dev)"
CERT_NAME="Marshal Self-Signed"

if [[ ! -f "$PLIST" ]]; then
  # electron not installed yet — nothing to patch.
  exit 0
fi

declare -a desired=(
  "NSMicrophoneUsageDescription:Marshal needs microphone access to transcribe your voice dictation."
  "NSScreenCaptureUsageDescription:Marshal captures a selected screen region for OCR translation."
  "NSAppleEventsUsageDescription:Marshal uses Apple Events for auto-paste after dictation."
  "CFBundleIdentifier:$DEV_BUNDLE_ID"
  "CFBundleName:$DEV_BUNDLE_NAME"
  "CFBundleDisplayName:$DEV_BUNDLE_NAME"
)

patched=0
for entry in "${desired[@]}"; do
  key="${entry%%:*}"
  value="${entry#*:}"
  if /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" > /dev/null 2>&1; then
    current="$(/usr/libexec/PlistBuddy -c "Print :$key" "$PLIST")"
    if [[ "$current" != "$value" ]]; then
      /usr/libexec/PlistBuddy -c "Set :$key '$value'" "$PLIST"
      patched=1
    fi
  else
    /usr/libexec/PlistBuddy -c "Add :$key string '$value'" "$PLIST"
    patched=1
  fi
done

# Resolve a valid stable codesign identity. `security find-identity` lists
# both valid and "Invalid Key Usage for policy" entries — only the valid one
# can actually sign. Pick its SHA-1 hash so codesign targets it unambiguously
# (multiple certs with the same CN may otherwise resolve to the wrong one).
STABLE_IDENTITY=""
resolved="$(
  security find-identity -v -p codesigning 2>/dev/null \
    | grep "$CERT_NAME" \
    | grep -v "Invalid" \
    | head -1 \
    | awk '{print $2}' || true
)"
if [[ "$resolved" =~ ^[0-9A-F]{40}$ ]]; then
  STABLE_IDENTITY="$resolved"
fi

# Re-sign whenever we touched the bundle, OR when a stable cert is available
# (in case a previous run left an ad-hoc signature behind).
if (( patched == 1 )) || [[ -n "$STABLE_IDENTITY" ]]; then
  if [[ -n "$STABLE_IDENTITY" ]]; then
    if codesign --force --deep --sign "$STABLE_IDENTITY" "$APP" > /dev/null 2>&1; then
      echo "[patch-electron] Signed with stable identity ($CERT_NAME, $STABLE_IDENTITY)."
      echo "[patch-electron] Bundle ID: $DEV_BUNDLE_ID — TCC grants will now persist across rebuilds."
    else
      echo "[patch-electron] WARN: stable signing failed, falling back to ad-hoc." >&2
      codesign --force --deep --sign - "$APP" > /dev/null 2>&1 || true
    fi
  else
    codesign --force --deep --sign - "$APP" > /dev/null 2>&1 || true
    cat >&2 <<MSG
[patch-electron] Bundle re-signed ad-hoc — macOS will re-prompt for permissions
[patch-electron] on every rebuild. To make grants persist:
[patch-electron]   npm run setup:codesign-cert
[patch-electron] (one-time setup, see scripts/setup-codesign-cert.sh for the
[patch-electron]  two manual sudo steps it prints).
MSG
  fi
fi
