#!/usr/bin/env bash
# scripts/install-whisper-cpp.sh
# Bootstrap local whisper.cpp + default model. Idempotent: re-running is a no-op
# when everything is already in place.
#
# Targets:
#   .whisper/whisper.cpp/       — vendor checkout (git-ignored)
#   .whisper/bin/whisper-cli    — symlink to the built binary
#   <models dir>/<name>.bin     — ggml model weights, OUTSIDE the repo
#
# The model does not live in the repo any more. It is 0.5-3 GB, it was making
# the packaged DMG 1.5 GB, and both the dev run and the installed app should
# share one copy. That copy goes to the same directory the in-app download
# uses (desktop/dictation/model-installer.ts):
#
#   ~/Library/Application Support/Marshal/models/
#
# `.whisper/models/<name>.bin` is kept as a symlink so anything still looking
# in the old place keeps working.
#
# Env overrides:
#   WHISPER_MODEL      — model name (default: ggml-large-v3-turbo)
#   WHISPER_TAG        — whisper.cpp git tag (default: latest tagged release)
#   MARSHAL_MODELS_DIR — where the weights go (default: the path above)

set -euo pipefail

# ── Preflight: required tools ──
# Fail fast with an actionable message instead of dying halfway through the
# clone (#48). Non-interactive — user stays in control of `brew install`.
missing=()
for cmd in git cmake; do
  if ! command -v "$cmd" > /dev/null 2>&1; then
    missing+=("$cmd")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[whisper] missing required tools: ${missing[*]}" >&2
  if command -v brew > /dev/null 2>&1; then
    echo "[whisper] install them with:" >&2
    echo "  brew install ${missing[*]}" >&2
  else
    echo "[whisper] install Homebrew first (https://brew.sh), then:" >&2
    echo "  brew install ${missing[*]}" >&2
  fi
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WHISPER_DIR="$ROOT_DIR/.whisper"
REPO_DIR="$WHISPER_DIR/whisper.cpp"
BIN_DIR="$WHISPER_DIR/bin"
LEGACY_MODEL_DIR="$WHISPER_DIR/models"
MODEL_DIR="${MARSHAL_MODELS_DIR:-$HOME/Library/Application Support/Marshal/models}"
MODEL="${WHISPER_MODEL:-ggml-large-v3-turbo}"
MODEL_FILE="$MODEL_DIR/${MODEL}.bin"

mkdir -p "$WHISPER_DIR" "$BIN_DIR" "$MODEL_DIR" "$LEGACY_MODEL_DIR"

# Move a model downloaded by an older run of this script instead of fetching
# 1.5 GB again.
if [[ -f "$LEGACY_MODEL_DIR/${MODEL}.bin" && ! -L "$LEGACY_MODEL_DIR/${MODEL}.bin" && ! -f "$MODEL_FILE" ]]; then
  echo "[whisper] moving existing $MODEL out of the repo → $MODEL_DIR"
  mv "$LEGACY_MODEL_DIR/${MODEL}.bin" "$MODEL_FILE"
fi

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

# ── Build the resident server (#218) ──
# Keeps the model loaded between utterances: ~0.7 s instead of whisper-cli's
# 1.6 s, which is almost all model load. Built as a separate step so an
# existing checkout that already has whisper-cli gains it on the next run.
WHISPER_SERVER="$REPO_DIR/build/bin/whisper-server"
if [[ ! -x "$WHISPER_SERVER" ]]; then
  echo "[whisper] building whisper-server …"
  pushd "$REPO_DIR" > /dev/null
  [[ -d build ]] || cmake -S . -B build -DBUILD_SHARED_LIBS=OFF > /dev/null
  cmake --build build -j --config Release --target whisper-server > /dev/null
  popd > /dev/null
fi
if [[ -x "$WHISPER_SERVER" ]]; then
  ln -sf "$WHISPER_SERVER" "$BIN_DIR/whisper-server"
else
  # Not fatal: the app falls back to whisper-cli without it.
  echo "[whisper] WARNING — no whisper-server built; dictation and captions will use the slower whisper-cli" >&2
fi

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

# Back-compat symlink: one copy on disk, still findable at the old path.
ln -sfn "$MODEL_FILE" "$LEGACY_MODEL_DIR/${MODEL}.bin"

echo "[whisper] ready:"
echo "  bin:   $BIN_DIR/whisper-cli"
echo "  model: $MODEL_FILE"
