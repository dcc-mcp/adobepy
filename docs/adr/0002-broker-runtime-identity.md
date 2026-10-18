# ADR 0002: Broker Runtime Identity — Canonical Start Token and Session-Free Exposure

- Status: Accepted
- Date: 2026-10-18

## Context

Adapters (for example `dcc-mcp-photoshop`) must prove that the broker they talk
to is the exact process they installed and launched, not a later process that
reused the same PID. The broker therefore reports a *runtime identity* that an
adapter can compare, field by field, against values it observes independently
from the operating system. The comparison is what turns a PID into a safe
handle; it must never be bypassed.

That comparison only works if both sides derive every identity field the same
way, byte for byte, on every supported platform. In practice three divergences
appeared:

- The broker reported its own `processStartIdentity` as `windows:{ticks}` while
  the adapter already used `windows-filetime:{ticks}`. The values were computed
  from the same `GetProcessTimes` creation time but stringified differently, so
  a broker/adapter pair could never agree.
- On macOS the broker reported `macos:{seconds}:{microseconds}` derived from
  `proc_pidinfo`, while the adapter reported `darwin-lstart:{ps lstart}` derived
  from a `ps` subprocess. The two are not comparable text, and `ps lstart` is
  locale-formatted and coarse to whole seconds, so it is neither stable nor
  fine-grained enough to disambiguate a reused PID.
- The broker reported `runtimeVersion` from `CARGO_PKG_VERSION`, which is pinned
  at `0.1.0` and is not release-managed. An adapter's install receipt records
  the *product* release version (`0.6.x`, `0.11.x`, …), so the field mismatch
  surfaced as `identity_mismatch` even when the same build was talking to
  itself.

A second, related gap: `/health` is an unauthenticated liveness probe and
deliberately carries no identity, but `/v1/runtime-identity` only returns an
attestation when a live host/bridge session exists. Adapters need the broker's
*own* identity before any session exists — to decide whether it is worth
attaching to, and to keep a pre-session watchdog honest.

## Requirements

Functional requirements:

- One canonical `processStartIdentity` encoding per platform, used identically
  by the broker for itself, by the broker when it observes a host process, and
  by any adapter observing the same processes. Byte-for-byte equality is the
  contract.
- The token must disambiguate a reused PID: it is a value fixed at process
  start that an unrelated later process cannot reproduce.
- The broker must expose its own identity over an endpoint that requires the
  broker token (authenticated) but does **not** require a live host/bridge
  session (session-free), so it is available immediately after broker start.
- `runtimeVersion` must equal the release-managed product version recorded in an
  adapter install receipt, so an owned receipt and the running broker match.

Non-functional requirements:

- Values must satisfy the protocol identity bound (`is_bounded_text`) and carry
  no secrets and no locale- or user-dependent formatting.
- Derivation must not shell out to locale-sensitive tools (`ps lstart`), must be
  available without elevated privileges, and must be cheap enough to call on
  every identity probe.
- Cross-platform stability: a given scheme stays valid across OS updates within
  a platform; a change to a scheme is a protocol-level, coordinated change.

## Decision

### One canonical process-start token per platform

`processStartIdentity` is an ASCII string of the form `{prefix}:{payload}`,
where the prefix names the scheme and the payload is derived only from
OS-reported process-start facts:

- **Windows** — `windows-filetime:{u64}`. The payload is the process creation
  time from `GetProcessTimes`, packed as `(high << 32) | low` (a Win32
  `FILETIME`: 100 ns ticks since 1601-01-01 UTC). Used for the broker itself
  (`GetCurrentProcess`) and for an observed host (`OpenProcess` +
  `PROCESS_QUERY_LIMITED_INFORMATION`).
- **macOS** — `macos:{seconds}:{microseconds:06}`. The payload is
  `pbi_start_tvsec` and `pbi_start_tvusec` from `proc_pidinfo(pid,
  PROC_PIDTBSDINFO, …)`; the microsecond field is zero-padded to six digits.
  Used for the broker itself (its own PID) and for an observed host. No
  `ps`/`lstart` formatting is used anywhere.
- **Linux** — `linux:{boot_id}:{start_ticks}`. The payload combines
  `/proc/sys/kernel/random/boot_id` with field 22 (`starttime`, clock ticks
  since boot) from `/proc/{pid}/stat`. The boot id makes the token unique across
  reboots even when PIDs repeat.

Every producer of a `processStartIdentity` — broker self-capture, broker host
observation, and adapter host observation — implements exactly one of these
three encodings and no other. Broker and adapter must adopt a new encoding
together; a scheme change is a breaking protocol change, not a local fix.

### Session-free authenticated broker identity endpoint

The broker exposes its own `BrokerRuntimeIdentity` at `GET /v1/broker-identity`.
The endpoint:

- requires the `x-adobepy-token` header (returns `401` without it), like every
  other `/v1/*` endpoint except `/health`;
- returns the broker's captured identity (`pid`, `processStartIdentity`,
  `executablePath`, `runtimeVersion`, `instanceId`) directly from broker state;
- does **not** consult or require any host/bridge session, so it succeeds from
  the moment the broker starts listening.

Identity is never added to the token-less `/health` liveness probe. Keeping
liveness and identity on separate surfaces lets a pre-session watchdog check
"is the broker alive" without holding a token, while any consumer that needs
"which broker is this" must authenticate. `POST /v1/runtime-identity` remains
the session-scoped attestation path for host/bridge identity.

### runtimeVersion is the product release version

`capture_broker_identity` reports `env!("ADOBEPY_PRODUCT_VERSION")`, baked by
`crates/adobepy-broker/build.rs` from the release-please managed product version
(`.github/release-please-manifest.json` → `pyproject.toml` fallback), not
`CARGO_PKG_VERSION`. This makes the broker's reported version equal the
`installer_version` an adapter records in its owned install receipt, so the
version field compares equal instead of tripping `identity_mismatch`.

## Alternatives

### Reuse `/v1/runtime-identity` for broker self-identity

Rejected because it only returns an attestation while a live host/bridge session
exists. A pre-session probe or watchdog would then fail with a session error
instead of reporting broker identity, confounding "no session yet" with "no
broker".

### Put identity on `/health`

Rejected because `/health` is intentionally unauthenticated so liveness checks
need no token. Identity is security-relevant (it anchors the PID-reuse
decision); exposing it without authentication would let any local reader learn
the broker identity and weaken the token boundary.

### `ps lstart` / locale-formatted timestamps

Rejected because they are locale-dependent, whole-second resolution, require a
subprocess, and are not byte-comparable to a programmatic source. They cannot
disambiguate a PID reuse that happens within the same second.

### Report the Rust crate version as `runtimeVersion`

Rejected because crates are intentionally pinned (`0.1.0`) and not
release-managed, so the value never matches the adapter receipt's product
version and produces a permanent `identity_mismatch`.

## Failure Modes and Operations

- Prefix drift between broker and adapter (for example `windows:` vs
  `windows-filetime:`): the two never compare equal and identity verification
  fails closed. Guarded by a broker unit test that asserts the canonical prefix
  on each platform; adapters must carry the mirror-prefix assertion.
- macOS `proc_pidinfo` short read or zero `start_seconds`: return a typed
  identity-unavailable error; never fall back to `ps` or a synthesized value.
- Linux missing `boot_id` or malformed `starttime`: error rather than emit a
  token that could collide across reboots.
- `ADOBEPY_PRODUCT_VERSION` cannot be resolved at build time: a **release** build
  fails fast (`build.rs` refuses to emit a binary that would report the pinned
  crate version, because that value is receipt-compared and would reintroduce
  `identity_mismatch`); a non-release build only emits a build warning and falls
  back to the crate version for local development. A shipped release artifact
  therefore never carries a wrong runtime version.
- Unauthenticated `/v1/broker-identity` request: `401`, no identity disclosed.
- Scheme rotation: treated as a coordinated broker+adapter protocol change with
  tests on both sides; never a silent single-repo edit.
