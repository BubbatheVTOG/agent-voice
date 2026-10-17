#!/usr/bin/env python3
"""agent-say — local Kokoro TTS (ONNX q8) for AI agents.

Speaks text through the default PulseAudio sink (paplay), or writes a WAV file
with --out. A warm daemon keeps the model resident and exits after 5 minutes of
idle; if it cannot start, the CLI synthesizes in-process. Fully offline.

Usage:
    agent-say "Build complete. No errors."
    echo "Deploying now." | agent-say
    agent-say -v am_michael "Good morning."
    agent-say -o /tmp/x.wav "Save to file instead of playing."
    agent-say --cancel          # stop any announcement the daemon is playing
    agent-say --status | --stop
    agent-say --list-voices
    AGENT_SAY_DAEMON=0 agent-say ...   # always in-process, no daemon
"""

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from agentsay import audio, client, protocol

DEFAULT_VOICE = "af_aoede"
CONNECT_TIMEOUT = 15.0


def parse_args():
    p = argparse.ArgumentParser(prog="agent-say", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("text", nargs="*", help="text to speak (or pipe via stdin)")
    p.add_argument("-v", "--voice", default=DEFAULT_VOICE,
                   help=f"voice name (default: {DEFAULT_VOICE}; see --list-voices)")
    p.add_argument("-o", "--out", help="write WAV to this path instead of playing")
    p.add_argument("-s", "--speed", type=float, default=1.2,
                   help="speaking speed multiplier (default: 1.2)")
    p.add_argument("--list-voices", action="store_true",
                   help="list available voices (local model file) and exit")
    p.add_argument("--owner", default="cli",
                   help="owner token for the daemon; --cancel stops only this owner's playback "
                        "(default: cli)")
    p.add_argument("--cancel", action="store_true",
                   help="stop announcements the daemon is playing for --owner; never starts it")
    p.add_argument("--status", action="store_true", help="show daemon status and exit")
    p.add_argument("--stop", action="store_true", help="stop the daemon and exit")
    p.add_argument("--daemon", action="store_true", help=argparse.SUPPRESS)
    return p.parse_args()


def read_text(words: list[str]) -> str:
    text = " ".join(words).strip()
    if not text and not sys.stdin.isatty():
        text = sys.stdin.read().strip()
    if not text:
        sys.exit("error: no text given (arg or stdin)")
    return text


def _engine():
    from agentsay import synth
    return synth.load_engine()


def daemon_enabled() -> bool:
    return os.environ.get("AGENT_SAY_DAEMON") != "0"


def start_daemon() -> bool:
    path = client.socket_path()
    if client.is_listening(path):
        return True
    # Detached session: /voice stop kills the announcement's process group, not the daemon.
    proc = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--daemon"],
                            start_new_session=True, stdin=subprocess.DEVNULL,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.monotonic() + CONNECT_TIMEOUT
    while time.monotonic() < deadline:
        if client.is_listening(path):
            return True
        if proc.poll() is not None:  # daemon died during startup: fall back now, not after the timeout
            return False
        time.sleep(0.05)
    return False


def request_via_daemon(args, text: str) -> dict | None:
    """Return the daemon's reply, or None when the daemon is unavailable."""
    if not daemon_enabled() or not start_daemon():
        return None
    try:
        return client.send(
            protocol.say_request(text, args.voice, args.speed, args.out, args.owner))
    except OSError:
        return None


def synthesize_in_process(args, text: str) -> tuple[bytes, float]:
    from agentsay import synth
    return synth.render(_engine(), {"text": text, "voice": args.voice, "speed": args.speed})


def play_in_process(pcm: bytes) -> dict:
    # /voice stop SIGTERMs the process group; convert to SystemExit so the temp WAV is removed.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    fd, name = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    wav = Path(name)
    try:
        audio.write_wav(wav, pcm)
        code = audio.start_playback(wav).wait()
    finally:
        wav.unlink(missing_ok=True)
    return {"ok": code == 0, "error": f"paplay exited with status {code}"}


def say(args, text: str) -> dict:
    reply = request_via_daemon(args, text)
    if reply is not None:
        return reply
    if daemon_enabled():
        print("[agent-say] daemon unavailable; synthesizing in-process", file=sys.stderr)
    pcm, seconds = synthesize_in_process(args, text)
    if args.out:
        audio.write_wav(Path(args.out).expanduser(), pcm)
        return {"ok": True, "seconds": seconds}
    return play_in_process(pcm)


def cancel(owner: str) -> None:
    if client.is_listening(client.socket_path()):
        client.send(protocol.cancel_request(owner))


def status() -> None:
    if not client.is_listening(client.socket_path()):
        print("agent-say daemon: not running")
        return
    print(client.send({"op": "status"}))


def stop() -> None:
    if client.is_listening(client.socket_path()):
        client.send({"op": "stop"})


def main() -> int:
    args = parse_args()
    if args.daemon:
        from agentsay import daemon
        return daemon.serve(_engine())
    if args.cancel:
        cancel(args.owner)
        return 0
    if args.status:
        status()
        return 0
    if args.stop:
        stop()
        return 0
    if args.list_voices:
        from agentsay import synth
        for name in synth.list_voices(_engine()):
            print(name)
        return 0

    if not (args.speed > 0):
        sys.exit("error: --speed must be a positive number")
    text = read_text(args.text)
    reply = say(args, text)
    if not reply.get("ok"):
        sys.exit(f"error: {reply.get('error', 'unknown failure')}")
    if args.out and reply.get("seconds") is not None:
        print(f"[agent-say] wrote {Path(args.out).expanduser()} ({reply['seconds']:.2f}s)",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:
        sys.exit(f"error: {type(e).__name__}: {e}")
