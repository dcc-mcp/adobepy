# Distribution Packaging

> **Note:** This document covers packaging mechanics. For the public distribution
> contract (PyPI, GitHub Release, supported platforms), see
> [`distribution-contract.md`](distribution-contract.md).

Use `vx just package` to build a redistributable archive for the current
platform.

The Python package supports Python 3.8 and newer. The current wheel is pure
Python (`py3-none-any`), so it is already ABI-independent. If a future release
adds a native Python extension for the broker or protocol layer, that extension
must be built with a stable CPython ABI floor of `abi3-py38` instead of
per-minor-version wheels.

The release workflow enforces that rule by accepting only `py3-none-any` wheels
or native `cp38-abi3-*` wheels. Native build backends should enable the
equivalent of PyO3's `abi3-py38` feature so one wheel covers Python 3.8 and
newer.

## Native Extension Decision Rule

Stay pure Python for facade expansion, host API wrappers, bridge protocol
envelopes, alias generation, replay fixtures, and compatibility glue. Add a
native Python extension only when broker/protocol acceleration or a shared Rust
contract has a measurable user-facing benefit that cannot be achieved by the
current CLI/broker process boundary.

The native extension blueprint lives in
`packaging/native-extension-template/`. It is intentionally not part of the
current published package. If a future release adopts it, keep the PyO3 feature
floor at `abi3-py38`, use a native build backend such as maturin, and publish
`cp38-abi3-*` wheels per platform rather than per Python minor version.

The canary for this architecture is:

```powershell
npm run abi3:check
```

It checks that the current root package is still pure Python, the future native
template is configured for PyO3 `abi3-py38`, and the wheel tag validator still
rejects CPython-minor native tags such as `cp312-cp312`.

PyPI publishing uses trusted publishing. The PyPI publisher entry must point to
repository `dcc-mcp/adobepy`, workflow `.github/workflows/release.yml`, and
environment `pypi`.

Keep repository-level GitHub Actions workflow permissions at read-only by
default. The release workflow grants `id-token: write` only on the PyPI publish
job, and that job must continue to use the `pypi` environment so PyPI can verify
the trusted publisher claim.

## PyPI Release Path

The release workflow always builds and checks the Python distribution before any
publish step:

```powershell
python -m build
python -m twine check dist/*
python scripts/check_native_abi3_config.py
python scripts/check_wheel_compat.py dist
python scripts/smoke_wheel_install.py dist
```

The smoke installs the built wheel into a temporary virtual environment and
imports the public facades, including:

```python
from adobe.photoshop import Photoshop
```

For the first PyPI release, create a GitHub release such as `v0.1.0` from the
commit that has passed CI. The `release.yml` workflow publishes only after the
GitHub release is published, or after a manual workflow dispatch explicitly sets
`publish_to_pypi=true`.

Manual backfill for an existing tag:

1. Open **Actions > Release > Run workflow**.
2. Select the tag or branch to rebuild.
3. Leave `publish_to_pypi=false` for a build-only dry run.
4. Re-run with `publish_to_pypi=true` only after the dry run artifact and
   `twine check` result are correct.

PyPI trusted publisher configuration:

| Field | Value |
| --- | --- |
| Repository owner | `dcc-mcp` |
| Repository name | `adobepy` |
| Workflow | `release.yml` |
| Environment | `pypi` |

The `pypi` GitHub environment should require reviewer approval for production
publishes. If a publish fails before upload, fix the release workflow and
re-run the same tag. If files were uploaded to PyPI, do not overwrite that
version; release a new patch version and document the broken version in the
GitHub release notes.

```powershell
vx just package
```

For faster local iteration:

```powershell
vx just package-quick
```

The package script:

- installs Node dependencies with `npm ci` if `node_modules` is missing;
- ensures Python build/test helpers `coverage[toml]`, `setuptools`, and `wheel`
  exist;
- runs `npm run test:all` unless `-SkipTests` is passed;
- builds `adobepy` with `cargo build --release -p adobepy-cli --bin adobepy`;
- builds UXP and CEP bridge bundles;
- builds a Python wheel;
- stages the CLI, Python SDK, bridge templates, IR contracts, lockfiles, docs,
  installer, and manifest;
- writes a `.zip` archive and `.sha256` checksum under `dist/`.

After extracting the archive:

```powershell
.\install.ps1 -Python python -AddToUserPath
adobepy doctor
```
