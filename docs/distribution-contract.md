# Distribution Contract

## Contract Summary

| Artifact | Where | Consumers |
| --- | --- | --- |
| `adobepy` Python wheel | PyPI | DCC MCP adapters, skill scripts, end-user Python code |
| `adobepy-<version>-windows-x64.zip` | GitHub Release | dcc-mcp-photoshop, host runners, manual installs |
| `adobepy-<version>-windows-x64.zip.sha256` | GitHub Release | Integrity verification |

The two channels are independent: PyPI contains **only** the Python SDK, and the
GitHub Release asset contains **only** the broker/runtime bundle. A consumer that
needs both must install from both channels.

---

## 1. PyPI — Python SDK Wheel

### What is published

Only `adobepy` pure-Python wheel (`py3-none-any`). No native extensions, no Rust
binaries, no bridge bundles.

### Publishing mechanism

Trusted publishing via GitHub Actions. The release workflow
(`.github/workflows/release.yml`) publishes after a GitHub Release is published
or after manual dispatch with `publish_to_pypi=true`.

```yaml
# Extract from release.yml — PyPI job
environment: pypi
permissions:
  id-token: write
```

### PyPI trusted publisher configuration

| Field | Value |
| --- | --- |
| Repository owner | `loonghao` |
| Repository name | `adobepy` |
| Workflow | `release.yml` |
| Environment | `pypi` |

### Wheel tag invariant

```text
py3-none-any
```

The CI gate at `scripts/check_wheel_compat.py` rejects any wheel that is not
`py3-none-any`. If a future Phase adds a native extension, the ABI floor must be
`cp38-abi3-*`. That guard is enforced by `scripts/check_native_abi3_config.py`.

### What is installed

```
site-packages/
  adobe/
    __init__.py
    core/
      __init__.py
      errors.py
      session.py
      ...
    photoshop/
    indesign/
    premiere/
    after_effects/
    illustrator/
    raw/
    dcc_mcp/
  adobepy-<version>.dist-info/
```

The wheel includes `py.typed` markers and `.pyi` stub files for all public
facades.

---

## 2. GitHub Release — Windows Runtime Bundle

### Archive naming

```
adobepy-<version>-windows-x64.zip
adobepy-<version>-windows-x64.zip.sha256
```

### Archive contents

```
adobepy-<version>-windows-x64/
  adobepy.exe              # Rust CLI (broker, doctor, install-bridge, repl)
  python/                  # Bundled embedded Python runtime (optional)
  bridges/
    uxp/
      photoshop/
      indesign/
      premiere/
    cep/
      after-effects/
      illustrator/
  install.ps1              # One-shot installer (adds to PATH, installs bridges)
  README.md
  LICENSE-MIT
  LICENSE-APACHE
```

### Build pipeline

The archive is produced by `scripts/package-release.ps1` on the
`windows-latest` GitHub Actions runner. The same script is also available for
local use:

```powershell
vx just package
# or directly:
./scripts/package-release.ps1
```

The CI gate (`release.yml` → `windows-package` job) runs after the Python
package is built and verified. It uploads `.zip` + `.sha256` as a build artifact
named `adobepy-windows-x64`.

### Release workflow

1. A maintainer creates a GitHub Release from a tag (e.g. `v0.1.0`).
2. The `release.yml` workflow runs:
   - `python-package`: builds, checks, and smoke-installs the Python wheel.
   - `pypi`: publishes the wheel to PyPI (only on `release` event or manual
     `publish_to_pypi=true`).
   - `windows-package`: builds the full Windows bundle and uploads artifacts.
3. After the workflow completes, the release draft is published so the `.zip`
   artifact is attached to the GitHub Release page.

### Version scheme

Semantic versioning (`<major>.<minor>.<patch>`). Pre-release suffixes (e.g.
`-alpha.1`, `-rc.1`) are allowed during development. The Python wheel and the
Windows bundle share the same version string.

---

## 3. Version Lockstep

The PyPI package and the GitHub Release asset always share the same version.
There is no mechanism to publish a Python SDK `0.2.0` while the runtime bundle
stays at `0.1.0`. If a breaking change is made to the broker protocol, the
Python SDK version is bumped to match.

---

## 4. Channel Boundaries

| Scenario | PyPI | GitHub Release |
| --- | --- | --- |
| Install Python SDK only | Yes | No |
| Run broker + CLI | No | Yes |
| Install bridge templates | No | Yes |
| CI dependency (`adobepy>=0.1.0`) | Yes | No |
| Manual Windows install | Recommend both | Yes |
| macOS / Linux brokering | No | No (Phase 1) |

---

## 5. Verification Gates

Before any publish step, the release workflow runs:

```powershell
python -m build
python -m twine check dist/*
python scripts/check_native_abi3_config.py
python scripts/check_wheel_compat.py dist
python scripts/smoke_wheel_install.py dist
```

The smoke install verifies that the public import path works:

```python
from adobe.photoshop import Photoshop
```

The Windows package build gate (`.github/workflows/release.yml` →
`windows-package`) verifies that `vx just package` succeeds, but does not
execute a live broker test.
