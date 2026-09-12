#!/usr/bin/env python3
"""Render a short audition line for every US-English Kokoro voice (af_*/am_*)."""
import os, re, wave
from pathlib import Path
import torch
from huggingface_hub import list_repo_files

BASE = Path(os.environ["HF_HOME"])
OUT = Path(__file__).parent
LINE = "How do I sound? I am your agent's voice, running entirely on this machine."

def us_voices() -> list[str]:
    names: list[str] = []
    for f in list_repo_files("hexgrad/Kokoro-82M"):
        m = re.fullmatch(r"voices/(a[fm]_[a-z]+)\.pt", f)
        if m:
            names.append(m.group(1))
    return sorted(names)


voices = us_voices()
print(f"{len(voices)} US voices: {', '.join(voices)}", flush=True)

from kokoro import KPipeline
p = KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device="cpu")

for i, v in enumerate(voices, 1):
    chunks: list[torch.Tensor] = [r.audio for r in p(LINE, voice=v) if r.audio is not None]
    a = (torch.cat(chunks).float().cpu().numpy() * 32767).clip(-32768, 32767).astype("<i2")
    path = OUT / f"{i:02d}-{v}.wav"
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000)
        w.writeframes(a.tobytes())
    print(f"[{i:02d}] {v:<12} {len(a)/24000:.1f}s -> {path.name}", flush=True)
