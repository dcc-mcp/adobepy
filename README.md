# adobepy

Shared Adobe desktop communication runtime for Python tools and DCC MCP
adapters. Python talks to a local Rust broker; Adobe applications run thin UXP
or CEP/ExtendScript bridges.

`adobepy` is intended to be the common Adobe host layer for projects such as
[`dcc-mcp-photoshop`](https://github.com/loonghao/dcc-mcp-photoshop) and future
Adobe adapters. The public Python surface mirrors Adobe's JavaScript DOM where
possible, while adding Pythonic aliases for agent and script ergonomics.

Implemented pieces:

- Rust `adobepy` CLI with `broker`, `doctor`, `install-bridge`, and `repl`.
- Local JSON-RPC broker with per-session token, target, timeout, and capability gates.
- Python SDK under `adobe.core`, `adobe.raw`, `adobe.photoshop`, `adobe.indesign`, `adobe.premiere`, `adobe.after_effects`, and `adobe.illustrator`.
- Optional DCC MCP result helpers under `adobe.dcc_mcp` for adapter skill code.
- UXP bridge templates for Photoshop, InDesign, and Premiere that dispatch to host APIs and broker raw JavaScript escape hatches.
- CEP bridge templates for After Effects and Illustrator.
- IR validation, proxy-aware `.pyi` stub generation, and stub/runtime drift checks.
- `vx just package` distribution workflow.

Validate everything:

```powershell
npm install
npm run test:all
```

The full test suite type-checks bridge code, builds and exercises UXP/CEP
bundles with mocked host runtimes, validates IR contracts, checks Python
coverage, and runs Rust workspace tests.

Python support starts at 3.8. The current SDK wheel is pure Python; any future
native Python extension must publish `cp38-abi3-*` wheels rather than
per-minor-version wheels.

Build a redistributable Windows package:

```powershell
vx just package
```

The archive is written to `dist/adobepy-0.1.0-windows-x64.zip` with a sibling
SHA256 file. Usage and packaging notes are in `docs/usage.md` and
`docs/distribution.md`. Architecture boundaries and Adobe API source tracking
are documented in `docs/architecture.md`, `docs/api-sources.md`, and
`docs/dcc-mcp-integration.md`.

Python facade example:

```python
from adobe.photoshop import Photoshop

app = Photoshop()
for layer in app.activeLayers:
    print(layer.name)

doc = app.activeDocument
doc.selection.select_rectangle({"top": 10, "left": 10, "bottom": 256, "right": 256})
for channel in doc.channels:
    print(channel.name)
```
