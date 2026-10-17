import os
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import helpers  # noqa: F401
from agentsay import client


class RuntimeDirTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory(dir="/tmp")
        self.base = Path(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def private_dir(self, name="agent-say"):
        d = self.base / name
        d.mkdir()
        os.chmod(d, 0o700)
        return d

    def test_accepts_private_directory_we_own(self):
        d = self.private_dir()
        client.verify_runtime_dir(d / "daemon.sock")

    def test_creates_missing_directory_with_mode_0700(self):
        d = self.base / "agent-say"
        client.verify_runtime_dir(d / "daemon.sock")
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o700)

    def test_rejects_group_or_world_readable_directory(self):
        d = self.private_dir()
        os.chmod(d, 0o755)
        with self.assertRaises(PermissionError):
            client.verify_runtime_dir(d / "daemon.sock")
        self.assertEqual(os.stat(d).st_mode & 0o777, 0o755, "a foreign-mode dir must not be chmod-ed")

    def test_rejects_symlink_to_private_directory(self):
        target = self.private_dir("real")
        link = self.base / "agent-say"
        os.symlink(target, link)
        with self.assertRaises(PermissionError):
            client.verify_runtime_dir(link / "daemon.sock")

    def test_rejects_directory_owned_by_another_uid(self):
        d = self.private_dir()
        with mock.patch.object(client.os, "getuid", return_value=os.getuid() + 1), \
                self.assertRaises(PermissionError):
            client.verify_runtime_dir(d / "daemon.sock")

    def test_is_listening_refuses_unsafe_dir_without_connecting(self):
        d = self.private_dir()
        path = d / "daemon.sock"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(path))
        server.listen(1)
        try:
            self.assertTrue(client.is_listening(path))
            os.chmod(d, 0o755)
            self.assertFalse(client.is_listening(path))
        finally:
            server.close()

    def test_send_refuses_unsafe_dir(self):
        d = self.private_dir()
        os.chmod(d, 0o755)
        with self.assertRaises(PermissionError):
            client.send({"op": "status"}, path=d / "daemon.sock")


if __name__ == "__main__":
    unittest.main()
