# ADR 0001: Bound Bootstrap Transaction Ownership

- Status: Accepted
- Date: 2026-08-26

## Context

Adobe bootstrap includes file attestation, inert staging, configuration
activation, and host-process launch. Some OS and filesystem calls are blocking
and non-cooperative. Running them directly on a Tokio worker delays unrelated
requests. Moving them to detached Rust threads returns sooner but leaves no
bounded worker count, no kill/reap proof, and no guarantee that a late result
cannot mutate authoritative configuration.

The public request deadline is a responsiveness limit, while a successful
receipt is a safety statement. A timeout is not a quiescence acknowledgement:
the counted owner retains its admission and worker permits until the original
child is reaped or the pool enters a visible fail-stop state.

## Requirements

Functional requirements:

- Execute arbitrary blocking probe and staging work outside Tokio workers.
- Bound running helpers and queued requests, and reject overload before spawn.
- Bind every request and response to one protocol version and random request ID.
- Permit late results only in generation-scoped inert staging.
- Serialize configuration activation with a non-clone generation lease.
- Detect same-content replacement, redirect, ABA, and external edits.
- Restore only bytes written by the same transaction.
- Retain the original child handle and terminate the owned process tree without
  reopening a PID.
- Redact panic payloads at the helper process stderr boundary while preserving
  ordinary panic handling.

Non-functional requirements:

- A 50 ms helper deadline returns within 250 ms without waiting for a blocking
  process creation call; quiescence has its own explicit bounded deadline.
- Capacity and queue length are fixed at construction.
- Drop performs no filesystem operation, thread join, or blocking mutex wait.
- Request, response, and stderr are capped at 512 KiB, 64 KiB, and 4 KiB.
- Shutdown reports success only with zero jobs, leases, queues, and children.

## Decision

Use a fixed-capacity pool of pre-owned helper processes for arbitrary blocking
work. Helpers are created when the pool is constructed, before any request
deadline starts. Each helper accepts strict newline-framed JSON envelopes on
stdin and emits one bounded response per frame. The parent owns the original
process handle. Windows helpers and host children are placed in kill-on-close
Job Objects; Unix children are placed in a new process group. Deadline paths
return to the caller while the counted owner terminates and reaps the original
child. A timed-out or malformed helper fail-stops the pool; it is never replaced
in a request or shutdown path. The owner retains both admission and worker
permits until reap. Shutdown reports quiescence only after every queued,
preparing, running, owned-child, or reaping count reaches zero.

If the OS does not acknowledge reap within the bounded budget, the pool closes,
rejects all new work, records a typed fail-stop state, and retains a counted
reaper owner until the child actually exits. It never emits a safe completion
receipt. The public timeout therefore preserves its response SLO without being
misrepresented as successful quiescence.

Helper output is inert. It may create only a UUID-scoped staging artifact. A
separate `ConfigTransactionOwner` grants one non-clone lease after an exact
path/handle/byte receipt comparison. The lease identity combines the local
generation with a random transaction UUID; each staged artifact also carries a
different staging UUID. Activation, commit preparation, rollback, and
revocation compare the complete transaction identity and receipt under one
owner lock. Commit is two phase: the owner first writes and retains a
rollback-capable exact receipt. A prepared confirmation ticket is inert: its
consumer reacquires the config-owner lock, recaptures the authoritative
path/handle/bytes, and atomically advances that exact transaction to
`confirmed-pending-publication`, moving it out of the active slot while the
owner retains a separate rollback-capable pending slot. Only then does the
broker receive a linear publication permit. Publishing that permit is a
non-blocking compare-and-swap, so the broker performs no filesystem I/O while
holding its async grant, host, or receipt locks. Deadline or cancellation
before publication leaves the transaction rollback-capable; publication and
rollback race through mutually exclusive state transitions and cannot both
succeed.
Configuration writes reacquire the expected OS file identity, keep that handle
through the conditional write, and bind the post-write receipt to the same
handle. A path replacement in the recapture-to-write window therefore fails
closed instead of overwriting the replacement. Lease Drop performs a single
atomic revocation; explicit methods return a quiescence acknowledgement.
Rollback refuses to overwrite an external edit.

The public Photoshop bootstrap stores an
`Arc<dyn PhotoshopBootstrapTransaction>` in the grant before activation. The
transaction is only a shared control plane: its `ConfigLease`, staged artifact,
and process ownership remain non-clone capabilities. Timeout performs a
lock-free revoke before recovery; late activation or commit work rechecks that
fence while holding the config owner lock. A timed-out preparation may finish
only as inert staging and cannot redeem its result. The fixed blocking boundary
fail-stops new forward work until every timed-out trusted worker has quiesced;
cleanup has a reserved path so rollback is not starved. Arbitrary extension
work continues to require the killable helper-process boundary.

`HostProcessBroker` retains the original child and an unforgeable ownership ID.
Windows ownership includes a kill-on-close Job handle. Unix ownership includes
the original direct child and process group. PID lookup is never used to regain
authority, so PID reuse cannot redirect termination. A failed or cancelled
public launch terminates and reaps that original ownership; a successful launch
is transferred into the broker's committed-host registry instead of being
reconstructed from an observed PID.

Host children are admitted through one fixed-capacity supervisor per broker.
The supervisor owns every child and Job/process-group handle independently of a
request's Tokio runtime; token drop only requests termination, and active
ownership is released after the supervisor observes and reaps the original
child. On Windows the host starts suspended, joins its kill-on-close Job, and is
resumed only after that assignment succeeds, so an early descendant cannot
escape ownership. Closing the broker fail-stops admission and the supervisor
terminates every remaining owned child before its lifecycle ends.

The helper is packaged beside `adobepy.exe` in the native runtime archive. The
pure-Python wheel remains SDK-only. The CLI resolves only the canonical sibling,
never `PATH` or an environment override.

## Alternatives

### Cooperative blocking threads

Rejected because third-party and OS calls are not required to poll a token.

### Detached thread per operation

Rejected because worker count, shutdown time, and late mutation are unbounded.

### Fixed thread pool

Rejected for arbitrary work: it bounds concurrency but cannot terminate a stuck
thread or prove quiescence. It remains suitable only for pure, trusted compute.

### Helper process

Selected because the parent can bound admission and own a killable OS boundary.
It adds one executable, JSON protocol validation, packaging work, and process
startup cost. Those costs are accepted for bootstrap operations, which are rare
and safety-sensitive.

## Failure Modes and Operations

- Missing, redirected, or foreign helper: fail before request I/O.
- Full queue: typed overload; the fixed helper count cannot grow.
- Unterminated input: reject as soon as the incremental 512 KiB request bound
  is crossed; do not wait for a newline or EOF.
- Deadline: typed timeout, then counted kill/reap with no replacement before
  quiescence.
- Reap failure: close the pool and expose fail-stop; never replace the worker.
- Late staging: generation mismatch makes it unredeemable.
- External config edit: finalize/rollback fails closed and preserves the edit.
- Dropped active config lease: atomic revocation; no receipt is issued.
- Host termination failure: retain counted reap ownership; never claim safe exit.
- Sensitive helper panic: fixed stderr message and structured failure code.

No real Adobe host acceptance is implied by these infrastructure tests. Host
adapters must add their own attestation, activation, and final recapture tests
when adopting this boundary.
