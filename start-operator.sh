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

OPERATOR_WEB_PORT=${OPERATOR_WEB_PORT:-3489}
OPERATOR_AUTO_OPEN_UI=${OPERATOR_AUTO_OPEN_UI:-1}
MARSHAL_BRIDGE_MODE=${MARSHAL_BRIDGE_MODE:-${CHATGPT_BRIDGE_MODE:-claude-web}}
CHATGPT_REMOTE_DEBUGGING_PORT=${CHATGPT_REMOTE_DEBUGGING_PORT:-9222}

if [ ! -d "node_modules" ]; then
  npm install
fi

npm run build >/dev/null

# Only open Chrome for legacy bridge modes
if [ "$MARSHAL_BRIDGE_MODE" = "playwright" ] && [ -z "${CHATGPT_CDP_URL:-}" ]; then
  "$SCRIPT_DIR/open-chatgpt-browser.sh"
  export CHATGPT_CDP_URL="http://127.0.0.1:$CHATGPT_REMOTE_DEBUGGING_PORT"
elif [ "$MARSHAL_BRIDGE_MODE" = "extension" ]; then
  "$SCRIPT_DIR/open-chatgpt-browser-default-profile.sh"
fi

node dist/operator-main.js &
SERVER_PID=$!

cleanup() {
  if kill -0 "$SERVER_PID" >/dev/null 2>&1; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}

trap cleanup INT TERM EXIT

READY=0
ATTEMPTS=0
while [ "$ATTEMPTS" -lt 30 ]; do
  if curl -fsS "http://127.0.0.1:$OPERATOR_WEB_PORT/api/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  ATTEMPTS=$((ATTEMPTS + 1))
  sleep 1
done

if [ "$READY" != "1" ]; then
  echo "Operator web console failed to start on port $OPERATOR_WEB_PORT."
  exit 1
fi

echo "Marshal Operator Console is running at http://127.0.0.1:$OPERATOR_WEB_PORT"

if [ "$OPERATOR_AUTO_OPEN_UI" = "1" ]; then
  open "http://127.0.0.1:$OPERATOR_WEB_PORT" >/dev/null 2>&1 || true
fi

wait "$SERVER_PID"
