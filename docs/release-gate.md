# Release gate

`release-please.yml` opens a release PR, then a gate step decides whether to
merge it and re-dispatches the workflow to cut the actual release. The gate
lives in `scripts/gate-release-pr.sh` and is called by the workflow with the
same environment the step used to declare inline, so the two are one unit:
edit the script, not a copy inside the YAML.

## Why it is a script

The gate only runs on `main`, so pull-request CI never exercised it — a green
PR said nothing about the logic that decides whether a release ships. As a
script it can be driven by `scripts/test-gate-release-pr.sh`, which puts a stub
`gh` on `PATH` and asserts on the verdicts and exit codes for each situation
the gate has to adjudicate.

## Running the scenarios

```bash
bash scripts/test-gate-release-pr.sh
```

No network and no repository are needed. The stub answers the `gh` subcommands
the gate uses (`pr list`, `pr view`, `pr merge`, `run list`, `api`,
`workflow run`) from JSON fixtures, and honours `--match-head-commit` the way
the API does — refusing when the branch head no longer matches the SHA the
caller verified.

The suite covers the verdict matrix: newest run superseding an older one,
cancelled and failed runs, a head that moves before the re-read and after it,
a head with no run at all, a failure on a different head, an in-flight run,
transient `gh` failures on each guarded call, and a release PR left open past
the stall threshold.

Deleting or weakening a guard in the gate script should fail a scenario. If a
change to the gate survives a green run of this suite, the suite is missing
that case.

## How the gate decides

A workflow run for the exact head SHA is authoritative for completion, because
a run only reaches `success` once every one of its jobs has finished. Check runs
alone are not enough — they are created one job at a time, so an early pass can
see only a prefix of the matrix.

Only the newest run for that head is adjudicated. Each pass that finds no
verdict requests a new run and GitHub keeps the superseded ones, so counting
every run would leave a cancelled or failed ancestor on the record forever and
the gate would never merge.

Before merging, the gate re-reads the head and hands the adjudicated SHA to
`gh pr merge --match-head-commit`, so a late push fails the merge instead of
landing a commit this pass never looked at. That late move is a benign race but
it is not silent: the merge is refused, the step reports an error and the pass
runs red. It self-clears on the next pass.

## Guarded and unguarded calls

Transient `gh` failures are handled at different levels, and the distinction is
load-bearing:

- **Guarded** calls wrap in `if ! ...; then` and report a `::error` annotation
  with the standard GitHub Actions syntax, set `fail=1`, and continue to the
  next PR. The head re-read and the check-runs query are guarded this way.
- **Unguarded** calls are bare command substitutions, so a transient error
  aborts the step under `set -euo pipefail` with no annotation, or — inside a
  test — compares as empty and silently takes the false branch. `gh pr list`,
  `gh pr view --json autoMergeRequest`, `gh pr view --json state` and
  `gh pr view --json createdAt` are still unguarded.

Scenario 15 in the test suite pins the unguarded `autoMergeRequest` behaviour so
converting it later is a deliberate, visible change rather than an accident.

## Stall timer

A release PR still open after `STALL_HOURS` is reported as stalled, so a PR
whose checks never went green surfaces instead of sitting silently. The check
is skipped when a pass `continue`s before reaching it — merging or skipping
this pass is normal, and neither should raise a stall.
