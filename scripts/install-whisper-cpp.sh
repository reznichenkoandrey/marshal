#!/usr/bin/env bash
# scripts/install-whisper-cpp.sh
# Bootstrap local whisper.cpp + default model. Idempotent: re-running is a no-op
# when everything is already in place.
#
# Targets:
#   .whisper/whisper.cpp/       — vendor checkout (git-ignored)
#   .whisper/bin/whisper-cli    — symlink to the built binary
#   .whisper/models/<name>.bin  — ggml model weights
#
# Env overrides:
#   WHISPER_MODEL   — model name (default: ggml-small)
#   WHISPER_TAG     — whisper.cpp git tag (default: latest tagged release)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_DIR="$ROOT_DIR/.whisper"
REPO_DIR="$WHISPER_DIR/whisper.cpp"
BIN_DIR="$WHISPER_DIR/bin"
MODEL_DIR="$WHISPER_DIR/models"
MODEL="${WHISPER_MODEL:-ggml-small}"
MODEL_FILE="$MODEL_DIR/${MODEL}.bin"

mkdir -p "$WHISPER_DIR" "$BIN_DIR" "$MODEL_DIR"

# ── Clone whisper.cpp if missing ──
if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "[whisper] cloning whisper.cpp …"
  git clone --depth 1 https://github.com/ggerganov/whisper.cpp.git "$REPO_DIR"
fi

# ── Build CLI binary ──
# whisper.cpp publishes the CLI at build/bin/whisper-cli (CMake-based build).
WHISPER_CLI="$REPO_DIR/build/bin/whisper-cli"
if [[ ! -x "$WHISPER_CLI" ]]; then
  echo "[whisper] building whisper.cpp (this can take ~1 min) …"
  pushd "$REPO_DIR" > /dev/null
  # Use CMake — the Makefile path is deprecated upstream.
  cmake -S . -B build -DBUILD_SHARED_LIBS=OFF > /dev/null
  cmake --build build -j --config Release --target whisper-cli > /dev/null
  popd > /dev/null
fi

if [[ ! -x "$WHISPER_CLI" ]]; then
  echo "[whisper] ERROR — build produced no whisper-cli binary at $WHISPER_CLI" >&2
  exit 1
fi

# Stable symlink so TS code doesn't have to know the internal build layout.
ln -sf "$WHISPER_CLI" "$BIN_DIR/whisper-cli"

# ── Download model ──
if [[ ! -f "$MODEL_FILE" ]]; then
  echo "[whisper] downloading model $MODEL …"
  # Upstream ships a helper script that handles mirrors / resume.
  bash "$REPO_DIR/models/download-ggml-model.sh" "${MODEL#ggml-}" "$MODEL_DIR" > /dev/null
fi

if [[ ! -f "$MODEL_FILE" ]]; then
  echo "[whisper] ERROR — model download produced no file at $MODEL_FILE" >&2
  exit 1
fi

echo "[whisper] ready:"
echo "  bin:   $BIN_DIR/whisper-cli"
echo "  model: $MODEL_FILE"
