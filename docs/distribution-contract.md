# Distribution Contract

## Contract Summary

| Artifact | Where | Consumers |
| --- | --- | --- |
| `adobepy` Python wheel | PyPI | DCC MCP adapters, skill scripts, end-user Python code |
| `adobepy-<version>-windows-x64.zip` | GitHub Release | dcc-mcp-photoshop, host runners, manual installs |
| `adobepy-<version>-windows-x64.zip.sha256` | GitHub Release | Integrity verification |
| `adobepy-standalone-<version>-macos-arm64.zip` | GitHub Release | macOS arm64 standalone interpreter |
| `adobepy-standalone-<version>-macos-arm64.zip.sha256` | GitHub Release | Integrity verification |
| `adobepy-standalone-<version>-linux-x64.zip` | GitHub Release | Linux x86_64 standalone interpreter |
| `adobepy-standalone-<version>-linux-x64.zip.sha256` | GitHub Release | Integrity verification |

The two channels are independent: PyPI contains **only** the Python SDK, and the
GitHub Release asset contains **only** the broker/runtime bundle. A consumer that
needs both must install from both channels.

The Windows bundle and the two standalone archives are different artifacts, not
the same bundle built three times. The standalone archives ship a PyOxidizer
interpreter with the SDK embedded; they carry no bridge tree, no install script,
and no native broker CLI. See [section 2b](#2b-github-release--standalone-interpreter-bundles).

---

## 1. PyPI — Python SDK Wheel

### What is published

Only `adobepy` pure-Python wheel (`py3-none-any`). No native extensions, no Rust
binaries, no bridge bundles.

The wheel does ship a pure-Python command line entry point, `python -m adobe`,
so a wheel-only install can be diagnosed (`doctor`), can stage a bridge from any
resolvable bridge tree (`install-bridge`), and can start a broker that it
resolves from the environment or PATH (`broker`). `broker` still requires the
Rust executable from the GitHub Release bundle: the module reports every
location it probed and where to obtain the binary instead of failing with a
bare error.

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
| Repository owner | `dcc-mcp` |
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
    __main__.py          # python -m adobe entry point
    cli.py               # doctor, install-bridge, broker (pure Python)
    runtime.py           # ensure_broker() helper with actionable errors
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
  bin/
    adobepy.exe            # Rust CLI (broker, doctor, install-bridge, repl)
    adobepy-bootstrap-helper.exe # Fixed sibling for bounded bootstrap work
    adobepy.pdb            # Debug symbols (optional)
  wheels/
    adobepy-<version>-py3-none-any.whl
  python/                  # Python SDK source tree (python/adobe)
  bridges/
    uxp/
      photoshop/
      indesign/
      premiere/
    cep/
      after-effects/
      illustrator/
  docs/                    # Operation docs
  generators/              # IR contracts and generators
  install.ps1              # One-shot installer (installs wheel, optionally adds bin/ to PATH)
  install.md               # Complete install and usage guide
  DISTRIBUTION-README.md
  package-manifest.json
  README.md
  pyproject.toml
  package.json
  package-lock.json
  Cargo.toml
  Cargo.lock
  python-runtime/          # Bundled embedded Python runtime (optional, only with -IncludePortablePython)
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

The installer rejects an archive that is missing either native executable.
`adobepy` resolves the helper only as a canonical, regular, non-reparse sibling;
it never searches `PATH` or accepts an environment override for this boundary.
The PyPI wheel remains pure Python and intentionally contains neither native
executable. Native bootstrap transactions therefore require the GitHub Release
runtime bundle.

The CI gate (`release.yml` → `windows-package` job) runs after the Python
package is built and verified. It uploads `.zip` + `.sha256` as a build artifact
named `adobepy-windows-x64`.

### Release workflow

1. Release Please opens a release PR; once it merges, the release workflow cuts
   the tag and the GitHub Release.
2. The `release-please.yml` workflow runs:
   - `python-package`: builds, checks, and smoke-installs the Python wheel.
   - `pypi`: publishes the wheel to PyPI.
   - `windows-package`: builds the full Windows bundle and uploads it to the
     release.
   - `standalone-package`: builds the macOS arm64 and Linux x86_64 standalone
     interpreters and uploads them to the same release.

`release-please.yml` is the only workflow that publishes to a release tag.
`release.yml` is the manual rebuild path (`workflow_dispatch` with an explicit
`release_tag`); its macOS and Linux standalone jobs are disabled with `if: false`
so the two workflows can never upload the same asset name for one release.

### Version scheme

Semantic versioning (`<major>.<minor>.<patch>`). Pre-release suffixes (e.g.
`-alpha.1`, `-rc.1`) are allowed during development. The Python wheel, the
Windows bundle, and both standalone archives share the same version string.

---

## 2b. GitHub Release — Standalone Interpreter Bundles

### Archive naming

```
adobepy-standalone-<version>-macos-arm64.zip
adobepy-standalone-<version>-macos-arm64.zip.sha256
adobepy-standalone-<version>-linux-x64.zip
adobepy-standalone-<version>-linux-x64.zip.sha256
```

The runtime id in the filename is asserted, not derived: each job fails if the
runner does not report the architecture its asset name claims. A macOS runner
that silently falls back to x86_64 is never published as `macos-arm64`.

### What is inside

A PyOxidizer build of the interpreter with the `adobepy` SDK embedded, rooted at
the PyOxidizer `install` directory. The entry point is `adobepy-python`.

These archives are deliberately narrower than the Windows bundle: they carry no
bridge tree, no `install.ps1`, and no native broker CLI. They exist so the SDK
is importable on a machine with no Python installed, not to replace the runtime
bundle.

### Build pipeline

Built by the `standalone-package` matrix in `release-please.yml`, on
`macos-latest` and `ubuntu-latest` respectively. Each leg builds the wheel, runs
`pyoxidizer build`, asserts the runner architecture, packages the `install`
directory as a zip plus sha256, and then smoke-tests the unpacked interpreter
before uploading.

The smoke test runs:

```python
from adobe.photoshop import Photoshop
```

That import only loads the SDK — it opens no connection — so it passes with no
Adobe host present. This is what makes the Linux leg meaningful at all: it
proves the interpreter boots and the SDK is importable, not that a live host is
reachable. The Linux archive therefore carries no claim of Photoshop support.

### Platform coverage

| Runtime id | Status |
| --- | --- |
| `macos-arm64` | Published |
| `linux-x64` | Published |
| `windows-x64` | Published, as the Windows runtime bundle in section 2 |
| macOS x86_64 | Not published |
| Linux arm64 | Not published |

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
| Install bridge templates | Yes (bundled in `adobe/_bridges`) | Yes (manual copy from archive) |
| CI dependency (`adobepy>=0.1.0`) | Yes | No |
| Manual Windows install | Recommend both | Yes |
| macOS arm64 / Linux x86_64 SDK import | No | Yes (standalone archive) |
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
