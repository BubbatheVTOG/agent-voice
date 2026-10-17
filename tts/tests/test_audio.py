import math
import tempfile
import unittest
import wave
from pathlib import Path

import helpers  # noqa: F401
from agentsay import audio


class SplitChunksTest(unittest.TestCase):
    def test_splits_at_sentence_ends(self):
        self.assertEqual(
            audio.split_chunks("First one. Second one! Third?"),
            ["First one.", "Second one!", "Third?"],
        )

    def test_wraps_long_sentence_on_word_boundaries(self):
        words = " ".join(f"word{i}" for i in range(200))
        chunks = audio.split_chunks(words, limit=60)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(all(len(c) <= 60 for c in chunks))
        self.assertEqual(" ".join(chunks), words)

    def test_blank_input_yields_no_chunks(self):
        self.assertEqual(audio.split_chunks("   "), [])


class LoudnessGainTest(unittest.TestCase):
    def test_hot_render_is_pulled_down_to_target(self):
        samples = [0.5 * math.sin(i / 3) for i in range(24000)]
        gain = audio.loudness_gain(samples)
        scaled = [x * gain for x in samples]
        rms = math.sqrt(sum(x * x for x in scaled) / len(scaled))
        self.assertAlmostEqual(rms, audio.TARGET_RMS, places=3)
        self.assertLessEqual(max(abs(x) for x in scaled), audio.PEAK_CEIL + 1e-9)

    def test_peak_cap_wins_over_rms_target(self):
        # Mostly quiet with one loud spike: RMS would ask for gain > 1, peak must cap it.
        samples = [0.01] * 2399 + [0.95]
        gain = audio.loudness_gain(samples)
        self.assertLessEqual(max(abs(x) for x in samples) * gain, audio.PEAK_CEIL + 1e-9)

    def test_silence_and_empty_are_unity(self):
        self.assertEqual(audio.loudness_gain([]), 1.0)
        self.assertEqual(audio.loudness_gain([0.0, 0.0]), 1.0)


class WriteWavTest(unittest.TestCase):
    def test_writes_16_bit_mono_at_sample_rate(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "out.wav"
            audio.write_wav(path, b"\x00\x01" * 100)
            with wave.open(str(path), "rb") as w:
                self.assertEqual(
                    (w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()),
                    (1, 2, audio.SR, 100),
                )


if __name__ == "__main__":
    unittest.main()
