#!/usr/bin/env bash
# Build the agent-say (local Kokoro TTS, ONNX q8) environment, in-place.
# Idempotent: safe to re-run (offline too, once built). Model files are pinned
# to a commit and verified by sha256 before use.
set -euo pipefail
cd "$(dirname "$0")"

MODEL_URL="https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/1939ad2a8e416c0acfeecc08a694d14ef25f2231/onnx/model_quantized.onnx"
MODEL_SHA256="fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478"
VOICES_URL="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/voices-v1.0.bin"
VOICES_SHA256="bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

fetch_verified() { # url dest sha256
	local url="$1" dest="$2" sha="$3"
	if [ -f "$dest" ] && echo "$sha  $dest" | sha256sum -c --status; then
		return 0
	fi
	mkdir -p "$(dirname "$dest")"
	curl -fsSL -o "$dest.part" "$url"
	if ! echo "$sha  $dest.part" | sha256sum -c --status; then
		rm -f "$dest.part"
		echo "error: checksum mismatch for $url" >&2
		exit 1
	fi
	mv "$dest.part" "$dest"
}

python_ok() {
	"$1" -c 'import sys; assert (3, 11) <= sys.version_info[:2] < (3, 14)' >/dev/null 2>&1
}

# --- venv (guarded on the interpreter: a half-created venv is rebuilt, not skipped) ---
if [ ! -x venv/bin/python3 ]; then
	rm -rf venv
	# A fresh build needs a compatible interpreter (3.11–3.13; the pinned
	# onnxruntime/kokoro-onnx wheels are only validated there). Candidates are
	# validated before use — a broken shim or the wrong major must not slip through.
	PY=""
	if command -v mise >/dev/null; then
		for v in 3.13 3.12 3.11; do
			p="$(mise which "python@$v" 2>/dev/null || true)"
			if [ -n "$p" ] && python_ok "$p"; then
				PY="$p"
				break
			fi
		done
	fi
	if [ -z "$PY" ]; then
		for c in python3.13 python3.12 python3.11; do
			if command -v "$c" >/dev/null 2>&1 && python_ok "$c"; then
				PY="$(command -v "$c")"
				break
			fi
		done
	fi
	[ -n "$PY" ] || {
		echo "error: need a working Python 3.11–3.13 (try: mise install python@3.12)" >&2
		exit 1
	}
	echo "using python: $PY ($("$PY" --version))"
	"$PY" -m venv venv
	# Only a fresh build touches the index for pip itself; the re-run below is
	# a no-op offline when the pins are satisfied.
	./venv/bin/python -m pip install -q -U pip
fi

./venv/bin/python -m pip install -q -r requirements.txt

fetch_verified "$MODEL_URL" models/kokoro-q8/model_quantized.onnx "$MODEL_SHA256"
fetch_verified "$VOICES_URL" models/voices-v1.0.bin "$VOICES_SHA256"

# --- wire up the CLI (repo files are never modified by install) ---
chmod +x bin/agent-say
mkdir -p "$HOME/.local/bin"
if [ -e "$HOME/.local/bin/agent-say" ] && [ ! -L "$HOME/.local/bin/agent-say" ]; then
	echo "error: $HOME/.local/bin/agent-say exists and is not a symlink — move it aside first" >&2
	exit 1
fi
ln -sfn "$PWD/bin/agent-say" "$HOME/.local/bin/agent-say"
echo "done. try: agent-say --help"
