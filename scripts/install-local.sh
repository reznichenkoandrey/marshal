#!/usr/bin/env bash
# scripts/install-local.sh
#
# Install a locally built Marshal into /Applications without the Gatekeeper
# dialog.
#
# Why this exists: our builds are signed with the self-signed
# `Marshal Self-Signed` identity and are not notarized, so macOS attaches
# `com.apple.quarantine` to the downloaded/built DMG and refuses the first
# launch with "Apple could not verify…". The usual right-click → Open clears
# that attribute by hand, once per download. Notarization would remove it for
# everyone, but it needs a Developer ID certificate, i.e. a paid Apple
# Developer Program membership. For the owner's own machines, dropping the
# attribute is the same outcome for free. See #153.
#
# Usage:
#   npm run install:local                 # newest release/Marshal-*.dmg
#   npm run install:local -- path/to.dmg  # a specific image
#
# Env:
#   MARSHAL_APP_DIR  — install target (default: /Applications)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${MARSHAL_APP_DIR:-/Applications}"
APP_NAME="Marshal.app"
INSTALLED="$APP_DIR/$APP_NAME"
MOUNT_POINT=""

cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
  fi
}
trap cleanup EXIT

# ── Pick the image ──
if [[ $# -ge 1 && -n "${1:-}" ]]; then
  DMG="$1"
else
  # Newest by mtime so a rebuild always wins over an older release left in the
  # same folder.
  DMG="$(find "$ROOT_DIR/release" -maxdepth 1 -name 'Marshal-*.dmg' -print0 2>/dev/null \
    | xargs -0 ls -t 2>/dev/null | head -1 || true)"
fi

if [[ -z "${DMG:-}" || ! -f "$DMG" ]]; then
  echo "[install] no DMG found. Build one first:" >&2
  echo "  npm run desktop:dist" >&2
  exit 1
fi

echo "[install] image:  $DMG"
echo "[install] target: $INSTALLED"

# ── Quit a running instance ──
# Replacing the bundle under a running app leaves it in a half-swapped state,
# so stop it first. `quit` is graceful — the app runs its teardown.
if pgrep -x "Marshal" > /dev/null 2>&1; then
  echo "[install] quitting the running Marshal…"
  osascript -e 'quit app "Marshal"' 2>/dev/null || true
  for _ in $(seq 1 25); do
    pgrep -x "Marshal" > /dev/null 2>&1 || break
    sleep 0.2
  done
  if pgrep -x "Marshal" > /dev/null 2>&1; then
    echo "[install] Marshal is still running — quit it from the menu bar and re-run." >&2
    exit 1
  fi
fi

# ── Mount, copy, unmount ──
MOUNT_POINT="$(mktemp -d "${TMPDIR:-/tmp}/marshal-dmg.XXXXXX")"
echo "[install] mounting…"
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MOUNT_POINT"

if [[ ! -d "$MOUNT_POINT/$APP_NAME" ]]; then
  echo "[install] $APP_NAME not found inside the image" >&2
  exit 1
fi

if [[ -e "$INSTALLED" ]]; then
  echo "[install] removing the previous install…"
  rm -rf "$INSTALLED"
fi

echo "[install] copying…"
# ditto preserves the signature's extended attributes; cp -R does not.
ditto "$MOUNT_POINT/$APP_NAME" "$INSTALLED"

hdiutil detach "$MOUNT_POINT" -quiet
rmdir "$MOUNT_POINT" 2>/dev/null || true
MOUNT_POINT=""

# ── Drop the quarantine flag ──
# This is the whole point: without it macOS blocks the first launch of any
# app that is not notarized.
xattr -dr com.apple.quarantine "$INSTALLED" 2>/dev/null || true

# ── Verify, rather than assume ──
if xattr -p com.apple.quarantine "$INSTALLED" > /dev/null 2>&1; then
  echo "[install] WARNING — com.apple.quarantine is still set; the first launch will prompt." >&2
else
  echo "[install] quarantine cleared"
fi

if codesign --verify --deep --strict "$INSTALLED" > /dev/null 2>&1; then
  echo "[install] signature valid"
else
  echo "[install] WARNING — codesign --verify failed; the app may not launch." >&2
fi

VERSION="$(defaults read "$INSTALLED/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo "?")"
echo "[install] Marshal $VERSION installed. Launch it normally — no right-click needed."
