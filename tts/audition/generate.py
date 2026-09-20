#!/usr/bin/env python3
"""Render a short audition line for every US-English Kokoro voice (af_*/am_*)."""

import os
import re
import sys
import wave
from pathlib import Path

# Pin model downloads inside the repo tree (same isolation as agent-say.py).
os.environ["HF_HOME"] = str(Path(__file__).resolve().parent.parent / "models")

OUT = Path(__file__).parent
LINE = "How do I sound? I am your agent's voice, running entirely on this machine."
SAMPLE_RATE = 24000


def us_voices() -> list[str]:
    from huggingface_hub import list_repo_files

    names: list[str] = []
    for filename in list_repo_files("hexgrad/Kokoro-82M"):
        match = re.fullmatch(r"voices/(a[fm]_[a-z]+)\.pt", filename)
        if match:
            names.append(match.group(1))
    return sorted(names)


def main() -> None:
    import torch
    from kokoro import KPipeline

    voices = us_voices()
    print(f"{len(voices)} US voices: {', '.join(voices)}", flush=True)
    pipeline = KPipeline(
        lang_code="a",
        repo_id="hexgrad/Kokoro-82M",
        device="cpu",
    )

    for index, voice in enumerate(voices, 1):
        chunks: list[torch.Tensor] = [
            result.audio
            for result in pipeline(LINE, voice=voice)
            if result.audio is not None
        ]
        if not chunks:
            print(
                f"[{index:02d}] {voice}: no audio produced, skipped",
                flush=True,
            )
            continue
        audio = (
            (torch.cat(chunks).float().cpu().numpy() * 32767)
            .clip(-32768, 32767)
            .astype("<i2")
        )
        path = OUT / f"{index:02d}-{voice}.wav"
        with wave.open(str(path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(SAMPLE_RATE)
            output.writeframes(audio.tobytes())
        print(
            f"[{index:02d}] {voice:<12} {len(audio) / SAMPLE_RATE:.1f}s -> {path.name}",
            flush=True,
        )


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        raise SystemExit(130) from None
    except Exception as error:
        raise SystemExit(f"error: {type(error).__name__}: {error}") from None
