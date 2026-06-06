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
| 3 | `InstallDir` registry key | See §1.3 |
| 4 | Well-known install directories | See §1.4 |

### 1.1 Environment Variable: `ADOBEPY_BROKER_PATH`

Absolute path to the `adobepy.exe` binary, including the filename. When set,
the adapter **must** use this value directly and skip all subsequent discovery
steps.

```python
import os
import shutil
import subprocess


def resolve_adobepy_broker() -> str | None:
    explicit = os.environ.get("ADOBEPY_BROKER_PATH")
    if explicit and os.path.isfile(explicit):
        return explicit

    resolved = shutil.which("adobepy")
    if resolved:
        return resolved

    # fall through to registry and well-known paths
    ...
```

### 1.2 PATH Search

If `ADOBEPY_BROKER_PATH` is not set, the adapter calls the platform equivalent
of `where adobepy.exe`. The standard Python API `shutil.which("adobepy")` is
sufficient.

### 1.3 Registry Key (Windows)

If the broker was installed via `install.ps1`, the following registry value is
set:

```
Key:   HKCU\Software\Adobe\adobepy
Value: InstallDir
Type:  REG_SZ
Data:  C:\Users\<user>\AppData\Local\adobepy
```

The adapter reads this key and appends `bin\adobepy.exe`:

```python
import os
import winreg


def find_broker_via_registry() -> str | None:
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Adobe\adobepy",
        ) as key:
            install_dir = winreg.QueryValueEx(key, "InstallDir")[0]
    except OSError:
        return None
    candidate = os.path.join(install_dir, "bin", "adobepy.exe")
    return candidate if os.path.isfile(candidate) else None
```

### 1.4 Well-Known Install Directories

If none of the above find the binary, the adapter checks these paths in order:

1. `%LOCALAPPDATA%\adobepy\bin\adobepy.exe`
2. `%ProgramFiles%\adobepy\bin\adobepy.exe`
3. `%ProgramFiles(x86)%\adobepy\bin\adobepy.exe`

```python
import os


def find_broker_via_wellknown() -> str | None:
    local = os.environ.get("LOCALAPPDATA", "")
    progfiles = os.environ.get("ProgramFiles", "")
    progfiles32 = os.environ.get("ProgramFiles(x86)", "")

    candidates = [
        os.path.join(local, "adobepy", "bin", "adobepy.exe"),
        os.path.join(progfiles, "adobepy", "bin", "adobepy.exe"),
        os.path.join(progfiles32, "adobepy", "bin", "adobepy.exe"),
    ]
    for candidate in candidates:
        if os.path.isfile(candidate):
            return candidate
    return None
```

---

## 2. Broker Startup

After locating `adobepy.exe`, the adapter starts the broker as a child process.

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

The adapter **may** capture and forward this token to other consumers.

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

# Uses ADOBEPY_BROKER_URL and ADOBEPY_TOKEN from the environment
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

## 7. Registry Integration (install.ps1)

When the Windows bundle is installed via `install.ps1`, the installer:

1. Extracts the archive to `%LOCALAPPDATA%\adobepy\<version>\`.
2. Creates a junction `%LOCALAPPDATA%\adobepy\current` pointing to the
   versioned directory.
3. Adds `%LOCALAPPDATA%\adobepy\current\bin` to the user `PATH`.
4. Writes `HKCU\Software\Adobe\adobepy\InstallDir` =
   `%LOCALAPPDATA%\adobepy\current`.
5. Optionally installs bridge templates into Adobe application plugin
   directories.

Multiple versions may coexist under `%LOCALAPPDATA%\adobepy\<version>\`; the
`current` junction always points to the most recently installed version.
