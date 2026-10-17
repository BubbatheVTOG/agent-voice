import tempfile
import threading
import unittest
from pathlib import Path

import helpers  # noqa: F401
from agentsay import client, daemon


class FakeProc:
    """Stands in for paplay: runs until terminated."""

    def __init__(self):
        self._done = threading.Event()
        self.terminated = False

    def wait(self):
        self._done.wait(5)
        return -15 if self.terminated else 0

    def poll(self):
        return 0 if self._done.is_set() else None

    def terminate(self):
        self.terminated = True
        self._done.set()

    def finish(self):
        self._done.set()


class Recorder:
    def __init__(self):
        self.procs = []
        self.renders = 0

    def playback(self, _wav):
        proc = FakeProc()
        self.procs.append(proc)
        return proc


def fake_render(recorder, gate=None):
    def render(request):
        recorder.renders += 1
        if gate is not None:
            gate.wait(5)
        return b"\x00\x00" * 10, 0.5

    return render


def say_request(**overrides):
    base = {"text": "hello", "voice": "af_aoede", "speed": 1.2, "out": None, "owner": "pi-a"}
    return {**base, **overrides}


class SpeakerTest(unittest.TestCase):
    def test_playback_runs_and_reports_ok(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        result = {}
        t = threading.Thread(target=lambda: result.update(speaker.say(say_request())))
        t.start()
        while not rec.procs:
            threading.Event().wait(0.01)
        rec.procs[0].finish()
        t.join(5)
        self.assertEqual(result, {"ok": True})

    def test_cancel_terminates_active_playback(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        result = {}
        t = threading.Thread(target=lambda: result.update(speaker.say(say_request())))
        t.start()
        while not rec.procs:
            threading.Event().wait(0.01)
        self.assertEqual(speaker.cancel("pi-a"), {"ok": True, "stopped": True, "count": 1})
        t.join(5)
        self.assertTrue(rec.procs[0].terminated)
        self.assertEqual(result, {"ok": True, "cancelled": True})

    def test_cancel_stops_only_its_owners_playback(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        threads = []
        for owner, expected in (("pi-a", 1), ("pi-b", 2)):
            # Start one at a time so rec.procs order is deterministic: pi-a's proc is first.
            t = threading.Thread(target=speaker.say, args=(say_request(owner=owner),))
            threads.append(t)
            t.start()
            while len(rec.procs) < expected:
                threading.Event().wait(0.01)
        self.assertEqual(speaker.cancel("pi-a"), {"ok": True, "stopped": True, "count": 1})
        a_proc, b_proc = rec.procs
        self.assertTrue(a_proc.terminated)
        self.assertFalse(b_proc.terminated, "owner A's cancel must not stop owner B")
        self.assertEqual(speaker.status()["playing"], True)
        self.assertEqual(speaker.cancel("pi-b"), {"ok": True, "stopped": True, "count": 1})
        for t in threads:
            t.join(5)
        self.assertTrue(b_proc.terminated)

    def test_cancel_drops_only_its_owners_queued_requests(self):
        rec = Recorder()
        gate = threading.Event()
        speaker = daemon.Speaker(fake_render(rec, gate), playback=rec.playback)
        results = {}
        with tempfile.TemporaryDirectory() as d:
            holder = threading.Thread(target=speaker.say, args=(
                say_request(owner="pi-c", out=str(Path(d) / "holder.wav")),))
            holder.start()
            while rec.renders == 0:
                threading.Event().wait(0.01)
            queued = [threading.Thread(target=lambda o=o: results.update(
                {o: speaker.say(say_request(owner=o))})) for o in ("pi-a", "pi-b")]
            for t in queued:
                t.start()
            threading.Event().wait(0.05)  # both queued on the synth lock
            speaker.cancel("pi-a")
            gate.set()
            holder.join(5)
            while not rec.procs:
                threading.Event().wait(0.01)  # owner B's request reached playback
            rec.procs[0].finish()
            for t in queued:
                t.join(5)
        self.assertEqual(results["pi-a"], {"ok": True, "cancelled": True})
        self.assertEqual(results["pi-b"], {"ok": True})
        self.assertEqual(rec.renders, 2, "owner A's queued request must not render; B's must")

    def test_cancel_drops_queued_request_before_render(self):
        rec = Recorder()
        gate = threading.Event()
        speaker = daemon.Speaker(fake_render(rec, gate), playback=rec.playback)
        first = threading.Thread(target=speaker.say, args=(say_request(text="first"),))
        second_result = {}
        first.start()
        while rec.renders == 0:
            threading.Event().wait(0.01)
        second = threading.Thread(
            target=lambda: second_result.update(speaker.say(say_request(text="second")))
        )
        second.start()
        threading.Event().wait(0.05)  # second is now queued on the synth lock
        speaker.cancel("pi-a")
        gate.set()
        first.join(5)
        second.join(5)
        self.assertEqual(rec.renders, 1, "queued request must not be rendered after cancel")
        self.assertEqual(second_result, {"ok": True, "cancelled": True})

    def test_file_output_bypasses_playback(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        with tempfile.TemporaryDirectory() as d:
            out = str(Path(d) / "x.wav")
            result = speaker.say(say_request(out=out))
            self.assertTrue(Path(out).exists())
        self.assertEqual(rec.procs, [])
        self.assertAlmostEqual(result["seconds"], 0.5)

    def test_idle_clock_resets_on_activity_and_not_while_playing(self):
        now = [0.0]
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback, clock=lambda: now[0])
        now[0] = 100.0
        self.assertEqual(speaker.idle_for(), 100.0)
        t = threading.Thread(target=speaker.say, args=(say_request(),))
        t.start()
        while not rec.procs:
            threading.Event().wait(0.01)
        self.assertEqual(speaker.idle_for(), 0.0)
        rec.procs[0].finish()
        t.join(5)
        now[0] = 150.0
        self.assertEqual(speaker.idle_for(), 50.0)


class OverlapTest(unittest.TestCase):
    def test_simultaneous_playbacks_overlap_and_cancel_stops_all(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        threads = [threading.Thread(target=speaker.say, args=(say_request(text=f"t{i}"),))
                   for i in range(2)]
        for t in threads:
            t.start()
        while len(rec.procs) < 2:
            threading.Event().wait(0.01)  # both playing at once, not queued
        self.assertEqual(speaker.status()["playing"], True)
        self.assertEqual(speaker.cancel("pi-a"), {"ok": True, "stopped": True, "count": 2})
        for t in threads:
            t.join(5)
        self.assertTrue(all(p.terminated for p in rec.procs))


class SocketRoundTripTest(unittest.TestCase):
    def test_status_and_cancel_over_real_socket(self):
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback)
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            path = Path(d) / "s.sock"
            server = daemon._Server(str(path), speaker)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertTrue(client.is_listening(path))
                status = client.send({"op": "status"}, path=path)
                self.assertTrue(status["ok"])
                self.assertEqual(
                    client.send({"op": "cancel", "owner": "pi-a"}, path=path)["stopped"], False)
                self.assertFalse(client.send({"op": "cancel"}, path=path)["ok"])
                bad = client.send({"op": "nonsense"}, path=path)
                self.assertFalse(bad["ok"])
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()


class IdleExitTest(unittest.TestCase):
    """The 5-minute idle exit, exercised with a fake clock instead of real waiting."""

    def test_watchdog_shuts_server_down_after_idle_threshold(self):
        now = [0.0]
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback, clock=lambda: now[0])
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            server = daemon._Server(str(Path(d) / "i.sock"), speaker)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            watchdog = threading.Thread(
                target=daemon._watchdog, args=(server, speaker, 300.0, 0.001), daemon=True
            )
            watchdog.start()
            now[0] = 299.0
            threading.Event().wait(0.05)
            self.assertTrue(serving.is_alive(), "must not exit before the idle threshold")
            now[0] = 301.0
            serving.join(5)
            self.assertFalse(serving.is_alive(), "must exit after the idle threshold")
            server.server_close()

    def test_watchdog_does_not_exit_while_playing(self):
        now = [0.0]
        rec = Recorder()
        speaker = daemon.Speaker(fake_render(rec), playback=rec.playback, clock=lambda: now[0])
        with tempfile.TemporaryDirectory(dir="/tmp") as d:
            server = daemon._Server(str(Path(d) / "p.sock"), speaker)
            serving = threading.Thread(target=server.serve_forever, daemon=True)
            serving.start()
            threading.Thread(
                target=daemon._watchdog, args=(server, speaker, 300.0, 0.001), daemon=True
            ).start()
            say = threading.Thread(target=speaker.say, args=(say_request(),))
            say.start()
            while not rec.procs:
                threading.Event().wait(0.01)
            now[0] = 10_000.0  # long past the threshold, but audio is still playing
            threading.Event().wait(0.05)
            self.assertTrue(serving.is_alive())
            rec.procs[0].finish()
            say.join(5)
            server.shutdown()
            server.server_close()
