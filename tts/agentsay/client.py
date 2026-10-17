"""Socket client for the agent-say daemon. Stdlib only: the CLI forwards requests without loading the model."""

import contextlib
import json
import os
import socket
import stat
import tempfile
from pathlib import Path

from .protocol import encode


def runtime_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR")
    if base:
        return Path(base) / "agent-say"
    return Path(tempfile.gettempdir()) / f"agent-say-{os.getuid()}"


def socket_path() -> Path:
    return runtime_dir() / "daemon.sock"


def verify_runtime_dir(path: Path) -> None:
    """Ensure the socket's parent is a private directory of ours; create it (0700) if absent.

    Raises PermissionError instead of chmod-ing a directory we do not own or whose mode is wrong:
    another local user who pre-creates it could otherwise spoof or read requests.
    """
    directory = path.parent
    try:
        st = os.lstat(directory)
    except FileNotFoundError:
        directory.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(FileExistsError):  # lost a creation race; the lstat below judges the winner
            os.mkdir(directory, 0o700)
        st = os.lstat(directory)
    if not stat.S_ISDIR(st.st_mode):
        raise PermissionError(f"{directory} is not a real directory (symlink or file)")
    if st.st_uid != os.getuid():
        raise PermissionError(f"{directory} is owned by uid {st.st_uid}, not {os.getuid()}")
    mode = stat.S_IMODE(st.st_mode)
    if mode != 0o700:
        raise PermissionError(f"{directory} has mode {mode:04o}, expected 0700")


def is_listening(path: Path) -> bool:
    try:
        verify_runtime_dir(path)
    except OSError:
        return False
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        try:
            s.connect(str(path))
        except OSError:
            return False
    return True


def send(message: dict, path: Path | None = None, timeout: float = 300.0) -> dict:
    """One request/response round trip. Raises OSError when no daemon is listening or the dir is unsafe."""
    path = path or socket_path()
    verify_runtime_dir(path)
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(timeout)
        s.connect(str(path))
        s.sendall(encode(message))
        s.shutdown(socket.SHUT_WR)
        raw = b""
        while not raw.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            raw += chunk
    try:
        return json.loads(raw)
    except ValueError:
        return {"ok": False, "error": "malformed daemon reply"}
