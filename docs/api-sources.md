# Adobe API Sources

This project should make Adobe automation feel familiar to JavaScript users and
natural to Python users. The API source registry in
`generators/api_sources/adobe_api_sources.json` is the machine-readable map from
each supported host to the documentation and metadata sources used to expand the
IR, bridge capabilities, Python facade, and Pythonic aliases.

## Current Source Map

| Host | Bridge | Runtime entry point | Primary reference |
| --- | --- | --- | --- |
| Photoshop | UXP | `require('photoshop').app` | [Photoshop UXP API](https://developer.adobe.com/photoshop/uxp/2021/ps_reference/) |
| InDesign | UXP | `require('indesign').app` | [InDesign DOM APIs](https://developer.adobe.com/indesign/uxp/resources/fundamentals/dom-versioning/) |
| Premiere Pro | UXP | `require('premierepro')` | [Premiere Pro DOM API](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/) |
| After Effects | CEP/ExtendScript | `app` | [After Effects scripts](https://helpx.adobe.com/after-effects/using/scripts.html) |
| Illustrator | CEP/ExtendScript | `app` | [Illustrator JavaScript reference](https://developer.adobe.com/console/servicesandapis) |

## Current Coverage Matrix

| Host | Bridge | MVP targets | Planned targets | Coverage | Next targets |
| --- | --- | ---: | ---: | ---: | --- |
| Photoshop | UXP | 8 | 0 | 100.0% | none |
| InDesign | UXP | 2 | 3 | 40.0% | Pages and spreads; text frames, stories, and styles; swatches, colors, links, and export/package workflows |
| Premiere Pro | UXP | 2 | 3 | 40.0% | Sequences, tracks, clips, and markers; project items, media import, and bins; encoder/export workflows |
| After Effects | CEP/ExtendScript | 2 | 3 | 40.0% | Compositions and footage items; layers, masks, effects, and text; render queue and output modules |
| Illustrator | CEP/ExtendScript | 2 | 3 | 40.0% | Artboards, layers, and page items; path items, compound paths, and placed/raster items; text frames, stories, swatches, colors, and export workflows |

## Coverage Rules

- Every `generators/ir/*-mvp.json` host must have exactly one API source entry.
- Every source entry must include at least one primary Adobe reference and the
  GitHub issue numbers that track facade/API expansion.
- Every source entry must include `coverageTargets` that separate current MVP
  object families from planned full-coverage families.
- MVP coverage targets must cite real IR namespaces and facade objects; planned
  targets must stay explicit so gaps remain visible until implemented.
- IR files should describe proxy classes for runtime facade objects that expose
  Adobe DOM payloads. Generated stubs are checked against those proxy contracts
  and the handwritten runtime classes.
- UXP hosts should prefer typed DOM APIs over raw script execution. Photoshop
  keeps `action.batchPlay` because Adobe documents it as the advanced escape
  hatch below the DOM model.
- Photoshop selection and channel coverage should use the typed UXP DOM surface
  first: `document.selection` for pixel selections and `document.channels` /
  `activeChannels` / `componentChannels` for channel access.
- Photoshop text coverage should use typed `Layer.textItem`,
  `TextItem.characterStyle`, and `TextItem.paragraphStyle` before falling back
  to `action.batchPlay` descriptors.
- CEP/ExtendScript hosts should keep raw `evalExtendScript` available but should
  not mix raw scripting into typed facade methods without an IR entry and replay
  fixture.
- Secondary mirrors are useful for searchability, but generated public API
  contracts should cite Adobe-owned references first when a stable URL exists.

## Existing Ecosystem Signals

Adobe's Photoshop sample repository includes UXP examples such as an
`io-websocket-example` and a `wasm-rust-sample`, which supports keeping our
bridge protocol WebSocket-based and keeping a future wasm smoke test on the
roadmap.

Existing Photoshop MCP experiments also commonly use a local server plus UXP
WebSocket bridge. `adobepy` should differ by making that bridge cross-Adobe,
protocol-first, reusable by `dcc-mcp-photoshop`, and wrapped in Python facades
with both JS-shaped names and Pythonic aliases.

## Validation

```powershell
npm run api:sources:validate
```

The validator is offline and deterministic. It checks the registry shape,
ensures every IR host is represented, verifies source URLs are HTTPS, and
confirms the registry points at real local IR files. It also checks that
coverage targets reference known documentation names, GitHub tracking issues,
and existing IR namespaces when a target is marked as MVP.

Check generated facade stubs and runtime member parity:

```powershell
npm run stubs:check
```

After intentionally changing an IR facade/proxy surface, regenerate stubs:

```powershell
npm run stubs:write
```

Generate the current coverage matrix:

```powershell
npm run api:coverage
```
