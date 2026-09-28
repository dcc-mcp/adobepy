import os
import subprocess
import tempfile
import unittest
import urllib.error
from unittest import mock

from adobe.runtime import (
    BrokerHandle,
    _healthy,
    _missing_broker_error,
    _resolve_executable,
    ensure_broker,
)


class RuntimeTests(unittest.TestCase):
    def test_ensure_broker_reuses_healthy_process(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.runtime._healthy", return_value=True
        ), mock.patch("adobe.runtime.subprocess.Popen") as popen:
            handle = ensure_broker(token="test-token")
            self.assertEqual(os.environ["ADOBEPY_TOKEN"], "test-token")
        self.assertIsNone(handle.process)
        popen.assert_not_called()

    def test_ensure_broker_starts_and_owns_missing_process(self):
        with tempfile.NamedTemporaryFile(suffix=".exe") as executable:
            process = mock.Mock()
            process.poll.return_value = None
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
                "adobe.runtime._healthy", side_effect=[False, True]
            ), mock.patch("adobe.runtime.subprocess.Popen", return_value=process):
                handle = ensure_broker(broker_path=executable.name, token="test-token")
        handle.stop()
        process.terminate.assert_called_once()

    def test_invalid_or_missing_broker_fails_fast(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.runtime._healthy", return_value=False
        ), mock.patch("adobe.runtime._resolve_executable", return_value=None):
            with self.assertRaises(FileNotFoundError):
                ensure_broker()
        with tempfile.NamedTemporaryFile(suffix=".exe") as executable, mock.patch(
            "adobe.runtime._healthy", return_value=False
        ):
            with self.assertRaises(ValueError):
                ensure_broker(broker_url="https://example.com:443", broker_path=executable.name)

    def test_missing_broker_error_names_the_runtime_bundle(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.runtime._healthy", return_value=False
        ), mock.patch("adobe.runtime._resolve_executable", return_value=None):
            with self.assertRaises(FileNotFoundError) as raised:
                ensure_broker()
        message = str(raised.exception)
        self.assertIn("adobepy broker executable not found", message)
        self.assertIn("ADOBEPY_BROKER_PATH", message)
        self.assertIn("https://github.com/dcc-mcp/adobepy/releases/latest", message)

    def test_owned_broker_is_killed_after_shutdown_timeout(self):
        process = mock.Mock()
        process.poll.return_value = None
        process.wait.side_effect = [subprocess.TimeoutExpired("adobepy", 1), None]
        BrokerHandle("http://127.0.0.1:47391", "token", process).stop(timeout=1)
        process.kill.assert_called_once()

    def test_resolution_delegates_to_the_shared_cli_discovery(self):
        with tempfile.NamedTemporaryFile(suffix=".exe") as executable, mock.patch.dict(
            os.environ, {"ADOBEPY_BROKER_PATH": executable.name}, clear=True
        ):
            self.assertEqual(_resolve_executable(), executable.name)
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.cli.shutil.which", return_value=None
        ):
            self.assertIsNone(_resolve_executable())
            self.assertIn("adobepy broker executable not found", str(_missing_broker_error()))

    def test_health_maps_http_and_connection_results(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        with mock.patch("adobe.runtime.urllib.request.urlopen", return_value=response):
            self.assertTrue(_healthy("http://127.0.0.1:47391"))
        with mock.patch(
            "adobe.runtime.urllib.request.urlopen", side_effect=urllib.error.URLError("down")
        ):
            self.assertFalse(_healthy("http://127.0.0.1:47391"))


if __name__ == "__main__":
    unittest.main()
