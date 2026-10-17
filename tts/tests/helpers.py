"""Shared test setup: make the tts/ package importable without numpy or kokoro."""

import sys
from pathlib import Path

TTS_DIR = Path(__file__).resolve().parents[1]
if str(TTS_DIR) not in sys.path:
    sys.path.insert(0, str(TTS_DIR))
