"""Newline-delimited JSON request protocol between the agent-say CLI and daemon."""

import json
from pathlib import Path

MAX_LINE_BYTES = 1_000_000
MAX_TEXT_CHARS = 4000


class ProtocolError(ValueError):
    pass


def encode(message: dict) -> bytes:
    return json.dumps(message, separators=(",", ":")).encode() + b"\n"


def decode(line: bytes) -> dict:
    if len(line) > MAX_LINE_BYTES:
        raise ProtocolError("request too large")
    try:
        message = json.loads(line)
    except json.JSONDecodeError as e:
        raise ProtocolError(f"malformed request: {e.msg}") from None
    if not isinstance(message, dict):
        raise ProtocolError("request must be a JSON object")
    return message


def say_request(text: str, voice: str, speed: float, out: str | None, owner: str) -> dict:
    request = {"op": "say", "text": text, "voice": voice, "speed": speed, "owner": owner}
    if out is not None:
        request["out"] = str(Path(out).expanduser().resolve())
    return request


def cancel_request(owner: str) -> dict:
    return {"op": "cancel", "owner": owner}


def validate_owner(message: dict) -> str:
    owner = message.get("owner")
    if not isinstance(owner, str) or not owner:
        raise ProtocolError("owner must be a non-empty string")
    return owner


def validate_say(message: dict) -> dict:
    text = message.get("text")
    voice = message.get("voice")
    speed = message.get("speed")
    out = message.get("out")
    if not isinstance(text, str) or not text.strip():
        raise ProtocolError("text must be a non-empty string")
    if len(text) > MAX_TEXT_CHARS:
        raise ProtocolError(f"text exceeds {MAX_TEXT_CHARS} characters")
    if not isinstance(voice, str) or not voice:
        raise ProtocolError("voice must be a non-empty string")
    if isinstance(speed, bool) or not isinstance(speed, (int, float)) or not speed > 0:
        raise ProtocolError("speed must be a positive number")
    if out is not None and (not isinstance(out, str) or not Path(out).is_absolute()):
        raise ProtocolError("out must be an absolute path")
    return {"text": text, "voice": voice, "speed": float(speed), "out": out,
            "owner": validate_owner(message)}
