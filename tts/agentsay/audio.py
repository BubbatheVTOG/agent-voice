"""Pure audio helpers (stdlib only, so they run under the CI interpreter)."""

import math
import re
import subprocess
import wave
from pathlib import Path

SR = 24000  # Kokoro output sample rate
# Calibrated to the torch fp32 reference render of the same sentence (RMS 0.084).
# The ONNX q8 render measured RMS 0.129 / peak 0.93 without this, i.e. ~3.7 dB hot.
TARGET_RMS = 0.084
PEAK_CEIL = 0.9  # headroom so a loud render never clips
GAP_SECONDS = 0.15
MAX_CHUNK_CHARS = 300

_SENTENCE_END = re.compile(r"(?<=[.!?;:])\s+")


def split_chunks(text: str, limit: int = MAX_CHUNK_CHARS) -> list[str]:
    """Split text at sentence ends, then wrap long sentences on word boundaries.

    The engine truncates past its phoneme limit, so chunking keeps long
    announcements complete instead of silently cut.
    """
    chunks: list[str] = []
    for sentence in _SENTENCE_END.split(text.strip()):
        chunks.extend(_wrap_words(sentence, limit))
    return [c for c in chunks if c]


def _wrap_words(sentence: str, limit: int) -> list[str]:
    lines: list[str] = []
    current = ""
    for word in sentence.split():
        if current and len(current) + 1 + len(word) > limit:
            lines.append(current)
            current = word
        else:
            current = f"{current} {word}".strip()
    if current:
        lines.append(current)
    return lines


def loudness_gain(samples) -> float:
    """Gain that moves the utterance to TARGET_RMS without exceeding PEAK_CEIL."""
    n = len(samples)
    if n == 0:
        return 1.0
    energy = sum(x * x for x in samples)
    peak = max(abs(x) for x in samples)
    if energy == 0 or peak == 0:
        return 1.0
    rms = math.sqrt(energy / n)
    return min(TARGET_RMS / rms, PEAK_CEIL / peak)


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm)


def start_playback(wav_path: Path) -> subprocess.Popen:
    """Start paplay on the default sink. The caller owns the process."""
    return subprocess.Popen(["paplay", str(wav_path)])
