# Distribution Packaging

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

PyPI publishing uses trusted publishing. The PyPI publisher entry must point to
repository `loonghao/adobepy`, workflow `.github/workflows/release.yml`, and
environment `pypi`.

## PyPI Release Path

The release workflow always builds and checks the Python distribution before any
publish step:

```powershell
python -m build
python -m twine check dist/*
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
| Repository owner | `loonghao` |
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
