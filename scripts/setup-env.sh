#!/usr/bin/env bash
# scripts/setup-env.sh
#
# Copy the project's .env into the installed app's own config directory.
#
# Why: a packaged build resolves the project-root `.env` to a path INSIDE
# Marshal.app, which does not exist. `desktop/main.ts` therefore makes a
# second dotenv pass over `app.getPath("userData")/.env` — the only writable
# spot the installed app can rely on. Without that file the installed app has
# no MARSHAL_API_KEY, the translator falls back to a ~10 s CLI backend, and
# translate-as-you-type feels like lag. See #155.
#
# The file is copied, never printed: this script never echoes a value, only
# the names of the keys it found.
#
# Usage:
#   npm run setup:env            # copy, refuse if the target exists
#   npm run setup:env -- --force # overwrite an existing target
#
# Env:
#   MARSHAL_ENV_TARGET — target file (default: the path shown below)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE="$ROOT_DIR/.env"
DEFAULT_TARGET="$HOME/Library/Application Support/Marshal/.env"
TARGET="${MARSHAL_ENV_TARGET:-$DEFAULT_TARGET}"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    *) echo "[env] unknown argument: $arg" >&2; exit 1 ;;
  esac
done

if [[ ! -f "$SOURCE" ]]; then
  echo "[env] no .env at $SOURCE" >&2
  echo "[env] create it first:  cp .env.example .env" >&2
  exit 1
fi

if [[ -f "$TARGET" && $FORCE -eq 0 ]]; then
  echo "[env] $TARGET already exists — leaving it alone."
  echo "[env] overwrite it with:  npm run setup:env -- --force"
  exit 0
fi

mkdir -p "$(dirname "$TARGET")"
cp "$SOURCE" "$TARGET"
# Same reasoning as settings.json: this file holds credentials.
chmod 600 "$TARGET"

echo "[env] copied → $TARGET"

# Report which keys landed, by name only. Never the values. BSD grep has no
# -P, so strip the `=` with sed rather than a lookahead.
KEYS="$(sed -nE 's/^([A-Z_][A-Z0-9_]*)=.*/\1/p' "$TARGET" | tr '\n' ' ')"
if [[ -n "${KEYS// /}" ]]; then
  echo "[env] keys present: $KEYS"
fi

if grep -qE '^MARSHAL_API_KEY=.+' "$TARGET"; then
  echo "[env] MARSHAL_API_KEY is set — the translator will use the fast API backend."
else
  echo "[env] WARNING: MARSHAL_API_KEY is empty. The translator will fall back to the"
  echo "[env]          CLI backend (~10 s per translation). Add a Groq key to $SOURCE"
  echo "[env]          and re-run with --force."
fi

echo "[env] restart Marshal so it re-reads the file."
