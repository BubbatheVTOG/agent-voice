#!/usr/bin/env python3
"""agent-say — local Kokoro TTS for AI agents.

Speaks text through the machine's default PulseAudio device (paplay),
or writes a WAV file with --out. Fully offline after first model download.

Usage:
    agent-say "Build complete. No errors."
    echo "Deploying now." | agent-say
    agent-say -v am_michael "Good morning."
    agent-say -o /tmp/x.wav "Save to file instead of playing."
    agent-say --list-voices
"""

import argparse
import os
import sys
import tempfile
import wave
from pathlib import Path

# Pin all HuggingFace model/voice downloads inside this tree.
# __file__.resolve() follows symlinks, so this stays correct even when the
# repo is installed via directory symlinks (see top-level install.sh).
BASE = Path(__file__).resolve().parent
os.environ.setdefault("HF_HOME", str(BASE / "models"))

DEFAULT_VOICE = "af_aoede"
SR = 24000  # Kokoro sample rate


def parse_args():
    p = argparse.ArgumentParser(prog="agent-say", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("text", nargs="*", help="text to speak (or pipe via stdin)")
    p.add_argument("-v", "--voice", default=DEFAULT_VOICE,
                   help=f"voice name (default: {DEFAULT_VOICE}; see --list-voices)")
    p.add_argument("-o", "--out", help="write WAV to this path instead of playing")
    p.add_argument("-s", "--speed", type=float, default=1.2,
                   help="speaking speed multiplier (default: 1.2)")
    p.add_argument("--device", choices=["cpu", "cuda", "auto"], default="cpu",
                   help="inference device (default: cpu — safe for vLLM; use cuda "
                        "once GPU VRAM is trimmed, see task notes)")
    p.add_argument("--list-voices", action="store_true",
                   help="list available voices and exit")
    return p.parse_args()


def list_voices():
    from huggingface_hub import list_repo_files
    import re
    try:
        files = list_repo_files("hexgrad/Kokoro-82M")
    except Exception as e:
        sys.exit(f"could not reach HuggingFace for voice list: {e}")
    names = set()
    for f in files:
        m = re.fullmatch(r"voices/(.+)\.pt", f)
        if m:
            names.add(m.group(1))
    names = sorted(names)
    hub = BASE / "models" / "hub"
    local = set()
    if hub.exists():
        for p in hub.rglob("voices/*.pt"):
            local.add(p.stem)
    print(f"{'VOICE':<14}  status")
    for n in names:
        print(f"{n:<14}  {'[local]' if n in local else '  (downloads on first use)'}")


def main():
    args = parse_args()
    if args.list_voices:
        list_voices()
        return

    text = " ".join(args.text).strip()
    if not text:
        if not sys.stdin.isatty():
            text = sys.stdin.read().strip()
        if not text:
            sys.exit("error: no text given (arg or stdin)")

    device = args.device
    if device == "auto":
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"

    import torch
    from kokoro import KPipeline
    from kokoro.model import KModel

    print(f"[agent-say] loading model on {device} (first run downloads ~330MB)",
          file=sys.stderr)
    pipeline = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=device)

    print(f"[agent-say] synthesizing with voice={args.voice} speed={args.speed}",
          file=sys.stderr)
    import torch
    chunks: list[torch.Tensor] = []
    for result in pipeline(text, voice=args.voice, speed=args.speed):
        a = result.audio
        if a is not None:
            chunks.append(a)
    if not chunks:
        sys.exit("error: no audio produced")
    audio = (torch.cat(chunks) if len(chunks) > 1 else chunks[0]).float().cpu().numpy()
    audio = (audio * 32767).clip(-32768, 32767).astype("<i2")

    if args.out:
        out = Path(args.out).expanduser()
        with wave.open(str(out), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(audio.tobytes())
        print(f"[agent-say] wrote {out} ({len(audio) / SR:.2f}s)", file=sys.stderr)
        return

    # Play through the default PulseAudio sink.
    import subprocess
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        with wave.open(tf, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(audio.tobytes())
        tmp = tf.name
    try:
        subprocess.run(["paplay", tmp], check=True)
    finally:
        os.unlink(tmp)


if __name__ == "__main__":
    main()
