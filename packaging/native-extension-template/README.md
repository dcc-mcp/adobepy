# Native Extension Template

This directory is a packaging canary for a future Rust-backed Python extension.
It is not part of the current `adobepy` wheel, which intentionally remains
`py3-none-any` until a native module has a clear user-facing reason to exist.

Use a native extension only when broker/protocol acceleration or a shared Rust
contract materially improves the Python SDK. Keep pure Python for facade code,
host API wrappers, bridge protocol envelopes, and compatibility glue.

When a native module is introduced:

- keep the minimum Python version at `>=3.8`;
- build with PyO3 `abi3-py38`;
- publish one `cp38-abi3-*` wheel per platform instead of one wheel per CPython
  minor version;
- keep `python scripts/check_wheel_compat.py dist` in release validation;
- run `python -m abi3audit dist/*.whl` on native wheels when `abi3audit` is
  available.

The repository canary is:

```powershell
npm run abi3:check
```
