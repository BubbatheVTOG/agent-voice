import unittest

import helpers  # noqa: F401
from agentsay import protocol


def request(**overrides):
    base = {"op": "say", "text": "hello", "voice": "af_aoede", "speed": 1.2, "out": None,
            "owner": "pi-1"}
    return {**base, **overrides}


class ProtocolTest(unittest.TestCase):
    def test_round_trip(self):
        message = {"op": "status"}
        self.assertEqual(protocol.decode(protocol.encode(message).rstrip(b"\n")), message)

    def test_rejects_non_object_and_malformed(self):
        with self.assertRaises(protocol.ProtocolError):
            protocol.decode(b"[1, 2]")
        with self.assertRaises(protocol.ProtocolError):
            protocol.decode(b"{nope")

    def test_validate_accepts_good_say(self):
        checked = protocol.validate_say(request())
        self.assertEqual(checked["speed"], 1.2)
        self.assertEqual(checked["owner"], "pi-1")

    def test_say_requires_owner(self):
        without = {k: v for k, v in request().items() if k != "owner"}
        for owner in ("", None, 7, ["pi-1"]):
            with self.subTest(owner=owner), self.assertRaises(protocol.ProtocolError):
                protocol.validate_say(request(owner=owner))
        with self.assertRaises(protocol.ProtocolError):
            protocol.validate_say(without)

    def test_cancel_requires_non_empty_owner(self):
        self.assertEqual(protocol.validate_owner({"op": "cancel", "owner": "pi-1"}), "pi-1")
        for message in ({"op": "cancel"}, {"op": "cancel", "owner": ""}, {"owner": 3}):
            with self.subTest(message=message), self.assertRaises(protocol.ProtocolError):
                protocol.validate_owner(message)
        self.assertEqual(protocol.cancel_request("pi-1"), {"op": "cancel", "owner": "pi-1"})

    def test_validate_rejects_bad_fields(self):
        bad = [
            request(text="   "),
            request(text="x" * (protocol.MAX_TEXT_CHARS + 1)),
            request(voice=""),
            request(speed=0),
            request(speed=-1.0),
            request(speed=True),
            request(out="relative/path.wav"),
        ]
        for message in bad:
            with self.subTest(message=message), self.assertRaises(protocol.ProtocolError):
                protocol.validate_say(message)

    def test_say_request_resolves_out_to_absolute(self):
        message = protocol.say_request("hi", "af_aoede", 1.2, "some/relative.wav", "pi-1")
        self.assertTrue(message["out"].startswith("/"))
        self.assertEqual(message["owner"], "pi-1")


if __name__ == "__main__":
    unittest.main()
