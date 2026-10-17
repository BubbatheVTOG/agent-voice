import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

import helpers  # noqa: F401

_SPEC = importlib.util.spec_from_file_location(
    "agent_say_cli", Path(helpers.TTS_DIR) / "agent-say.py"
)
cli = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(cli)


class FallbackTest(unittest.TestCase):
    def test_disabled_by_env_never_contacts_daemon(self):
        args = mock.Mock(voice="af_aoede", speed=1.2, out=None, owner="cli")
        with mock.patch.dict(os.environ, {"AGENT_SAY_DAEMON": "0"}), \
                mock.patch.object(cli, "start_daemon") as start:
            self.assertIsNone(cli.request_via_daemon(args, "hi"))
            start.assert_not_called()

    def test_socket_failure_returns_none_so_cli_falls_back(self):
        args = mock.Mock(voice="af_aoede", speed=1.2, out=None, owner="cli")
        with mock.patch.dict(os.environ, {}, clear=False), \
                mock.patch.object(cli, "start_daemon", return_value=True), \
                mock.patch.object(cli.client, "send", side_effect=OSError("gone")):
            os.environ.pop("AGENT_SAY_DAEMON", None)
            self.assertIsNone(cli.request_via_daemon(args, "hi"))


if __name__ == "__main__":
    unittest.main()
