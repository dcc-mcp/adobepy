# Testing Strategy

The project uses layered tests so day-to-day checks stay fast while release
checks still cover the broker, generated Python facade, bridge bundles, and
package layout.

## Local Commands

```powershell
npm run test:quick
```

Fast contract gate for most changes. It type-checks bridge sources, validates
IR, runs Python coverage, and runs Rust workspace tests. Use this before every
commit.

```powershell
npm run test:bridges
```

Bridge gate. It builds UXP and CEP bundles, then exercises them against mocked
Photoshop, InDesign, Premiere, After Effects, Illustrator, CSInterface,
WebSocket, and UXP Developer Tool protocol surfaces.

```powershell
npm run test:all
```

Full local gate. It runs the quick gate plus bridge protocol tests. It is the
default acceptance command before publishing.

```powershell
npm run lint
```

Quality gate. It runs Python syntax and architecture checks, TypeScript
type-checking, Rust formatting, and Rust clippy.

```powershell
npm run architecture:check
```

Architecture gate. It checks shared/host import direction, host package parity,
`py.typed` markers, bridge-core neutrality, and camelCase-to-snake_case facade
alias pairs.

```powershell
npm run capabilities:check
```

Bridge capability gate. It executes each UXP/CEP bridge entrypoint with a fake
WebSocket, captures the advertised `hello.capabilities` payload, and checks it
against the host IR and API source registry.

```powershell
npm run stubs:check
```

Generated facade stub gate. It checks committed `session.pyi` files against the
IR generator and verifies every generated public class/member exists in the
runtime facade implementation. Use `npm run stubs:write` after intentionally
changing the IR facade surface.

```powershell
npm run facades:check
```

Generated runtime contract gate. It checks committed `_facade_contract.py`
manifests against the IR generator and verifies every generated public alias is
implemented by the runtime facade classes. Use `npm run facades:write` after
intentionally changing the IR facade surface.

```powershell
npm run api:sources:validate
```

Offline source-registry gate. It ensures every IR host has a tracked Adobe API
reference entry before facade coverage expands.

```powershell
npm run api:coverage
```

Coverage matrix report. It prints current MVP vs planned API object families
for each Adobe host so interface expansion stays measurable.

```powershell
npm run abi3:check
```

Native extension canary. It keeps the current wheel on the pure-Python path,
validates the dormant PyO3 native-extension template, and fails if future
native packaging drifts away from `abi3-py38`.

```powershell
npm run test:replay
```

Fixture replay gate. It executes small Python facade examples against recorded
broker responses so user-facing snippets become regression tests.

```powershell
npm run smoke:photoshop:live
```

Optional live Photoshop smoke. It is skipped unless
`ADOBEPY_LIVE_PHOTOSHOP=1` is set, so normal CI and PR checks do not require a
desktop Adobe app. On a self-hosted runner with Photoshop, the adobepy broker,
and the UXP bridge connected, it checks capabilities, `app.version`,
`active_document`, and `active_layers`. Add `-- --mutate` or set
`ADOBEPY_LIVE_PHOTOSHOP_MUTATE=1` to run a modal hide/show batchPlay smoke
against the active layer. Use `-- --broker-url`, `-- --target`, and
`-- --timeout` when the runner uses a non-default broker endpoint or target.

```powershell
vx just package
```

Release gate. It runs full verification by default, builds the Rust CLI and
bridge bundles, creates the Python wheel, stages the distribution tree, writes
the manifest, creates the archive, and writes the SHA256 file.

## Coverage Layers

- IR contract tests: validate every `generators/ir/*.json` contract and generated
  `.pyi` output before facade or bridge code relies on it.
- API source tests: validate the Adobe reference registry used to expand API
  coverage and aliases, including MVP/planned coverage targets per host.
- Architecture tests: enforce shared/host ownership boundaries and alias parity
  so the facade stays extensible as new Adobe APIs are added.
- Capability tests: keep bridge-advertised namespaces and methods in lockstep
  with the IR that drives Python facade and stub generation.
- Stub drift tests: keep generated `.pyi` files, runtime facade classes, and
  Pythonic alias names aligned as API coverage expands.
- Runtime facade contract tests: keep generated `_facade_contract.py` manifests
  aligned with IR, alias generation, source mappings, and runtime class members.
- Lint/quality gates: compile Python 3.8-compatible sources, type-check bridge
  TypeScript, and run Rust format/clippy checks in CI.
- Python facade tests: assert JS-shaped aliases and Pythonic aliases call the
  same broker methods, including modal and timeout options.
- Replay fixture tests: turn common Python examples into deterministic broker
  call traces.
- DCC MCP mock integration tests: prove adapter-style skill functions can call
  adobepy facades and receive DCC MCP result dicts without launching Photoshop.
- DCC MCP method-map tests: keep legacy `dcc-mcp-photoshop` `ps.*` method
  families mapped to typed facades or explicit DOM/batchPlay escape hatches.
- Broker tests: assert auth, capability gating, request id restoration, timeout,
  disconnect cleanup, and HTTP endpoint behavior.
- Bridge protocol tests: run bundled bridge JavaScript in Node VM contexts with
  mocked host modules and WebSocket transport, without requiring Adobe apps in
  CI.
- Premiere export tests: mock coverage verifies EncoderManager/Exporter RPC
  dispatch, option pass-through, capability snapshots, and normalized export job
  metadata. A live Premiere host is still required to prove actual media output,
  AME queue behavior, installed preset discovery, render events, and filesystem
  permissions.
- After Effects render queue tests: mock coverage verifies queue serialization,
  selected-composition queueing, output-module template/settings/path
  pass-through, and host-script error mapping. A live After Effects host is still
  required for destructive or slow smoke candidates: `RenderQueue.render()`,
  `RenderQueue.queueInAME()`, actual file output, installed output-module
  templates, and filesystem permissions.
- Packaging tests: use the package script as the final artifact smoke because it
  catches missing dist files, bridge templates, wheel metadata, and CLI build
  regressions.
- Native abi3 canary: keep the current `py3-none-any` wheel honest while
  preserving a checked `abi3-py38` build path for future PyO3 extensions.

## CI and Live-Host Smokes

Normal PR and `main` CI stay desktop-free. The regular CI workflow exercises
Python facades, broker contracts, bridge dispatch mocks, capability drift,
package metadata, wheel install smoke, and the `abi3-py38` native canary.

The `Live Host Smoke` workflow is manual-only and targets self-hosted Windows
runners labeled `self-hosted`, `windows`, `adobe`, and `photoshop`. Before
dispatching it, start Photoshop with an active document, start the adobepy
broker, connect the Photoshop UXP bridge to that broker, and set the
`ADOBEPY_TOKEN` repository or environment secret when the broker uses a custom
token. Workflow inputs select the broker URL, target id, request timeout, and
whether the smoke may temporarily hide/show the active layer.

Failure output is phase-scoped so breakage points to the likely layer:

| Command or phase | Likely layer |
| --- | --- |
| `test:replay` fixture mismatch | Python facade aliasing or broker request shape |
| `protocol:check` or broker tests | Broker protocol, auth, timeout, or error mapping |
| `test:bridges` | UXP/CEP bridge dispatch or host serialization |
| `capabilities:check` | Bridge-advertised methods drifting from IR |
| `smoke_wheel_install.py` | Wheel metadata, package data, or public imports |
| `live_photoshop_smoke.py phase=...` | Live host state, bridge connectivity, or broker target |

## Next High-Value Additions

- Broader fixture replay tests: add traces for modal operations, Premiere
  project access, and CEP `evalExtendScript` flows.
- Live-host fixture assets: add a tiny Photoshop document fixture plus
  screenshot/log export for self-hosted runners that can persist artifacts.
- Official API drift checks: periodically crawl or vendor official UXP/DOM type
  metadata from `generators/api_sources/adobe_api_sources.json` and diff
  generated facade names against the current IR. Treat drift as a review signal,
  not an automatic breaking change.
- Wasm build smoke: once `vx` provides the wasm build provider here, add a small
  canary package that compiles, loads through the bridge bundle, and returns a
  deterministic value from Node VM tests.
