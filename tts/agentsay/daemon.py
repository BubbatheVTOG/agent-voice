"""Warm agent-say daemon.

Keeps the ONNX model resident and serves one request per connection over a
Unix socket. Cancel bumps a generation counter, so queued announcements are
dropped and the active paplay is terminated. Exits after IDLE_SECONDS without
work.
"""

import contextlib
import os
import socketserver
import sys
import tempfile
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import cast

from . import audio
from .client import is_listening, socket_path, verify_runtime_dir
from .protocol import MAX_LINE_BYTES, ProtocolError, decode, encode, validate_owner, validate_say

IDLE_SECONDS = 300
WATCHDOG_INTERVAL = 5.0


class Speaker:
    """Renders one request at a time; playbacks may overlap, and each owner's are cancellable."""

    def __init__(self, render: Callable[[dict], tuple[bytes, float]],
                 playback=audio.start_playback, clock=time.monotonic):
        self._render = render
        self._playback = playback
        self._clock = clock
        self._synth_lock = threading.Lock()
        self._state = threading.Lock()
        self._generations: dict[str, int] = {}
        self._procs: dict[str, set] = {}
        self._inflight = 0
        self._last_activity = clock()

    def say(self, request: dict) -> dict:
        owner = request["owner"]
        with self._state:
            generation = self._generations.get(owner, 0)
            self._inflight += 1
        try:
            return self._say_locked(request, owner, generation)
        finally:
            with self._state:
                self._inflight -= 1
                self._last_activity = self._clock()

    def _say_locked(self, request: dict, owner: str, generation: int) -> dict:
        with self._synth_lock:
            if self._is_cancelled(owner, generation):
                return {"ok": True, "cancelled": True}
            pcm, seconds = self._render(request)
        if request["out"] is not None:
            audio.write_wav(Path(request["out"]), pcm)
            return {"ok": True, "seconds": seconds}
        return self._play(pcm, owner, generation)

    def _play(self, pcm: bytes, owner: str, generation: int) -> dict:
        fd, name = tempfile.mkstemp(suffix=".wav")
        os.close(fd)
        wav = Path(name)
        try:
            audio.write_wav(wav, pcm)
            with self._state:
                if self._generations.get(owner, 0) != generation:
                    return {"ok": True, "cancelled": True}
                proc = self._playback(wav)
                self._procs.setdefault(owner, set()).add(proc)
            code = proc.wait()
            self._forget(owner, proc)
            if self._is_cancelled(owner, generation):
                return {"ok": True, "cancelled": True}
            if code != 0:
                return {"ok": False, "error": f"paplay exited with status {code}"}
            return {"ok": True}
        finally:
            wav.unlink(missing_ok=True)

    def _forget(self, owner: str, proc) -> None:
        with self._state:
            procs = self._procs.get(owner)
            if procs is None:
                return
            procs.discard(proc)
            if not procs:
                del self._procs[owner]

    def _is_cancelled(self, owner: str, generation: int) -> bool:
        with self._state:
            return self._generations.get(owner, 0) != generation

    def cancel(self, owner: str) -> dict:
        with self._state:
            self._generations[owner] = self._generations.get(owner, 0) + 1
            procs = list(self._procs.pop(owner, ()))
        stopped = 0
        for proc in procs:
            if proc.poll() is None:
                proc.terminate()
                stopped += 1
        return {"ok": True, "stopped": stopped > 0, "count": stopped}

    def status(self) -> dict:
        with self._state:
            return {
                "ok": True,
                "pid": os.getpid(),
                "playing": any(self._procs.values()),
                "inflight": self._inflight,
            }

    def idle_for(self) -> float:
        with self._state:
            if self._inflight or any(self._procs.values()):
                return 0.0
            return self._clock() - self._last_activity


def _dispatch(speaker: Speaker, message: dict, shutdown) -> dict:
    op = message.get("op")
    if op == "say":
        return speaker.say(validate_say(message))
    if op == "cancel":
        return speaker.cancel(validate_owner(message))
    if op == "status":
        return speaker.status()
    if op == "stop":
        threading.Thread(target=shutdown, daemon=True).start()
        return {"ok": True}
    raise ProtocolError(f"unknown op: {op!r}")


class _Handler(socketserver.StreamRequestHandler):
    def handle(self):
        reply = self._reply(self.rfile.readline(MAX_LINE_BYTES + 1))
        with contextlib.suppress(BrokenPipeError, ConnectionResetError):
            # A killed client (e.g. /voice stop) has nothing left to hear the reply.
            self.wfile.write(encode(reply))

    def _reply(self, line: bytes) -> dict:
        server = cast("_Server", self.server)
        try:
            return _dispatch(server.speaker, decode(line), server.shutdown)
        except ProtocolError as e:
            return {"ok": False, "error": str(e)}
        except Exception as e:  # keep the daemon alive; report the failure
            return {"ok": False, "error": f"{type(e).__name__}: {e}"}


class _Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True

    def __init__(self, path: str, speaker: Speaker):
        self.speaker = speaker
        super().__init__(path, _Handler)


def _watchdog(server: _Server, speaker: Speaker, idle_seconds: float, interval: float) -> None:
    while True:
        time.sleep(interval)
        if speaker.idle_for() > idle_seconds:
            server.shutdown()
            return


def _claim_socket(path: Path) -> bool:
    """Return False when another live daemon already owns the socket. Raises OSError on an unsafe runtime dir."""
    verify_runtime_dir(path)
    if path.exists():
        if is_listening(path):
            return False
        path.unlink()
    return True


def serve(engine, path: Path | None = None, idle_seconds: float = IDLE_SECONDS,
          interval: float = WATCHDOG_INTERVAL) -> int:
    from .synth import render  # heavy import only in the daemon process

    path = path or socket_path()
    try:
        claimed = _claim_socket(path)
    except OSError as e:
        print(f"agent-say daemon: refusing to start: {e}", file=sys.stderr)
        return 1
    if not claimed:
        return 0
    speaker = Speaker(lambda request: render(engine, request))
    server = _Server(str(path), speaker)
    os.chmod(path, 0o600)
    threading.Thread(target=_watchdog, args=(server, speaker, idle_seconds, interval),
                     daemon=True).start()
    try:
        server.serve_forever()
    finally:
        server.server_close()
        path.unlink(missing_ok=True)
    return 0
