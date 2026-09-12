#!/usr/bin/env bash
# Install agent-voice from this repo. Idempotent — safe to re-run.
#
#   1. build the local TTS backend   (tts/install.sh: venv + pinned deps)
#   2. install extension dev deps    (types only; pi loads the TS directly)
#   3. link the live locations into this repo (repo is the source of truth)
#
set -euo pipefail
REPO="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

echo "==> [1/3] TTS backend (tts/install.sh)"
"$REPO/tts/install.sh"

echo "==> [2/3] extension dev deps (types only)"
npm --prefix "$REPO/extension" install

link_into() {
	local live="$1" target="$2"
	if [ -L "$live" ]; then
		ln -sfn "$target" "$live"
	elif [ -e "$live" ]; then
		echo "error: $live exists and is not a symlink — move it aside first" >&2
		exit 1
	else
		mkdir -p "$(dirname "$live")"
		ln -s "$target" "$live"
	fi
	echo "    linked $live -> $target"
}

echo "==> [3/3] linking live locations into the repo"
link_into "$HOME/.local/agent-say" "$REPO/tts"
link_into "$HOME/.pi/agent/extensions/agent-voice" "$REPO/extension"

echo
echo "done. try:  agent-say 'hello'    |    pi  ->  /voice status"
