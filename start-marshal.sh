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

if [ ! -d "node_modules" ]; then
  npm install
fi

npm run build >/dev/null

if [ ! -L "index.ts" ] && [ ! -f "index.ts" ]; then
  ln -s "dist/main.js" "index.ts"
fi

if [ "${CHATGPT_AUTO_OPEN_BROWSER:-1}" = "1" ]; then
  "$SCRIPT_DIR/open-chatgpt-browser-default-profile.sh"
fi

exec node index.ts --login
