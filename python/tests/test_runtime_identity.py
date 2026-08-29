from __future__ import annotations

import json
import unittest
import urllib.request
from unittest import mock

from adobe.core import (
    BrokerClient,
    HostSession,
    IdentityAmbiguousError,
    IdentityMismatchError,
    IdentityStaleError,
    IdentityUnavailableError,
    RuntimeIdentityAttestation,
)
from adobe.core.errors import error_from_rpc


IDENTITY = {
    "identityVersion": 1,
    "broker": {
        "pid": 4100,
        "processStartIdentity": "windows:133700000000000000",
        "executablePath": "C:/adobepy/adobepy.exe",
        "runtimeVersion": "0.1.0",
        "instanceId": "76db1078-74c9-45c1-87e1-e8258649815e",
    },
    "host": {
        "pid": 4200,
        "processStartIdentity": "windows:133700000000000100",
        "executablePath": "C:/Adobe/Photoshop.exe",
        "hostVersion": "26.5.1",
        "profileId": "profile-production",
    },
    "bridge": {
        "target": "retouch",
        "bridgeKind": "uxp",
        "bridgeVersion": "0.1.0",
        "connectedAtEpochMs": 1720000000000,
        "instanceId": "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
        "installedPluginRoot": "C:/UXP/External/com.adobepy.bridge.photoshop",
        "moduleOrigin": "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js",
    },
}


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        return json.dumps(self.payload).encode("utf-8")


class RuntimeIdentityTests(unittest.TestCase):
    def test_typed_identity_roundtrip_is_bounded_and_secret_free(self):
        identity = RuntimeIdentityAttestation.from_broker(IDENTITY)
        self.assertEqual(identity.host.pid, 4200)
        self.assertEqual(identity.bridge.target, "retouch")
        self.assertEqual(identity.to_wire(), IDENTITY)
        self.assertNotIn("token", json.dumps(identity.to_wire()).lower())

        malformed = json.loads(json.dumps(IDENTITY))
        malformed["bridge"]["moduleOrigin"] = "x" * 32769
        with self.assertRaises(ValueError):
            RuntimeIdentityAttestation.from_broker(malformed)

    def test_client_posts_exact_expectation_without_token_in_payload(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["payload"] = json.loads(request.data.decode("utf-8"))
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return FakeResponse(IDENTITY)

        expected = RuntimeIdentityAttestation.from_broker(IDENTITY)
        client = BrokerClient("http://broker.test", token="top-secret", target="retouch", timeout=7)
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            actual = client.runtime_identity("photoshop", expected=expected)

        self.assertEqual(actual, expected)
        self.assertEqual(captured["url"], "http://broker.test/v1/runtime-identity")
        self.assertEqual(captured["payload"]["host"], "photoshop")
        self.assertEqual(captured["payload"]["target"], "retouch")
        self.assertEqual(captured["payload"]["expected"], IDENTITY)
        self.assertNotIn("top-secret", json.dumps(captured["payload"]))
        self.assertEqual(captured["headers"]["X-adobepy-token"], "top-secret")
        self.assertEqual(captured["timeout"], 7)

    def test_session_exposes_exact_host_identity(self):
        client = mock.Mock()
        client.target = "retouch"
        client.runtime_identity.return_value = RuntimeIdentityAttestation.from_broker(IDENTITY)
        identity = HostSession("photoshop", client).runtime_identity()
        self.assertEqual(identity.host.executable_path, "C:/Adobe/Photoshop.exe")
        client.runtime_identity.assert_called_once_with("photoshop", target="retouch", expected=None)

    def test_identity_failures_are_stable_typed_errors(self):
        cases = {
            -32010: IdentityUnavailableError,
            -32011: IdentityStaleError,
            -32012: IdentityAmbiguousError,
            -32013: IdentityMismatchError,
        }
        for code, expected_type in cases.items():
            with self.subTest(code=code):
                error = error_from_rpc({"code": code, "message": "identity rejected", "data": {"field": "host.pid"}})
                self.assertIsInstance(error, expected_type)
                self.assertEqual(error.data, {"field": "host.pid"})


if __name__ == "__main__":
    unittest.main()
