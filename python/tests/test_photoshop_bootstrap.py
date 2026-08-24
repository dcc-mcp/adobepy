from __future__ import annotations

import copy
import json
import unittest
import urllib.request
from unittest import mock

from adobe.core import (
    BrokerClient,
    PhotoshopBootstrapRequest,
    PhotoshopBootstrapResult,
)

REQUEST = {
    "bootstrapVersion": 1,
    "target": "retouch",
    "timeoutMs": 7000,
    "host": {
        "executablePath": "C:/Program Files/Adobe/Adobe Photoshop 2026/Photoshop.exe",
        "executableBytes": 123456,
        "executableSha256": "a" * 64,
        "hostVersion": "27.0.1",
        "profileId": "production-profile",
    },
    "plugin": {
        "installedPluginRoot": "C:/UXP/External/com.adobepy.bridge.photoshop",
        "moduleOrigin": "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js",
        "bridgeVersion": "0.1.0",
        "manifestBytes": 640,
        "manifestSha256": "d" * 64,
        "indexBytes": 180,
        "indexSha256": "e" * 64,
        "moduleBytes": 47901,
        "moduleSha256": "f" * 64,
    },
}

RESULT = {
    "bootstrapVersion": 1,
    "status": "ready",
    "identityFingerprint": "b" * 64,
    "broker": {
        "pid": 4100,
        "processStartIdentity": "windows:133700000000000000",
        "runtimeVersion": "0.7.0",
        "instanceId": "76db1078-74c9-45c1-87e1-e8258649815e",
        "executableSha256": "c" * 64,
    },
    "host": {
        "pid": 4200,
        "processStartIdentity": "windows:133700000000000100",
        "hostVersion": "27.0.1",
        "profileId": "production-profile",
        "executableSha256": "a" * 64,
    },
    "plugin": {
        "instanceId": "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
        "bridgeVersion": "0.1.0",
        "moduleSha256": "f" * 64,
    },
    "continuation": {
        "method": "POST",
        "path": "/v1/photoshop/bootstrap/verify",
        "receiptId": "5449d2f9-f9a2-4445-9f97-43b8c2d47f2e",
        "timeoutMs": 7000,
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


class PhotoshopBootstrapTests(unittest.TestCase):
    def test_request_and_result_are_strict_bounded_and_secret_free(self):
        request = PhotoshopBootstrapRequest.from_mapping(REQUEST)
        self.assertEqual(request.to_wire(), REQUEST)
        result = PhotoshopBootstrapResult.from_broker(RESULT)
        self.assertEqual(result.to_wire(), RESULT)
        rendered = json.dumps(result.to_wire()).lower()
        self.assertNotIn("token", rendered)
        self.assertNotIn("executablepath", rendered)
        self.assertNotIn("pluginroot", rendered)

        malformed = copy.deepcopy(REQUEST)
        malformed["unexpected"] = True
        with self.assertRaises(ValueError):
            PhotoshopBootstrapRequest.from_mapping(malformed)
        malformed = copy.deepcopy(RESULT)
        malformed["host"]["executableSha256"] = "not-a-digest"
        with self.assertRaises(ValueError):
            PhotoshopBootstrapResult.from_broker(malformed)

    def test_client_uses_authenticated_fixed_endpoints_and_exact_continuation(self):
        captured = []

        def fake_urlopen(request, timeout=None):
            captured.append(
                {
                    "url": request.full_url,
                    "payload": json.loads(request.data.decode("utf-8")),
                    "headers": dict(request.header_items()),
                    "timeout": timeout,
                }
            )
            return FakeResponse(RESULT)

        client = BrokerClient(
            "http://broker.test", token="top-secret", target="retouch", timeout=8
        )
        request = PhotoshopBootstrapRequest.from_mapping(REQUEST)
        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            bootstrap = client.bootstrap_photoshop_uxp(request)
            verified = client.verify_photoshop_bootstrap(bootstrap.continuation)

        self.assertEqual(bootstrap, verified)
        self.assertEqual(
            captured[0]["url"], "http://broker.test/v1/photoshop/bootstrap"
        )
        self.assertEqual(captured[0]["payload"], REQUEST)
        self.assertEqual(
            captured[1]["url"],
            "http://broker.test/v1/photoshop/bootstrap/verify",
        )
        self.assertEqual(
            captured[1]["payload"], {"receiptId": RESULT["continuation"]["receiptId"]}
        )
        self.assertNotIn(
            "top-secret", json.dumps([item["payload"] for item in captured])
        )
        self.assertTrue(
            all(item["headers"]["X-adobepy-token"] == "top-secret" for item in captured)
        )
        self.assertTrue(all(item["timeout"] == 8 for item in captured))

    def test_forged_or_path_leaking_broker_results_fail_closed(self):
        forged = copy.deepcopy(RESULT)
        forged["continuation"]["path"] = "/v1/rpc"
        with self.assertRaises(ValueError):
            PhotoshopBootstrapResult.from_broker(forged)

        leaking = copy.deepcopy(RESULT)
        leaking["plugin"]["moduleOrigin"] = "C:/forged/main.js"
        with self.assertRaises(ValueError):
            PhotoshopBootstrapResult.from_broker(leaking)

    def test_client_rejects_well_shaped_but_foreign_bootstrap_identity(self):
        forged = copy.deepcopy(RESULT)
        forged["host"]["profileId"] = "foreign-profile"

        client = BrokerClient(
            "http://broker.test", token="top-secret", target="retouch"
        )
        request = PhotoshopBootstrapRequest.from_mapping(REQUEST)
        patched = mock.patch.object(
            urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(forged)
        )
        with patched, self.assertRaisesRegex(ValueError, "identity does not match"):
            client.bootstrap_photoshop_uxp(request)

    def test_client_rejects_verify_response_for_a_different_receipt(self):
        forged = copy.deepcopy(RESULT)
        forged["continuation"]["receiptId"] = "ab3cf4b0-2ea2-4493-8a73-00f49e04d0c9"

        client = BrokerClient(
            "http://broker.test", token="top-secret", target="retouch"
        )
        continuation = PhotoshopBootstrapResult.from_broker(RESULT).continuation
        patched = mock.patch.object(
            urllib.request, "urlopen", lambda *_args, **_kwargs: FakeResponse(forged)
        )
        with patched, self.assertRaisesRegex(ValueError, "continuation does not match"):
            client.verify_photoshop_bootstrap(continuation)


if __name__ == "__main__":
    unittest.main()
