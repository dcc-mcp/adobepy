# Architecture Boundaries

`adobepy` is a shared Adobe communication layer. New host support should extend
the protocol and host adapters without copying transport code or leaking
Photoshop-specific assumptions into shared modules.

The stable adapter-facing wire contract is documented in
[`docs/protocol.md`](protocol.md) and checked with `npm run protocol:check`.

## Ownership

| Area | Owns | Must not own |
| --- | --- | --- |
| `crates/adobepy-protocol` | Wire types, host identifiers, JSON-RPC errors, capability contracts | Broker state, HTTP/WebSocket runtime, host DOM behavior |
| `crates/adobepy-broker` | Local HTTP/WebSocket broker, auth, session routing, timeout and capability checks | Photoshop/InDesign/Premiere DOM logic |
| `python/adobe/core` | Broker client, base session, capability normalization, shared errors | Host-specific facade imports |
| `python/adobe/raw` | Explicit raw JavaScript/ExtendScript escape hatches | Typed host facade behavior |
| `python/adobe/dcc_mcp` | Optional DCC MCP skill-result compatibility helpers and adobepy error mapping | MCP server lifecycle or host-specific behavior |
| `python/adobe/<host>` | Python facade and Pythonic aliases for one Adobe host | Sibling host facades or transport implementation |
| `bridges/uxp/core` | Generic UXP bridge transport and protocol handling | Host-specific UXP module names or DOM dispatch |
| `bridges/cep/core` | Generic CEP/WebSocket transport and ExtendScript dispatch wrapper | After Effects or Illustrator business logic |
| `bridges/*/<host>/src/host.ts` | Host adapter, host capabilities, DOM serialization | Broker routing, Python naming conventions |
| `generators/ir` | Host capability shape, facade generation input, aliases, and source mappings | Runtime bridge state |
| `python/adobe/<host>/_facade_contract.py` | Generated runtime contract manifest from IR | Hand-authored facade behavior |

## Facade Generation

The host IR is the contract source for generated stubs, generated runtime
contract manifests, bridge capability validation, and runtime facade drift
checks.

Alias rules are deterministic:

- Method names keep the Adobe JavaScript shape in IR. The generator emits the
  Pythonic snake_case name plus the original JS-shaped name when they differ,
  for example `batchPlay` -> `batch_play` and `batchPlay`.
- Property names are canonical snake_case in IR. The generator emits the
  snake_case property plus the JS-shaped camelCase alias, for example
  `active_document` -> `active_document` and `activeDocument`.
- Facade methods may declare `source: "namespace.method"` when they are owned by
  a broker method. Source references are validated against the same namespace
  method list that drives bridge capabilities.
- Mutability and modal metadata live on namespace methods, then flow into the
  generated runtime contract for any property or facade method that references
  that source.

## Method Addition Flow

1. Add or update the host method in `generators/ir/<host>-mvp.json`.
   Every method must declare `returns`; mutating methods should set
   `mutatesState`, modal writes should also set
   `requiresModalWhenMutating`, and raw JavaScript/ExtendScript escape hatches
   must live under the `raw` namespace with `"raw": true`.
2. Add or update proxy properties/methods in the same IR file. Use Pythonic
   property names, JS-shaped method names, and `source: "namespace.method"` for
   facade methods that directly call a broker method.
3. Regenerate contract artifacts with `npm run facades:write` and
   `npm run stubs:write`.
4. Add the official API source or note in
   `generators/api_sources/adobe_api_sources.json` if the method comes from a
   new documentation surface.
5. Implement the host bridge dispatch in the host adapter only.
6. Add the Python facade behavior only for methods that need host-specific
   payload shaping; the generated contract gates ensure the public names and
   aliases match IR.
7. Add a Python facade test or replay fixture that proves both aliases call the
   same broker method.
8. Run `npm run test:quick`; use `npm run test:all` before publishing.

## Review Checklist

- Shared modules do not import host packages.
- Host packages do not import sibling host packages.
- Bridge core code has no host-specific names.
- UXP hosts prefer typed DOM calls before raw eval or `batchPlay`.
- CEP hosts keep `evalExtendScript` separated from typed facade methods.
- Raw payloads are only used at `adobe.raw` or clearly marked escape hatches.
- DCC MCP helpers remain optional and do not make `dcc-mcp-core` a runtime
  dependency of adobepy.
- Broad host errors are converted to protocol error objects with useful
  diagnostics.
- Every camelCase facade member has a snake_case Pythonic sibling.
- Every supported host has IR, API source metadata, Python facade package, and
  `py.typed`.
- Generated `_facade_contract.py` manifests match IR and runtime classes.
- Runtime facade `invoke(namespace, method)` pairs are declared in the host IR,
  and bridge hello capabilities are checked against the same IR.

## Automated Gate

```powershell
npm run architecture:check
npm run facades:check
```

The gate checks host/package parity, `py.typed` markers, import direction,
camelCase-to-snake_case alias pairs, runtime facade invoke declarations, and
bridge-core host neutrality. The generated facade contract gate checks committed
runtime contract manifests and runtime class members against IR. Both are part
of `npm run test:quick`.
