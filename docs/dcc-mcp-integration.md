# DCC MCP Integration

`adobepy` is the Adobe communication layer for DCC MCP adapters. The adapter
continues to own MCP server startup, skill discovery, and tool naming; adobepy
owns broker sessions, capability checks, and Adobe host RPC.

## Ownership Model

| Component | Owns | Does not own |
| --- | --- | --- |
| DCC MCP adapter | MCP HTTP server, skill lifecycle, DCC-specific tool names, user-facing prompts | Broker routing, Adobe protocol internals |
| `adobepy` broker | Local RPC endpoint, token validation, target/session routing, timeouts, capabilities | MCP tool registration, Photoshop-only behavior |
| UXP/CEP bridge | Host DOM calls, `batchPlay`, ExtendScript dispatch, capability advertisement | MCP result format, Python skill execution |
| Python facade | `from adobe.photoshop import Photoshop`, Pythonic aliases, typed host sessions | Adapter process lifetime |

This keeps Photoshop-specific behavior in `adobe.photoshop` and the Photoshop
bridge template. Shared protocol and broker modules must remain Adobe-host
neutral.

## Startup Contract

Use environment variables for the handoff between the DCC MCP server process and
skill scripts:

| Variable | Purpose |
| --- | --- |
| `ADOBEPY_BROKER_URL` | Local broker URL, for example `http://127.0.0.1:8766`. |
| `ADOBEPY_TOKEN` | Per-session token required by the broker. |
| `ADOBEPY_TARGET` | Optional target name when multiple host bridge sessions are connected. Defaults to `default`. |

Recommended lifecycle:

1. The DCC MCP adapter starts or discovers the MCP HTTP server.
2. The adapter starts `adobepy broker` or receives a broker URL/token from the
   parent process.
3. The UXP/CEP bridge connects to the broker and advertises capabilities.
4. Skill scripts construct host sessions with `Photoshop()` or
   `connect("photoshop")`.
5. Skill scripts return DCC MCP results through `adobe.dcc_mcp`.

The broker port is separate from the MCP server port. The MCP server should not
proxy raw WebSocket messages; it should call the Python facade.

For `dcc-mcp-photoshop`, this replaces the adapter-owned
`PhotoshopBridge` WebSocket server and `get_bridge().call("ps.*")` RPC dialect.
The UXP plugin becomes an `adobepy` bridge client, the broker owns the
JSON-RPC/capability contract, and skill code uses `Photoshop()` sessions.

Recommended dependency change:

```toml
dependencies = [
    "adobepy>=0.1.0",
    "dcc-mcp-core>=0.12.29,<1.0.0",
]
```

## Migrating dcc-mcp-photoshop

Current skill shape:

```python
from dcc_mcp_photoshop.api import get_bridge, ps_success


def list_layers(**kwargs):
    bridge = get_bridge()
    layers = bridge.call("ps.listLayers")
    return ps_success("Listed layers", layers=layers)
```

adobepy-backed shape:

```python
from adobe.dcc_mcp import action_result
from adobe.photoshop import Photoshop


def list_layers(**kwargs):
    app = Photoshop()
    return action_result(
        "Listed active Photoshop layers",
        lambda: {"layers": [layer.name for layer in app.activeLayers]},
        prompt="Use the layer names in the next Photoshop operation.",
    )
```

Helper mapping:

| Existing `dcc-mcp-photoshop` helper | adobepy replacement |
| --- | --- |
| `get_bridge().call("ps.listLayers")` | `Photoshop().activeLayers` or `Photoshop().activeDocument.layers` |
| `get_bridge().call("ps.executeScript")` | `Photoshop().eval_js(...)` or `adobe.raw.eval_js("photoshop", ...)` |
| `ps_success(...)` | `adobe.dcc_mcp.adobe_success(...)` or `action_result(...)` |
| `ps_error(...)` / `ps_from_exception(...)` | `adobe_error(...)` / `adobe_exception(...)` |
| `with_photoshop` | `with_adobe("Photoshop skill failed")` |

Before calling a method family that may depend on bridge version, gate it with
capabilities instead of probing private bridge state:

```python
from adobe.dcc_mcp import action_result
from adobe.photoshop import Photoshop


def list_layers(**kwargs):
    app = Photoshop()
    app.require_method("document", "getActiveLayers")
    return action_result(
        "Listed active Photoshop layers",
        lambda: {"layers": [layer.name for layer in app.activeLayers]},
    )
```

For lower-level calls that are not covered by the facade yet, keep the escape
hatch explicit:

```python
from adobe.dcc_mcp import action_result
from adobe.photoshop import Photoshop


def raw_batch_play(**kwargs):
    app = Photoshop()
    return action_result(
        "Ran Photoshop batchPlay",
        lambda: {"result": app.batch_play([{"_obj": "hide"}], modal=True)},
    )
```

## Error Mapping

`adobe.dcc_mcp` tries to import `dcc_mcp_core.skill` at call time. When
`dcc-mcp-core` is installed, the helpers return the same skill result dicts as
`skill_success`, `skill_error`, and `skill_exception`. Without it, they return a
compatible plain dict so tests and docs can run without a DCC runtime.

Keep the compatibility layer optional: `adobepy` must not require
`dcc-mcp-core` at import time, and DCC MCP adapters should continue to own MCP
server lifecycle, tool naming, and skill discovery.

Known adobepy errors are mapped under `context["adobepy"]`:

```python
{
    "success": False,
    "message": "Adobe operation failed",
    "error": "BrokerConnectionError('broker down')",
    "context": {
        "adobepy": {
            "error_type": "BrokerConnectionError",
            "error_code": None,
            "retryable": True
        },
        "possible_solutions": ["Start the adobepy broker and verify ADOBEPY_BROKER_URL."]
    }
}
```

Use `adobe_error_context(exc)` directly when an adapter wants to merge adobepy
diagnostics into an existing result helper.

## Test Pattern

Mock integration tests should inject a fake `BrokerClient` into the facade
instead of launching Photoshop:

```python
from adobe.dcc_mcp import action_result
from adobe.photoshop import Photoshop


class FakeClient:
    target = "default"

    def call(self, host, namespace, method, args=None, options=None, target=None):
        if namespace == "document" and method == "getActive":
            return {"id": 1, "name": "Mock.psd"}
        if namespace == "document" and method == "getActiveLayers":
            return [{"id": 11, "name": "Hero"}]
        return {"ok": True}


def test_list_layers_skill():
    app = Photoshop(client=FakeClient())
    result = action_result(
        "Listed active Photoshop layers",
        lambda: {"layers": [layer.name for layer in app.activeLayers]},
    )
    assert result["success"]
    assert result["context"]["layers"] == ["Hero"]
```

This proves the adapter-facing skill path without requiring Photoshop,
UXP Developer Tool, or a broker process in CI.
