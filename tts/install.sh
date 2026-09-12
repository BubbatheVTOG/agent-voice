#!/usr/bin/env bash
# Build the agent-say (local Kokoro TTS) environment, in-place.
# Idempotent: safe to re-run. Models/voices live in ./models (HF_HOME).
set -euo pipefail
cd "$(dirname "$0")"

python_ok() {
	"$1" -c 'import sys; assert (3, 11) <= sys.version_info[:2] < (3, 14)' >/dev/null 2>&1
}

# --- venv ---
if [ ! -d venv ]; then
	# A fresh build needs a compatible interpreter (3.11–3.13; 3.14 breaks
	# torch/kokoro). Candidates are validated before use — a broken shim or
	# the wrong major must not slip through.
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
fi

./venv/bin/python -m pip install -q -U pip
./venv/bin/python -m pip install -q -r requirements.txt

# --- wire up the CLI (repo files are never modified by install) ---
chmod +x bin/agent-say
mkdir -p "$HOME/.local/bin"
ln -sf "$PWD/bin/agent-say" "$HOME/.local/bin"
echo "done. try: agent-say --help"
