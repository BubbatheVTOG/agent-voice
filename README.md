# agent-voice

Hands-free voice output for the **pi** coding agent. The agent can speak short
status announcements — a job failed, it needs your input, a long job finished —
through **local** [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) TTS.
No cloud, no API keys, stoppable mid-sentence, word-budgeted. **Everything is
OFF by default; opt-in at every layer.**

## Layout

```text
tts/        local TTS backend (Python)
  agent-say.py        the CLI (Kokoro pipeline, paplay playback, WAV export)
  bin/agent-say       thin launcher (repo files are never modified by install)
  install.sh          idempotent backend installer (venv + pinned deps)
  requirements.txt    frozen pins
  audition/           voice sampling tooling (20 US voices, regenerable)
extension/  the pi extension (TypeScript; pi loads it directly — no build step)
  index.ts config.ts speak.ts policy.ts voice-command.ts
  README.md           config reference, the announcement policy + evidence,
                      the verified test list, extension points
  CONTRACT.md         the agent-say CLI contract the extension depends on
tests/      node --test suites (units run always; TTS integration is gated)
install.sh  one-shot installer for a machine (idempotent, re-runnable)
```

## Install the Pi extension

Use Pi's native Git package installation. Replace `COMMIT` with the reviewed
commit you want to install:

```bash
pi install git:github.com/BubbatheVTOG/agent-voice@COMMIT
```

The package loads only `extension/index.ts`. It has no install hooks and does
not install TTS, download voice models, start services, or create live symlinks.
Pi provides its own host modules. Do not also load a copied or linked version of
the extension.

At startup, the extension checks for an executable `AGENT_SAY_BIN`, or
`~/.local/bin/agent-say` when no override is set. Without it, no voice tool,
command, policy hooks, or footer item register. An invalid explicit override
does not fall back to another backend. After making the backend available,
reload Pi to activate the extension; speech remains opt-in.

This is a filesystem prerequisite check, not a test of audio-device or model
readiness. Backend failures during playback still report an error.

## Optional full local setup (legacy installer)

Use the following only when you explicitly want the TTS backend and a linked
source checkout instead of native package installation. Do not combine the two
extension installation methods.

```bash
./install.sh
```

1. builds the TTS backend (`tts/install.sh`: a Python 3.11–3.13 venv + frozen
   deps; the **first** TTS run auto-downloads ~330 MB of weights into
   `tts/models/`, then it's fully offline)
2. installs the extension's type-only dev deps
3. **links the live locations into this repo** — this repo is the source of
   truth, the live paths are symlinks:

```text
~/.local/agent-say                  → tts/
~/.pi/agent/extensions/agent-voice  → extension/
~/.local/bin/agent-say              → tts/bin/agent-say
```

Edits made through the live paths are edits to this repo — commit from here.
On another machine: clone, `./install.sh`, then `/reload` in pi.

## Develop & test

```bash
npm --prefix extension ci --ignore-scripts --no-audit --no-fund
npm --prefix extension test                     # offline tests; real TTS skipped by default
AGENT_VOICE_E2E=1 node --test tests/playback.test.mjs   # opt-in real audio playback
npm --prefix extension run typecheck            # tsc --noEmit
python3 -m py_compile tts/agent-say.py          # python syntax
```

## Turning voice on (when you want it)

```json
{ "agentVoice": { "enabled": true, "autoAnnounce": true } }
```

→ `~/.pi/agent/settings.json` (global) or `.pi/settings.json` (per project).
Precedence: `AGENT_VOICE_OFF=1` env (kill, beats all) > `/voice on|off`
(session, in-memory) > project > global > defaults (off). `/voice on` and
`/voice off` link manual speech and automatic announcements together for the
current session. `/voice status`
shows the resolved config with per-key provenance; `/voice stop` kills running
announcements. Full reference, the policy and its evidence:
[extension/README.md](extension/README.md).

## License

[MIT](LICENSE). The Kokoro-82M model weights are Apache-2.0
(hexgrad/Kokoro-82M) and stay that way regardless of this license.
