#!/bin/sh
# Phase 7 acceptance: validate the Andrii profile launcher in dry-run mode.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_ROOT="$SCRIPT_DIR/../.."
cd "$PROJECT_ROOT"

echo "=== Phase 7: Andrii Session Launcher Acceptance ==="
echo ""

# 1. Build must be fresh
echo "  Build project ..."
npm run build >/dev/null 2>&1
echo "  Build ... OK"

# 2. Extension artifact must exist
EXTENSION_DIR="$PROJECT_ROOT/dist/chrome-extension"
if [ ! -d "$EXTENSION_DIR" ]; then
  echo "  FAIL: Extension build output missing at $EXTENSION_DIR"
  exit 1
fi
echo "  Extension artifact ... OK"

# 3. Manifest must be present in the extension
if [ ! -f "$EXTENSION_DIR/manifest.json" ]; then
  echo "  FAIL: manifest.json missing in extension"
  exit 1
fi
echo "  Extension manifest ... OK"

# 4. Dry-run the launcher — should resolve profile and print config
echo "  Dry-run launcher ..."
export CHATGPT_BROWSER_DRY_RUN=1
DRY_OUTPUT=$("$PROJECT_ROOT/open-chatgpt-browser-default-profile.sh" 2>&1) || {
  echo "  FAIL: Launcher dry-run exited with error:"
  echo "$DRY_OUTPUT"
  exit 1
}
echo "$DRY_OUTPUT" | while IFS= read -r line; do
  echo "    $line"
done

# 5. Verify expected fields in dry-run output
for FIELD in "Resolved profile name:" "Resolved profile dir:" "Extension dir:" "Remote debugging port:" "ChatGPT URL:"; do
  if ! echo "$DRY_OUTPUT" | grep -q "$FIELD"; then
    echo "  FAIL: Missing expected field in dry-run output: $FIELD"
    exit 1
  fi
done
echo "  Dry-run fields ... OK"

# 6. Profile dir must not be empty
PROFILE_DIR=$(echo "$DRY_OUTPUT" | grep "Resolved profile dir:" | sed 's/^.*: //')
if [ -z "$PROFILE_DIR" ]; then
  echo "  FAIL: Profile dir is empty — name resolution failed"
  exit 1
fi
echo "  Profile resolution ... OK ($PROFILE_DIR)"

echo ""
echo "All Phase 7 launcher acceptance checks passed."
