#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

if [ -f ".env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "./.env"
  set +a
fi

CHROME_BIN=${CHATGPT_BROWSER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
CHROME_APP=${CHATGPT_BROWSER_APP_PATH:-/Applications/Google Chrome.app}
CHROME_USER_DATA_DIR=${CHATGPT_DEFAULT_CHROME_PROFILE_DIR:-"$HOME/Library/Application Support/Google/Chrome"}
PROFILE_NAME=${CHATGPT_CHROME_PROFILE_NAME:-Andrii}
PROFILE_DIR=${CHATGPT_CHROME_PROFILE_DIR:-}
EXTENSION_DIR=${CHATGPT_EXTENSION_DIR:-"$SCRIPT_DIR/dist/chrome-extension"}
PORT=${CHATGPT_REMOTE_DEBUGGING_PORT:-9222}
CHATGPT_URL=${CHATGPT_URL:-https://chatgpt.com}
AUTO_QUIT_CHROME=${CHATGPT_AUTO_QUIT_CHROME:-0}
DRY_RUN=${CHATGPT_BROWSER_DRY_RUN:-0}

find_managed_chrome_pids() {
  ps -axo pid=,command= | awk \
    -v chrome_bin="$CHROME_BIN" \
    -v user_data_flag="--user-data-dir=$CHROME_USER_DATA_DIR" \
    -v profile_flag="--profile-directory=$PROFILE_DIR" \
    -v port_flag="--remote-debugging-port=$PORT" \
    -v extension_flag="--load-extension=$EXTENSION_DIR" '
      index($0, chrome_bin) &&
      index($0, user_data_flag) &&
      index($0, profile_flag) &&
      index($0, port_flag) &&
      index($0, extension_flag) {
        print $1
      }
    '
}

if [ -z "$PROFILE_DIR" ]; then
  PROFILE_DIR=$(node - "$CHROME_USER_DATA_DIR" "$PROFILE_NAME" <<'NODE'
const fs = require("fs");
const path = require("path");

const userDataDir = process.argv[2];
const profileName = String(process.argv[3] ?? "").trim().toLowerCase();
const localStatePath = path.join(userDataDir, "Local State");

try {
  const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
  const infoCache = localState.profile?.info_cache ?? {};
  const entries = Object.entries(infoCache);

  const found = entries.find(([dir, info]) => {
    const candidate = info ?? {};
    return [
      dir,
      candidate.name,
      candidate.gaia_name,
      candidate.gaia_given_name,
      candidate.user_name
    ]
      .filter(Boolean)
      .some((value) => String(value).trim().toLowerCase() === profileName);
  });

  if (found) {
    process.stdout.write(found[0]);
  }
} catch (error) {
  process.stderr.write(`Failed to resolve Chrome profile: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
NODE
)
fi

if [ ! -x "$CHROME_BIN" ]; then
  echo "Chrome executable was not found at: $CHROME_BIN"
  exit 1
fi

if [ ! -d "$CHROME_USER_DATA_DIR" ]; then
  echo "Chrome user data directory was not found at: $CHROME_USER_DATA_DIR"
  exit 1
fi

if [ ! -d "$EXTENSION_DIR" ]; then
  echo "Extension build output was not found at: $EXTENSION_DIR"
  echo "Run npm run build first."
  exit 1
fi

if [ -z "$PROFILE_DIR" ]; then
  echo "Chrome profile named \"$PROFILE_NAME\" was not found."
  echo "Set CHATGPT_CHROME_PROFILE_DIR explicitly or rename CHATGPT_CHROME_PROFILE_NAME."
  echo "Available profiles:"
  node - "$CHROME_USER_DATA_DIR" <<'NODE'
const fs = require("fs");
const path = require("path");

const userDataDir = process.argv[2];
const localStatePath = path.join(userDataDir, "Local State");
const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
const infoCache = localState.profile?.info_cache ?? {};

for (const [dir, info] of Object.entries(infoCache)) {
  const label = [info.name, info.gaia_name, info.user_name].filter(Boolean).join(" | ");
  process.stdout.write(`- ${dir}: ${label}\n`);
}
NODE
  exit 1
fi

MANAGED_CHROME_PIDS=$(find_managed_chrome_pids || true)
HAS_MANAGED_CHROME=0
if [ -n "$MANAGED_CHROME_PIDS" ]; then
  HAS_MANAGED_CHROME=1
fi

HAS_ANY_CHROME=0
if osascript -e 'application "Google Chrome" is running' 2>/dev/null | grep -q "true"; then
  HAS_ANY_CHROME=1
fi

if [ "$DRY_RUN" = "1" ]; then
  echo "Resolved profile name: $PROFILE_NAME"
  echo "Resolved profile dir: $PROFILE_DIR"
  echo "Chrome user data dir: $CHROME_USER_DATA_DIR"
  echo "Extension dir: $EXTENSION_DIR"
  echo "Remote debugging port: $PORT"
  echo "ChatGPT URL: $CHATGPT_URL"
  echo "Any Chrome running: $HAS_ANY_CHROME"
  echo "Managed Marshal Chrome running: $HAS_MANAGED_CHROME"
  if [ "$HAS_MANAGED_CHROME" = "1" ]; then
    echo "Managed Marshal Chrome PIDs: $MANAGED_CHROME_PIDS"
  fi
  exit 0
fi

if [ "$HAS_ANY_CHROME" = "1" ] && [ "$HAS_MANAGED_CHROME" != "1" ]; then
  echo "Google Chrome is already running in another session."
  echo "Expected profile: $PROFILE_NAME ($PROFILE_DIR)"
  echo "Marshal will not quit the whole Chrome app automatically, because that would close other profiles too."
  echo "Close the conflicting Chrome session first, then run this script again."
  exit 1
fi

if [ "$HAS_MANAGED_CHROME" = "1" ]; then
  echo "Chrome is already running with profile \"$PROFILE_NAME\" ($PROFILE_DIR)."
  echo "Reusing the existing Marshal browser session."
  if [ "$AUTO_QUIT_CHROME" = "1" ]; then
    echo "CHATGPT_AUTO_QUIT_CHROME is ignored for unrelated Chrome profiles."
  fi
fi

if [ -d "$CHROME_APP" ]; then
  open -na "$CHROME_APP" --args \
    --user-data-dir="$CHROME_USER_DATA_DIR" \
    --profile-directory="$PROFILE_DIR" \
    --remote-debugging-port="$PORT" \
    --load-extension="$EXTENSION_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --new-window \
    "$CHATGPT_URL" >/dev/null 2>&1
else
  "$CHROME_BIN" \
    --user-data-dir="$CHROME_USER_DATA_DIR" \
    --profile-directory="$PROFILE_DIR" \
    --remote-debugging-port="$PORT" \
    --load-extension="$EXTENSION_DIR" \
    --no-first-run \
    --no-default-browser-check \
    --new-window \
    "$CHATGPT_URL" >/dev/null 2>&1 &
fi

echo "Chrome started with profile \"$PROFILE_NAME\" ($PROFILE_DIR)."
echo "Marshal extension loaded from: $EXTENSION_DIR"
echo "ChatGPT opened at: $CHATGPT_URL"
echo "Remote debugging is available at http://127.0.0.1:$PORT"
