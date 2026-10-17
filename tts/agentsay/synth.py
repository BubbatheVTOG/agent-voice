"""ONNX Kokoro synthesis (q8 export). Needs the pinned venv (numpy, kokoro-onnx).

Pure helpers live in audio.py so the stdlib-only tests can import them.
"""

from pathlib import Path

import numpy as np
from kokoro_onnx import Kokoro

from .audio import GAP_SECONDS, SR, loudness_gain, split_chunks

BASE = Path(__file__).resolve().parent.parent
MODEL_PATH = BASE / "models" / "kokoro-q8" / "model_quantized.onnx"
VOICES_PATH = BASE / "models" / "voices-v1.0.bin"


class _SpeedAsFloat:
    """kokoro-onnx sends `speed` as int32 for newer exports; this q8 export wants float32."""

    def __init__(self, session):
        self._session = session

    def get_inputs(self):
        return self._session.get_inputs()

    def run(self, outputs, feed):
        fixed = {**feed, "speed": feed["speed"].astype(np.float32)}
        return self._session.run(outputs, fixed)


def load_engine(model_path: Path = MODEL_PATH, voices_path: Path = VOICES_PATH) -> Kokoro:
    engine = Kokoro(str(model_path), str(voices_path))
    engine.sess = _SpeedAsFloat(engine.sess)
    return engine


def list_voices(engine: Kokoro) -> list[str]:
    return sorted(engine.get_voices())


def synthesize(engine: Kokoro, text: str, voice: str, speed: float) -> np.ndarray:
    """Loudness-matched float32 mono samples at SR for the whole text."""
    gap = np.zeros(int(SR * GAP_SECONDS), dtype=np.float32)
    parts: list[np.ndarray] = []
    for chunk in split_chunks(text):
        samples, _ = engine.create(chunk, voice=voice, speed=speed, lang="en-us")
        parts.append(np.asarray(samples, dtype=np.float32).reshape(-1))
        parts.append(gap)
    audio = np.concatenate(parts[:-1]) if parts else np.zeros(0, dtype=np.float32)
    return audio * np.float32(loudness_gain(audio))


def to_pcm16(samples: np.ndarray) -> bytes:
    return (samples * 32767).clip(-32768, 32767).astype("<i2").tobytes()


def render(engine: Kokoro, request: dict) -> tuple[bytes, float]:
    """Synthesize one validated request. Returns (16-bit PCM, seconds)."""
    samples = synthesize(engine, request["text"], request["voice"], request["speed"])
    return to_pcm16(samples), len(samples) / SR
