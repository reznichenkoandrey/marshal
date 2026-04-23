#!/usr/bin/env bash
# scripts/patch-electron-info-plist.sh
# Patch the dev Electron.app bundle with usage descriptions so macOS TCC lets
# our child processes touch the microphone / screen. Without them dev recorder
# gets SIGKILL'd on AVCaptureDevice.authorizationStatus (see #50).
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

if [[ ! -f "$PLIST" ]]; then
  # electron not installed yet — nothing to patch.
  exit 0
fi

declare -a desired=(
  "NSMicrophoneUsageDescription:Marshal needs microphone access to transcribe your voice dictation."
  "NSScreenCaptureUsageDescription:Marshal captures a selected screen region for OCR translation."
  "NSAppleEventsUsageDescription:Marshal uses Apple Events for auto-paste after dictation."
)

patched=0
for entry in "${desired[@]}"; do
  key="${entry%%:*}"
  value="${entry#*:}"
  if /usr/libexec/PlistBuddy -c "Print :$key" "$PLIST" > /dev/null 2>&1; then
    # Already present — make sure the value is current.
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

if (( patched == 1 )); then
  # Ad-hoc re-sign so macOS still accepts the modified bundle. Without this
  # the system may refuse to launch it or ignore the plist changes because the
  # original signature is now invalid.
  codesign --force --deep --sign - "$APP" > /dev/null 2>&1 || true
  echo "[patch-electron] Info.plist updated + ad-hoc re-signed."
  echo "[patch-electron] First run will show a system Microphone prompt — click Allow."
fi
