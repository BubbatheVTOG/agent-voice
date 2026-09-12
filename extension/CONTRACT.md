# agent-say — CLI contract

The extension depends **only** on this contract, never on internals.
Reference implementation: [`tts/agent-say.py`](../tts/agent-say.py).
Swap the backend, keep this contract, and nothing else changes.

## Invocation

```text
agent-say [text ...]                # or: echo "text" | agent-say
  -v, --voice NAME        voice (default af_aoede; list with --list-voices)
  -o, --out FILE          write 16-bit 24 kHz mono WAV instead of playing
  -s, --speed FLOAT       speech-rate multiplier (default 1.2)
      --device {cpu,cuda,auto}  inference device (default cpu — vLLM-safe)
      --list-voices       list voices (network: HuggingFace) and exit
```

## Process contract

- Exit `0` on success, non-zero on failure; diagnostics on **stderr** only
  (the extension never parses stdout).
- First run downloads ~330 MB of model weights into `tts/models/` (HF_HOME
  is pinned to the repo tree; fully offline afterwards).
- Cold start ≈ 5 s (Python + model load on CPU); synthesis ≈ 5× realtime.
- Playback goes to the default PulseAudio sink via `paplay`.

## How the extension invokes it

- Binary: `$AGENT_SAY_BIN` (if set and present, read **live** per call) or
  `~/.local/bin/agent-say` (a symlink to `tts/bin/agent-say`).
- The `speak` tool runs:

  ```bash
  spawn(bin, ["-v", voice, "-s", speed, "--", ...words],
        { detached: true, stdio: ["ignore", "ignore", stderrFd] })
  ```

  each announcement is its own **process group**, so `stopPlayback()` can kill
  the whole group (python wrapper + `paplay`) — WCAG 1.4.2 (pausable audio).
- The `--` separator ends option parsing: option-like words in the spoken
  text (e.g. a quoted `-o PATH`) are spoken as words, never executed as CLI
  options.
- On a stop (`SIGTERM` to the process group) the backend still unlinks its
  temp WAV before exiting.
- stderr goes to a `0600` file under `$TMPDIR/agent-voice/`. A clean exit or
  a user stop deletes it; a failed run keeps it and records a `lastError`
  that `/voice status` surfaces — and the `speak` tool result reports
  "playback failed to start: …" instead of a false success.
