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
      --owner TOKEN       owner of the request (default "cli"); see below
      --list-voices       list voices from the local model file and exit
      --cancel            stop the daemon playback owned by --owner (never starts it)
      --status            print daemon status (or "not running") and exit
      --stop              stop the daemon and exit
```

## Process contract

- Exit `0` on success, non-zero on failure; diagnostics on **stderr** only
  (the extension never parses stdout).
- `tts/install.sh` fetches the ONNX q8 model (~92 MB) and voices (~28 MB) into
  `tts/models/`, pinned and sha256-verified. Fully offline afterwards.
- Model runs on CPU via ONNX Runtime; no GPU, no torch.
- Warm daemon: the first call starts it (about 2 s); later calls take about
  1.5 s for a 7 s announcement. The daemon exits after 5 minutes idle.
  If it cannot start, the CLI synthesizes in-process (about 2 s).
  `AGENT_SAY_DAEMON=0` forces in-process.
- Playback goes to the default PulseAudio sink via `paplay`. The daemon plays
  outside the announcement's process group, so `--cancel` is required for stop.
- `--owner TOKEN` tags each request with an owner. The daemon is shared across
  pi sessions, and `--cancel` is **per owner**: it stops only playback started
  with the same token, never another owner's. Playbacks of different owners
  may overlap. The extension passes one random token per process.
- Output is loudness-matched (RMS target, peak ceiling 0.9) so the ONNX render
  is not louder than the previous torch render.

## How the extension invokes it

- Binary: `$AGENT_SAY_BIN` when set, otherwise `~/.local/bin/agent-say`.
  It must resolve to a regular executable file; executable symlinks are allowed.
  An invalid explicit override does not fall back to the default. The extension
  checks this at startup before registering features and again before playback.
  This does not prove model weights or audio hardware are ready.
- The `speak` tool runs:

  ```bash
  spawn(bin, ["--owner", owner, "-v", voice, "-s", speed, "--", ...words],
        { detached: true, stdio: ["ignore", "ignore", stderrFd] })
  ```

  `owner` is a random token generated once per extension process. The
  extension's cancel is `agent-say --owner <owner> --cancel` (500 ms bounded).

  each announcement is its own **process group**, so `stopPlayback()` can kill
  the whole group (python wrapper + `paplay`) — WCAG 1.4.2 (pausable audio).
- The `--` separator ends option parsing: option-like words in the spoken
  text (e.g. a quoted `-o PATH`) are spoken as words, never executed as CLI
  options.
- On a stop (`SIGTERM` to the process group) the backend still unlinks its
  temp WAV before exiting. A daemon-played announcement is stopped by the
  `--cancel` call that `stopPlayback()` also makes.
- stderr goes to a `0600` file under `$TMPDIR/agent-voice/`. A clean exit or
  a user stop deletes it; a failed run keeps it and records a `lastError`
  that `/voice status` surfaces — and the `speak` tool result reports
  "playback failed to start: …" instead of a false success.
