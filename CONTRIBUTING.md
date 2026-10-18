# Contributing

`adobepy` is a shared communication layer for Adobe desktop automation and DCC
MCP adapters. Changes should keep the protocol stable, the Python facade easy to
learn for Adobe JavaScript users, and the bridge implementation small enough to
audit.

## Design Rules

- Keep host-specific behavior behind host adapters. Broker, protocol, client,
  and capability code should not grow Photoshop-only assumptions.
- Follow the ownership boundaries in `docs/architecture.md` when adding host
  methods or new Adobe applications.
- Prefer generated or schema-backed facade additions over hand-written drift.
  When hand-writing a method, add the IR and bridge capability update in the
  same change.
- In IR, declare every method's `returns` type. Use `mutatesState` and
  `requiresModalWhenMutating` for state-changing host calls, and mark raw
  JavaScript or ExtendScript escape hatches with `"raw": true` under the `raw`
  namespace.
- Preserve both JS-shaped names and Pythonic aliases when exposing Adobe DOM
  concepts.
- Use explicit capability checks for optional host methods. Do not make callers
  discover missing bridge support through generic runtime errors.
- Keep raw JavaScript and ExtendScript escape hatches available but clearly
  separated from typed facade methods.
- Keep Python runtime support at 3.8+. If native Python extension modules are
  introduced, build them with `abi3-py38`.

## Quality Gates

Run the narrowest useful gate while iterating, then the full gate before
publishing:

```powershell
npm run lint
npm run test:quick
npm run test:bridges
npm run test:all
vx just package
```

`npm run test:photoshop-bootstrap-contract` builds the Photoshop bundle and
composes the production bootstrap config generator, mocked UXP hello, and real
broker binder. It verifies that an unavailable independently observed host
profile fails closed without consuming the nonce or publishing a receipt, and
that the bootstrap still times out and rolls back. It does not prove a live
Photoshop profile source or successful bootstrap. The test is included in
`test:all` (and the release-parity CI job), but is explicitly ignored by ordinary
`cargo test` / `test:quick`, which do not build bridge assets.

Architecture-specific checks:

```powershell
npm run architecture:check
npm run ir:validate
```

New code should include tests at the lowest stable layer:

- protocol and broker rules in Rust unit tests;
- Python aliases and facade behavior in Python facade tests;
- bridge dispatch behavior in UXP/CEP mock protocol tests;
- release artifact expectations in package smoke tests.

## Compatibility

The project intentionally supports Python 3.8+ for downstream adapters that
still run in conservative production environments. Avoid syntax or runtime APIs
that require newer Python versions unless a compatibility shim exists.
