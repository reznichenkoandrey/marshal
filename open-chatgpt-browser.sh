#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SCRIPT_DIR"

CHROME_APP=${CHATGPT_BROWSER_APP_PATH:-/Applications/Google Chrome.app}
CHROME_BIN=${CHATGPT_BROWSER_EXECUTABLE_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}
PROFILE_DIR=${CHATGPT_USER_DATA_DIR:-"$SCRIPT_DIR/agent/.chrome-manual-profile"}
PORT=${CHATGPT_REMOTE_DEBUGGING_PORT:-9222}
CHATGPT_URL=${CHATGPT_URL:-https://chatgpt.com}

mkdir -p "$PROFILE_DIR"

if [ -d "$CHROME_APP" ]; then
  open -na "$CHROME_APP" --args \
    --user-data-dir="$PROFILE_DIR" \
    --remote-debugging-port="$PORT" \
    --no-first-run \
    --no-default-browser-check \
    "$CHATGPT_URL"
else
  "$CHROME_BIN" \
    --user-data-dir="$PROFILE_DIR" \
    --remote-debugging-port="$PORT" \
    --no-first-run \
    --no-default-browser-check \
    "$CHATGPT_URL" >/dev/null 2>&1 &
fi

echo "Manual Chrome started with remote debugging on http://127.0.0.1:$PORT"
echo "Log in to ChatGPT in that browser, then run the agent with CHATGPT_CDP_URL=http://127.0.0.1:$PORT"
