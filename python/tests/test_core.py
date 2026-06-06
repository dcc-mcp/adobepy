import asyncio
import json
import os
import unittest
import urllib.error
import urllib.request
from unittest import mock

from adobe.core import BrokerClient, BrokerConnectionError, HostSession, UnauthorizedError, connect
from adobe.photoshop import Photoshop
from adobe.core.errors import BridgeNotInstalledError, CapabilityError, HostScriptError, MethodNotFoundError, error_from_rpc


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self):
        if isinstance(self.payload, bytes):
            return self.payload
        return json.dumps(self.payload).encode("utf-8")


class CapturingClient:
    target = "default"

    def __init__(self):
        self.calls = []
        self.async_calls = []

    def call(self, host, namespace, method, args=None, options=None, target=None):
        self.calls.append((host, namespace, method, list(args or []), options or {}, target))
        return {"ok": True}

    async def call_async(self, host, namespace, method, args=None, options=None, target=None):
        self.async_calls.append((host, namespace, method, list(args or []), options or {}, target))
        return {"ok": True}

    def capabilities(self):
        return [
            {
                "target": "default",
                "connectedAtEpochMs": 1,
                "capabilities": {
                    "host": "photoshop",
                    "bridgeKind": "uxp",
                    "bridgeVersion": "0.1.0",
                    "hostVersion": "26",
                    "namespaces": ["app"],
                    "features": ["version"],
                    "methods": {"app": ["getVersion"]},
                },
            }
        ]


class CoreTests(unittest.TestCase):
    def test_broker_client_posts_and_maps_errors(self):
        captured = {}

        def fake_urlopen(request, timeout=None):
            captured["url"] = request.full_url
            captured["payload"] = json.loads(request.data.decode())
            captured["headers"] = dict(request.header_items())
            captured["timeout"] = timeout
            return FakeResponse({"jsonrpc": "2.0", "id": captured["payload"]["id"], "result": 42})

        with mock.patch.object(urllib.request, "urlopen", fake_urlopen):
            result = BrokerClient("http://broker.test/", token="secret", target="retouch", timeout=7).call(
                "photoshop",
                "app",
                "getVersion",
                options={"timeoutMs": 5000, "traceId": "t1"},
                target="hero-doc",
            )

        self.assertEqual(result, 42)
        self.assertEqual(captured["url"], "http://broker.test/v1/rpc")
        self.assertEqual(captured["headers"]["X-adobepy-token"], "secret")
        self.assertEqual(captured["timeout"], 7)
        self.assertEqual(captured["payload"]["host"], "photoshop")
        self.assertEqual(captured["payload"]["target"], "hero-doc")
        self.assertEqual(captured["payload"]["options"], {"timeoutMs": 5000, "traceId": "t1"})

        with mock.patch.object(urllib.request, "urlopen", return_value=FakeResponse({"error": {"code": -32009, "message": "bad"}})):
            with self.assertRaises(UnauthorizedError):
                BrokerClient("http://broker.test").call("photoshop", "app", "getVersion")

        with mock.patch.object(urllib.request, "urlopen", return_value=FakeResponse({"error": {"code": -32601, "message": "missing"}})):
            with self.assertRaises(MethodNotFoundError):
                BrokerClient("http://broker.test").call("photoshop", "app", "missing")

        with mock.patch.object(
            urllib.request,
            "urlopen",
            return_value=FakeResponse({"error": {"code": -32002, "message": "bridge disconnected before response"}}),
        ):
            with self.assertRaises(BridgeNotInstalledError):
                BrokerClient("http://broker.test").call("photoshop", "app", "getVersion")

    def test_broker_client_connection_errors_and_headers(self):
        self.assertEqual(BrokerClient("http://x", token="")._headers(), {"Content-Type": "application/json"})
        with mock.patch.dict(os.environ, {"ADOBEPY_BROKER_URL": "http://env", "ADOBEPY_TOKEN": "tok"}):
            self.assertEqual(BrokerClient().broker_url, "http://env")
        with mock.patch.object(urllib.request, "urlopen", side_effect=urllib.error.URLError("refused")):
            with self.assertRaises(BrokerConnectionError):
                BrokerClient("http://broker.test").capabilities()
        with mock.patch.object(urllib.request, "urlopen", return_value=FakeResponse(b"no json")):
            with self.assertRaises(BrokerConnectionError):
                BrokerClient("http://broker.test").capabilities()

    def test_adobepy_target_env_var_in_broker_client(self):
        with mock.patch.dict(os.environ, {"ADOBEPY_TARGET": "env-target"}):
            client = BrokerClient()
            self.assertEqual(client.target, "env-target")

        with mock.patch.dict(os.environ, {"ADOBEPY_TARGET": "env-target"}):
            client = BrokerClient(target="explicit")
            self.assertEqual(client.target, "explicit")

    def test_adobepy_target_env_var_in_photoshop(self):
        with mock.patch.dict(os.environ, {"ADOBEPY_TARGET": "env-target"}):
            ps = Photoshop()
            self.assertEqual(ps.client.target, "env-target")

        with mock.patch.dict(os.environ, {"ADOBEPY_TARGET": "env-target"}):
            ps = Photoshop(target="explicit")
            self.assertEqual(ps.client.target, "explicit")

    def test_session_capabilities_and_raw(self):
        client = CapturingClient()
        session = HostSession("photoshop", client)
        self.assertEqual(session.capabilities().host, "photoshop")
        self.assertEqual(session.require_method("app", "getVersion").bridge_version, "0.1.0")
        with self.assertRaises(CapabilityError):
            session.require_method("raw", "evalJs")
        session.raw.eval_js("1")
        session.raw.eval_extendscript("2")
        session.raw.send_sdk_message({"kind": "x"})
        session.raw.batch_play([{"_obj": "hide"}])
        self.assertEqual(client.calls[-1][1], "action")

    def test_errors_and_connect(self):
        err = error_from_rpc({"code": -32004, "message": "boom"}, {"diagnostics": {"traceId": "t"}})
        self.assertIsInstance(err, HostScriptError)
        self.assertEqual(err.diagnostics, {"traceId": "t"})
        self.assertEqual(connect("premiere", broker_url="http://b", token="t").host, "premiere")


class CoreAsyncTests(unittest.IsolatedAsyncioTestCase):
    async def test_async_paths(self):
        client = CapturingClient()
        self.assertEqual(await HostSession("photoshop", client).invoke_async("app", "getVersion"), {"ok": True})
        broker = BrokerClient("http://broker.test")
        with mock.patch.object(broker, "call", return_value=1), mock.patch.object(broker, "capabilities", return_value=[]):
            self.assertEqual(await broker.call_async("photoshop", "app", "getVersion"), 1)
            self.assertEqual(await broker.capabilities_async(), [])


if __name__ == "__main__":
    unittest.main()
