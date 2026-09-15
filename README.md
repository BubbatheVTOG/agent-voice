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

## Install (idempotent — safe to re-run)

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
node --test tests/                              # fast units: config, classify, budget
AGENT_VOICE_E2E=1 node --test tests/playback.test.mjs   # real TTS: spawns, plays, kills
npm --prefix extension run typecheck            # tsc --noEmit (deps installed by install.sh)
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
