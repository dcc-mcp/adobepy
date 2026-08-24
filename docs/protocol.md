# Adobe Host Protocol

`adobepy` exposes one adapter-facing Adobe host protocol for Python facades,
UXP bridges, CEP/ExtendScript bridges, the Rust broker, and downstream DCC MCP
adapters. Downstream adapters should depend on this contract instead of copying
Photoshop-specific WebSocket or JSON-RPC dialects.

The machine-readable source of truth is
`contracts/adobepy_protocol_contract.json`. CI verifies the Rust protocol
types, TypeScript bridge protocol types, and Python error classes with:

```powershell
npm run protocol:check
```

## Request Envelope

Client requests use JSON-RPC 2.0 over broker HTTP or WebSocket:

```json
{
  "jsonrpc": "2.0",
  "id": "py_1",
  "host": "photoshop",
  "target": "default",
  "namespace": "document",
  "method": "getActiveLayers",
  "args": [],
  "options": {
    "modal": false,
    "commandName": "List layers",
    "timeoutMs": 30000,
    "traceId": "trace-123"
  }
}
```

`host`, `namespace`, and `method` identify a bridge capability. `target`
selects one connected host session and defaults to `default`. `args` is always
an ordered array, even when a higher-level Python facade accepts keyword-style
objects.

## Bridge Hello And Capabilities

Every bridge must send a first WebSocket message:

```json
{
  "type": "hello",
  "token": "session-token",
  "target": "default",
  "capabilities": {
    "host": "photoshop",
    "bridgeKind": "uxp",
    "bridgeVersion": "0.1.0",
    "hostVersion": "26.0",
    "namespaces": ["app", "document"],
    "features": ["modal", "batchPlay"],
    "methods": {
      "document": ["getActive", "getActiveLayers"]
    }
  },
  "identity": {
    "host": {
      "pid": 4200,
      "processStartIdentity": "windows:133700000000000100",
      "executablePath": "C:/Adobe/Photoshop.exe",
      "hostVersion": "26.0",
      "profileId": "profile-production"
    },
    "bridge": {
      "instanceId": "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
      "installedPluginRoot": "C:/UXP/External/com.adobepy.bridge.photoshop",
      "moduleOrigin": "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js"
    }
  }
}
```

The broker registers sessions by `host:target`, then rejects calls whose
namespace or method is not advertised. Capability snapshots for Photoshop,
InDesign, Premiere, After Effects, and Illustrator are asserted by
`npm run capabilities:check` against the generated IR and API source registry.

Identity claims are optional for backward-compatible bridge connectivity, but
an incomplete claim can never produce an exact runtime attestation. The
Photoshop UXP bridge obtains its host version and installed plug-in/module
origin from the loaded host and UXP file-system APIs. It accepts PID,
process-start identity, executable path, and profile ID only from the bounded
adapter-owned `__ADOBEPY_HOST_IDENTITY` launch context. It does not guess these
values or use arbitrary execution or UI automation to discover them.

## Runtime Identity Attestation

Adapters request a complete authenticated identity over:

```http
POST /v1/runtime-identity
x-adobepy-token: <session token>
content-type: application/json

{"host":"photoshop","target":"default"}
```

The response binds the broker PID/start identity/executable/version/instance,
Photoshop PID/start identity/executable/version/profile, and UXP
target/kind/version/connection epoch/instance/plugin root/module origin. The
token is never part of the response. `BrokerClient.runtime_identity()` and
`Photoshop.runtime_identity()` return a typed `RuntimeIdentityAttestation`.

Install verification should construct an expected attestation from independent
OS process observations plus the owned install receipt and pass it back to the
broker:

```python
from adobe.photoshop import Photoshop

identity = Photoshop().runtime_identity(expected=expected_identity)
```

The broker compares every field. PID reuse or a changed connection epoch or
instance returns a stale error. A wrong executable, profile, target, plug-in
root, or module origin returns a mismatch error. Missing host facts return an
unavailable error, and an omitted target with multiple matching sessions
returns an ambiguous error. All identity fields are bounded and malformed
claims are rejected before registration.

## Responses

Successful bridge responses preserve the client-visible request id:

```json
{
  "jsonrpc": "2.0",
  "id": "py_1",
  "result": []
}
```

Failures use a JSON-RPC error object and may include diagnostics:

```json
{
  "jsonrpc": "2.0",
  "id": "py_1",
  "error": {
    "code": -32003,
    "message": "bridge does not support method document.getActiveLayers",
    "data": {
      "host": "photoshop",
      "namespace": "document",
      "method": "getActiveLayers"
    }
  },
  "diagnostics": {
    "hostVersion": "26.0",
    "bridge": "uxp",
    "durationMs": 12,
    "traceId": "trace-123"
  }
}
```

## Error Codes

| Code | Name | Meaning |
| --- | --- | --- |
| `-32700` | `ERROR_PARSE` | Invalid JSON or malformed WebSocket message. |
| `-32600` | `ERROR_INVALID_REQUEST` | JSON-RPC envelope or bridge hello is invalid. |
| `-32601` | `ERROR_METHOD_NOT_FOUND` | Bridge adapter does not implement a requested method. |
| `-32001` | `ERROR_HOST_NOT_RUNNING` | Host application is unavailable. |
| `-32002` | `ERROR_BRIDGE_NOT_INSTALLED` | No bridge session is connected, or it disconnected. |
| `-32003` | `ERROR_CAPABILITY` | Requested namespace or method is not advertised. |
| `-32004` | `ERROR_HOST_SCRIPT` | Host DOM, UXP, CEP, or ExtendScript execution failed. |
| `-32005` | `ERROR_PERMISSION` | Host or broker denied the operation. |
| `-32006` | `ERROR_MODAL_REQUIRED` | Mutating operation must run in modal context. |
| `-32007` | `ERROR_TIMEOUT` | Broker timed out while waiting for the bridge response. |
| `-32008` | `ERROR_SERIALIZATION` | Request or response could not be serialized. |
| `-32009` | `ERROR_UNAUTHORIZED` | Broker or bridge token is missing or invalid. |
| `-32010` | `ERROR_IDENTITY_UNAVAILABLE` | A complete runtime identity is unavailable. |
| `-32011` | `ERROR_IDENTITY_STALE` | PID/start, connection epoch, or instance identity changed. |
| `-32012` | `ERROR_IDENTITY_AMBIGUOUS` | Multiple sessions match without an exact target. |
| `-32013` | `ERROR_IDENTITY_MISMATCH` | Runtime identity differs from the expected receipt/OS observation. |

Python maps these codes to typed exceptions in `adobe.core.errors`, so DCC MCP
adapters can convert failures to their own `skill_error` or `from_exception`
shape without inspecting bridge internals.

## Authentication

All broker HTTP client calls use `x-adobepy-token`. Bridge WebSocket sessions
authenticate with the `token` field in the first `hello` message. A blank broker
token disables auth only for local development tests.

## Modal And Timeout Behavior

Mutating methods should expose `options.modal = true` or use a facade method
that sets it internally. UXP hosts should route those calls through
`executeAsModal`; CEP hosts should keep the behavior explicit in their
dispatcher. `options.timeoutMs` overrides the broker default for a single call.

## Compatibility Rules

Additive namespace, method, feature, and diagnostics fields are compatible.
Changing existing field names, error codes, or response envelope shapes is a
breaking change and requires a protocol version bump plus migration notes.

New facade methods must be capability-gated and should keep both Adobe
JavaScript-shaped names and Pythonic aliases when the upstream API is camelCase.
Raw JavaScript, ExtendScript, and `batchPlay` escape hatches remain explicit and
should not be required for documented MVP workflows.

Downstream DCC MCP adapters should call `adobepy` through the Python facades or
`adobe.raw` escape hatches. They should not open bridge WebSockets directly,
depend on generated bridge bundles, or duplicate the JSON-RPC dialect.
