from __future__ import annotations

import copy
import unittest
from unittest import mock

from adobe.core import (
    BrokerClient,
    IllustratorBootstrapRequest,
)

REQUEST = {
    "bootstrapVersion": 1,
    "target": "illustration",
    "timeoutMs": 2_000,
    "host": {
        "executablePath": "C:/Program Files/Adobe/Adobe Illustrator 2026/Support Files/Contents/Windows/Illustrator.exe",
        "executableBytes": 1024,
        "executableSha256": "a" * 64,
        "hostVersion": "30.0.0",
        "profileId": "illustrator-production",
    },
    "plugin": {
        "installedPluginRoot": "C:/Users/Public/Adobe/CEP/extensions/com.adobepy.bridge.illustrator",
        "moduleOrigin": "C:/Users/Public/Adobe/CEP/extensions/com.adobepy.bridge.illustrator/dist/main.js",
        "bridgeVersion": "0.1.0",
        "manifestBytes": 512,
        "manifestSha256": "b" * 64,
        "indexBytes": 256,
        "indexSha256": "c" * 64,
        "moduleBytes": 4096,
        "moduleSha256": "d" * 64,
    },
}

RESULT = {
    "bootstrapVersion": 1,
    "status": "ready",
    "identityFingerprint": "e" * 64,
    "broker": {
        "pid": 100,
        "processStartIdentity": "windows:1000",
        "runtimeVersion": "0.8.0",
        "instanceId": "5449d2f9-f9a2-4445-9f97-43b8c2d47f2e",
        "executableSha256": "f" * 64,
    },
    "host": {
        "pid": 200,
        "processStartIdentity": "windows:2000",
        "hostVersion": "30.0.0",
        "profileId": "illustrator-production",
        "instanceId": "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
        "executableSha256": "a" * 64,
    },
    "plugin": {
        "target": "illustration",
        "connectedAtEpochMs": 1_775_000_000_000,
        "instanceId": "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
        "bridgeVersion": "0.1.0",
        "moduleSha256": "d" * 64,
    },
    "continuation": {
        "method": "POST",
        "path": "/v1/illustrator/bootstrap/verify",
        "receiptId": "b8a7d1e0-b855-4b73-9e29-8b76e6bd670c",
        "timeoutMs": 2_000,
    },
    "adapterContinuation": {
        "kind": "command",
        "argv": ["dcc-mcp-illustrator", "verify", "--json"],
    },
}


class IllustratorBootstrapContractTests(unittest.TestCase):
    def test_client_uses_only_fixed_bootstrap_and_receipt_verification(self):
        request = IllustratorBootstrapRequest.from_mapping(REQUEST)
        responses = [copy.deepcopy(RESULT), copy.deepcopy(RESULT)]
        captured: list[tuple[str, dict[str, object]]] = []

        def post(path: str, payload: dict[str, object]):
            captured.append((path, payload))
            return responses.pop(0)

        client = BrokerClient(broker_url="http://broker.test", token="PRIVATE_TOKEN")
        with mock.patch.object(client, "_post_json", side_effect=post):
            result = client.bootstrap_illustrator_cep(request)
            verified = client.verify_illustrator_bootstrap(result.continuation)

        self.assertEqual(result, verified)
        self.assertEqual(captured[0], ("/v1/illustrator/bootstrap", request.to_wire()))
        self.assertEqual(
            captured[1],
            (
                "/v1/illustrator/bootstrap/verify",
                {"receiptId": RESULT["continuation"]["receiptId"]},
            ),
        )
        self.assertNotIn("PRIVATE_TOKEN", repr(result))
        self.assertNotIn(REQUEST["host"]["executablePath"], repr(result))
        self.assertEqual(
            result.adapter_continuation.argv,
            ("dcc-mcp-illustrator", "verify", "--json"),
        )
        self.assertEqual(result.plugin.target, request.target)
        self.assertGreater(result.plugin.connected_at_epoch_ms, 0)
        self.assertEqual(result.host.instance_id, result.plugin.instance_id)

    def test_request_rejects_nonfixed_module_origin(self):
        forged = copy.deepcopy(REQUEST)
        forged["plugin"]["moduleOrigin"] = "C:/foreign/shadow.js"
        with self.assertRaisesRegex(ValueError, "fixed Illustrator bridge module"):
            IllustratorBootstrapRequest.from_mapping(forged)

    def test_result_rejects_a_different_request_or_continuation(self):
        request = IllustratorBootstrapRequest.from_mapping(REQUEST)
        wrong = copy.deepcopy(RESULT)
        wrong["plugin"]["moduleSha256"] = "0" * 64
        client = BrokerClient()
        patched = mock.patch.object(client, "_post_json", return_value=wrong)
        with patched, self.assertRaisesRegex(ValueError, "exact request"):
            client.bootstrap_illustrator_cep(request)

        continuation = copy.deepcopy(RESULT)
        continuation["continuation"]["path"] = "/v1/rpc"
        patched = mock.patch.object(client, "_post_json", return_value=continuation)
        with patched, self.assertRaisesRegex(ValueError, "fixed verification"):
            client.bootstrap_illustrator_cep(request)


if __name__ == "__main__":
    unittest.main()
