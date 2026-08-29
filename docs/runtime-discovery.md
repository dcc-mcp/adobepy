# Runtime Discovery Contract

This document defines how a DCC MCP adapter (e.g. `dcc-mcp-photoshop`)
discovers, starts, and manages the `adobepy` broker process.

---

## 1. Discovery Order

When a DCC MCP adapter needs to locate `adobepy.exe` (the broker CLI), it
**must** probe the following locations **in order**. It stops at the first hit.

| Priority | Mechanism | Example |
| --- | --- | --- |
| 1 | `ADOBEPY_BROKER_PATH` environment variable | `C:\tools\adobepy\bin\adobepy.exe` |
| 2 | `PATH` search | `where adobepy.exe` / `adobepy` on PATH |

### 1.1 Environment Variable: `ADOBEPY_BROKER_PATH`

Absolute path to the `adobepy.exe` binary, including the filename. When set,
the adapter **must** use this value directly and skip all subsequent discovery
steps.

```python
import os
import shutil


def resolve_adobepy_broker() -> str | None:
    explicit = os.environ.get("ADOBEPY_BROKER_PATH")
    if explicit and os.path.isfile(explicit):
        return explicit

    resolved = shutil.which("adobepy")
    if resolved:
        return resolved

    return None
```

### 1.2 PATH Search

If `ADOBEPY_BROKER_PATH` is not set, the adapter calls the platform equivalent
of `where adobepy.exe`. The standard Python API `shutil.which("adobepy")` is
sufficient.

When the release bundle is installed with `install.ps1 -AddToUserPath`, the
unpack directory's `bin\` is added to the user `PATH`, which makes `adobepy`
resolvable via `shutil.which()` in new terminal sessions.

---

## 2. Broker Startup

Adapters should reuse the Python helper, which implements discovery, health
polling, environment handoff, and owned-process shutdown:

```python
from adobe.runtime import ensure_broker

broker = ensure_broker()
try:
    ...
finally:
    broker.stop()
```

After locating `adobepy.exe`, the helper starts the broker as a child process.

Bootstrap work performed by the broker uses a different executable,
`adobepy-bootstrap-helper.exe`. It is an internal fixed sibling of
`adobepy.exe`: adapters must not discover, invoke, or override it independently.
The broker validates its canonical path and regular-file identity before use.

### 2.1 Command

```powershell
adobepy broker --token <token> [--bind 127.0.0.1:47391] [--default-timeout-ms 30000]
```

### 2.2 Arguments

| Argument | Default | Description |
| --- | --- | --- |
| `--bind` | `127.0.0.1:47391` | Local address to listen on. |
| `--token` | auto-generated UUID | Auth token for client and bridge connections. |
| `--default-timeout-ms` | `30000` | Default request timeout in milliseconds. |

The `adobepy broker` command prints the token to stderr on startup:

```
ADOBEPY_TOKEN=dev-<uuid>
```

Automated installers should pass the token through `ADOBEPY_TOKEN` or
`--token`; they must not assume `dev-token`.

### 2.3 Lifecycle Ownership

The DCC MCP adapter **owns** the broker process lifecycle. Specifically:

- The adapter spawns the broker as a managed subprocess.
- The adapter sends `Ctrl+C` (or terminates) on shutdown.
- The adapter must not start multiple broker instances for the same port.
- If the broker exits unexpectedly, the adapter may restart it.

### 2.4 Port Allocation

The default port is `47391`. If the adapter needs to use a different port, it
passes `--bind 127.0.0.1:<custom-port>`. The resulting broker URL must be
communicated to consuming code via the environment.

---

## 3. Health Check

The adapter verifies broker readiness by polling the health endpoint:

```http
GET http://127.0.0.1:47391/health
```

Expected response (HTTP 200):

```json
{
  "status": "ok",
  "sessions": 0,
  "protocol": "jsonrpc-2.0"
}
```

The adapter polls this endpoint with a 100 ms interval and a total timeout of
5 seconds before declaring the broker unhealthy.

Health proves only that an HTTP broker is listening. It does not prove that the
broker is the selected process or that a particular Photoshop/UXP session is
ready. Before reporting `directly_usable`, the adapter must call the
authenticated runtime identity endpoint and compare the result with independent
OS process observations and its owned install receipt. A missing
`__ADOBEPY_HOST_IDENTITY` launch context therefore remains fail-closed even when
`/health` and `/v1/capabilities` succeed.

### 3.1 After Effects CEP identity

The After Effects CEP hello includes a bounded `identity` claim. The broker
returns a typed attestation containing broker PID/start identity, signed host
executable path and version/profile, and CEP target, bridge version, connection
epoch, installed plugin root, and loaded module origin. `moduleOrigin` must be
`<installedPluginRoot>/dist/main.js`; path traversal, shadowed modules, stale
PID/start pairs, foreign product/profile, target, or connection epoch are
rejected with stable identity error codes (`-32010` through `-32013`).

No After Effects bootstrap endpoint is exposed until a host-specific launch,
receipt, and nonce transaction exists. Adapters must not treat CEP identity or
compile/package evidence as a bootstrap success signal.

---

## 4. Environment Variables for Consumer Handoff

Once the broker is running, the adapter exports these environment variables so
downstream Python code (skill scripts, facades) can discover and connect to the
broker:

| Variable | Required | Description |
| --- | --- | --- |
| `ADOBEPY_BROKER_URL` | Yes | Full broker URL, e.g. `http://127.0.0.1:47391` |
| `ADOBEPY_TOKEN` | Yes | The token printed by `adobepy broker` |
| `ADOBEPY_TARGET` | No | Target session name, defaults to `default` |
| `ADOBEPY_BROKER_PATH` | No | Path to the broker binary (for reference) |

The Python SDK reads these variables automatically when a facade is constructed
without explicit arguments:

```python
from adobe.photoshop import Photoshop

# Uses ADOBEPY_BROKER_URL, ADOBEPY_TOKEN, and ADOBEPY_TARGET from the environment
app = Photoshop()
```

---

## 5. Graceful Shutdown Sequence

1. Adapter stops sending new RPC requests.
2. Adapter sends `Ctrl+C` or `SIGTERM` to the broker process.
3. Adapter calls `GET /health` every 500 ms until the broker exits or a 5
   second timeout elapses.
4. If the broker does not exit within the timeout, the adapter force-kills the
   process.

---

## 6. Error Recovery

| Scenario | Adapter behavior |
| --- | --- |
| Broker not found | Log a clear error including all probed paths. Fail fast; do not start MCP server. |
| Broker exits during idle | Log warning; restart once with backoff (2 s delay). |
| Broker repeatedly crashes | Log error; surface through MCP server diagnostics; do not infinite-loop. |
| Port already in use | Log the conflicting process name if possible; fail with a clear message. |

---

## 7. install.ps1 Behavior

The `install.ps1` script bundled in the release archive has a limited scope:

1. Finds the first `*.whl` file in the `wheels/` directory.
2. Installs the wheel via `pip install --user --force-reinstall`.
3. If `-AddToUserPath` is passed, adds the archive's `bin\` directory to the
   user `PATH`.

It does **not** write registry keys, create versioned directories or junctions,
or automatically install bridge templates into Adobe plugin directories. Those
capabilities are out of scope for Phase 1.

The user is expected to extract the archive to a location of their choice and
run `install.ps1` from that extracted directory.
