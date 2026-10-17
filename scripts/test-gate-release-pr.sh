#!/usr/bin/env bash
# Scenario tests for scripts/gate-release-pr.sh.
#
# The gate is pure shell around a handful of `gh` calls, so the tests put a stub
# `gh` on PATH and assert on the workflow commands and exit codes the gate emits
# for each situation it has to adjudicate. No network, no real repository.
#
# Run directly:   bash scripts/test-gate-release-pr.sh
# Every scenario is independent; the stub is rebuilt for each one.
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
GATE="$HERE/gate-release-pr.sh"
STUB_ROOT="$HERE/.gate-stub"

if [ ! -f "$GATE" ]; then
  echo "missing gate script: $GATE" >&2
  exit 1
fi

H1=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
H2=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
CREATED_AT=$(date -u -d "-1 hour" +%Y-%m-%dT%H:%M:%SZ)

failures=0

build_stub() {
  local dir="$STUB_ROOT/bin"
  rm -rf "$STUB_ROOT"; mkdir -p "$dir"

  # Emulates the two gh/gojq expression shapes the gate uses against a JSON
  # payload on stdin. Cross-checked against real gh output: a match prints
  # "<status>|<conclusion>" lines, no match prints nothing and exits 0.
  cat > "$dir/jqemu.py" <<'PYEOF'
import sys, json, re
expr = sys.argv[1]
first_only = ".[0] // empty" in expr
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("check_runs", [])
m = re.search(r'\.headSha\s*==\s*"([^"]+)"', expr)
rows = []
for it in items:
    if m and it.get("headSha") != m.group(1):
        continue
    st, co = it.get("status"), it.get("conclusion")
    rows.append("%s|%s" % (st if st is not None else "", co if co is not None else ""))
if first_only:
    rows = rows[:1]
for r in rows:
    print(r)
PYEOF

  cat > "$dir/gh" <<'EOS'
#!/usr/bin/env bash
echo "gh $*" >> "$GH_LOG"
sub="$1"; shift
case "$sub" in
  pr)
    op="$1"; shift
    case "$op" in
      list)
        if [ "${FAIL_PR_LIST:-0}" = "1" ]; then
          echo "gh: transient API error" >&2; exit 1
        fi
        printf '%s\n' "$PR_ENTRY" ;;
      view)
        shift   # the PR number
        field=""
        while [ $# -gt 0 ]; do
          case "$1" in --json) field="$2"; shift 2;; --jq) shift 2;; *) shift;; esac
        done
        case "$field" in
          headRefOid)
            if [ "${FAIL_HEADREF:-0}" = "1" ]; then
              echo "gh: transient API error" >&2; exit 1
            fi
            # MERGE_TIME_SHA models a head that moves immediately after the
            # re-read: the first read still returns the old head (otherwise the
            # gate would take the "head moved" branch and never reach the
            # merge), and every later read reports the new one.
            if [ -n "${MERGE_TIME_SHA:-}" ] && [ -f "$RERead_FLAG" ]; then
              printf '%s\n' "$MERGE_TIME_SHA"
            else
              [ -n "${MERGE_TIME_SHA:-}" ] && : > "$RERead_FLAG"
              printf '%s\n' "$CURRENT_SHA"
            fi ;;
          autoMergeRequest)
            if [ "${FAIL_AUTOMERGE:-0}" = "1" ]; then
              echo "gh: transient API error" >&2; exit 1
            fi
            printf '%s\n' "${AUTOMERGE_NULL:-true}" ;;
          state)
            if [ "${FAIL_STATE:-0}" = "1" ]; then
              echo "gh: transient API error" >&2; exit 1
            fi
            if [ -f "$MERGED_FLAG" ]; then printf 'MERGED\n'; else printf 'OPEN\n'; fi ;;
          createdAt)
            printf '%s\n' "$CREATED_AT" ;;
          *) echo "gh stub: unexpected --json $field" >&2; exit 2 ;;
        esac ;;
      merge)
        # Honour --match-head-commit the way the API does: refuse when the
        # branch head no longer matches the SHA the caller verified. The gate
        # must hand the SHA it adjudicated ($head_sha), not the re-read one, so
        # record what was passed and let the scenario assert on it.
        want=""; has=0
        while [ $# -gt 0 ]; do
          if [ "$1" = "--match-head-commit" ]; then has=1; want="$2"; shift 2; else shift; fi
        done
        echo "MERGE_MATCH $want" >> "$GH_LOG"
        effective="$CURRENT_SHA"
        [ -n "${MERGE_TIME_SHA:-}" ] && effective="$MERGE_TIME_SHA"
        if [ "$has" = "1" ] && [ "$want" != "$effective" ]; then
          echo "gh: HEAD mismatch: expected $want but head is $effective" >&2
          exit 1
        fi
        : > "$MERGED_FLAG" ;;
      *) echo "gh stub: unexpected pr $op" >&2; exit 2 ;;
    esac ;;
  run)
    shift   # "list"
    jqexpr=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--jq" ]; then jqexpr="$2"; shift 2; else shift; fi
    done
    python3 "$STUB_DIR/jqemu.py" "$jqexpr" < "$RUNS_JSON" ;;
  api)
    if [ "${FAIL_CHECKS:-0}" = "1" ]; then
      echo "gh: HTTP 403" >&2; exit 1
    fi
    jqexpr=""
    while [ $# -gt 0 ]; do
      if [ "$1" = "--jq" ]; then jqexpr="$2"; shift 2; else shift; fi
    done
    python3 "$STUB_DIR/jqemu.py" "$jqexpr" < "$CHECKS_JSON" ;;
  workflow)
    shift   # "run"
    if [ "${FAIL_DISPATCH:-0}" = "1" ]; then
      echo "gh: transient API error" >&2; exit 1
    fi
    echo "DISPATCH $1" >> "$GH_LOG" ;;
  *) echo "gh stub: unexpected $sub" >&2; exit 2 ;;
esac
EOS
  chmod +x "$dir/gh"
}

# run_case <name> <runs-json> <checks-json> <current-sha> <merge-time-sha> \
#          <expect-rc> <expect-verdict>
# verdict tokens: merged | ci_request | wait | skip | error | stalled
run_case() {
  local name="$1" runs="$2" checks="$3" current="$4" mtime="$5" exp_rc="$6" exp_verdict="$7"
  local d; d=$(mktemp -d)
  echo "$runs" > "$d/runs.json"
  echo "$checks" > "$d/checks.json"

  GH_LOG="$d/gh.log" MERGED_FLAG="$d/merged" RERead_FLAG="$d/reread" RUNS_JSON="$d/runs.json" \
  CHECKS_JSON="$d/checks.json" GH_TOKEN=x GH_REPO=dcc-mcp/adobepy \
  STALL_HOURS="${STALL_HOURS:-6}" MERGE_TIMEOUT_SECONDS=5 MERGE_POLL_SECONDS=0 \
  PR_ENTRY="89 release-please--branches--main $H1" CURRENT_SHA="$current" \
  CREATED_AT="$CREATED_AT" MERGE_TIME_SHA="$mtime" STUB_DIR="$STUB_ROOT/bin" \
  PATH="$STUB_ROOT/bin:/usr/bin:/bin:$PATH" \
  bash "$GATE" > "$d/out" 2>&1
  local rc=$?
  local out; out=$(cat "$d/out")

  local verdict=""
  [ -f "$d/merged" ] && verdict="${verdict}merged,"
  grep -q "DISPATCH ci.yml" "$d/gh.log" 2>/dev/null && verdict="${verdict}ci_request,"
  grep -q "DISPATCH release-please.yml" "$d/gh.log" 2>/dev/null && verdict="${verdict}redispatch,"
  grep -q "CI still running" <<<"$out" && verdict="${verdict}wait,"
  grep -q "skipping this pass" <<<"$out" && verdict="${verdict}skip,"
  grep -q "::error" <<<"$out" && verdict="${verdict}error,"
  grep -q "::warning" <<<"$out" && verdict="${verdict}warning,"
  grep -q "Release PR is stalled" <<<"$out" && verdict="${verdict}stalled,"
  verdict="${verdict%,}"

  local ok=1
  [ "$rc" = "$exp_rc" ] || ok=0
  [ "$verdict" = "$exp_verdict" ] || ok=0

  # The merge must be pinned to the head that was adjudicated ($EXP_MATCH), not
  # to whatever the re-read returned. Catches a merge that silently follows the
  # branch instead of the verified commit.
  if [ -n "${EXP_MATCH:-}" ]; then
    if grep -q "MERGE_MATCH" "$d/gh.log" 2>/dev/null; then
      grep -q "MERGE_MATCH $EXP_MATCH" "$d/gh.log" 2>/dev/null || ok=0
    else
      ok=0
    fi
  fi

  if [ "$ok" = "1" ]; then
    printf 'PASS  %-42s rc=%s  [%s]\n' "$name" "$rc" "$verdict"
  else
    printf 'FAIL  %-42s rc=%s (want %s)  [%s] (want [%s])\n' \
      "$name" "$rc" "$exp_rc" "$verdict" "$exp_verdict"
    sed 's/^/        | /' "$d/out"
    failures=$((failures + 1))
  fi
  rm -rf "$d"
}

build_stub

GREEN='{"check_runs":[{"status":"completed","conclusion":"success"}]}'
NONE='{"check_runs":[]}'
OTHER_HEAD_RUN='[{"headSha":"'$H2'","status":"completed","conclusion":"success"}]'
OKRUNS='[{"headSha":"'$H1'","status":"completed","conclusion":"success"}]'

# 1. Newest run succeeded, an older cancelled run on the same head. The
#    superseded run must not keep CI from being requested or the PR merged.
run_case "1 newest success, older cancelled" \
  '[{"headSha":"'$H1'","status":"completed","conclusion":"success"},{"headSha":"'$H1'","status":"completed","conclusion":"cancelled"}]' \
  "$GREEN" "$H1" "" 0 "merged,redispatch"

# 2. Newest run cancelled, older succeeded: no verdict, so ask for CI again.
run_case "2 newest cancelled, older success" \
  '[{"headSha":"'$H1'","status":"completed","conclusion":"cancelled"},{"headSha":"'$H1'","status":"completed","conclusion":"success"}]' \
  "$GREEN" "$H1" "" 0 "ci_request"

# 3. Newest run failed: refuse to merge and fail the run.
run_case "3 newest failed" \
  '[{"headSha":"'$H1'","status":"completed","conclusion":"failure"}]' \
  "$GREEN" "$H1" "" 1 "error"

# 4. Head moved between the verdict and the re-read: skip this pass, stay green.
run_case "4 head moved before re-read" \
  "$OKRUNS" "$GREEN" "$H2" "" 0 "skip"

# 5. Head moved between the re-read and the merge. --match-head-commit turns
#    that into a failed merge, which is reported as an error and self-clears on
#    the next pass. EXP_MATCH pins the merge to the adjudicated head: passing
#    the re-read SHA here would silently follow the branch instead.
EXP_MATCH="$H1" run_case "5 head moved after re-read" \
  "$OKRUNS" "$GREEN" "$H1" "$H2" 1 "error"

# 6. Single successful run, head unchanged: the plain happy path.
run_case "6 unchanged, single success" \
  "$OKRUNS" "$GREEN" "$H1" "" 0 "merged,redispatch"

# 7. No run for this head and no check runs: request CI.
run_case "7 no run for head, no check runs" \
  "$OTHER_HEAD_RUN" "$NONE" "$H1" "" 0 "ci_request"

# 8. No run for this head but check runs are green: still no authoritative
#    run-level verdict, so request CI.
run_case "8 no run for head, checks green" \
  "$OTHER_HEAD_RUN" "$GREEN" "$H1" "" 0 "ci_request"

# 9. A failed run on a different head must not block this head.
run_case "9 other-head failure, own head success" \
  '[{"headSha":"'$H2'","status":"completed","conclusion":"failure"},{"headSha":"'$H1'","status":"completed","conclusion":"success"}]' \
  "$GREEN" "$H1" "" 0 "merged,redispatch"

# 10. Run still in progress: wait for the next pass.
run_case "10 run in progress" \
  '[{"headSha":"'$H1'","status":"in_progress","conclusion":null}]' \
  "$GREEN" "$H1" "" 0 "wait"

# 11. `gh pr view` transient failure on the head re-read. This is the case the
#     gate was hardened for: fail closed with an annotated error, do not abort
#     the step silently, do not merge.
FAIL_HEADREF=1 run_case "11 head re-read transient failure" \
  "$OKRUNS" "$GREEN" "$H1" "" 1 "error"

# 12. Check-runs query refused: annotated error, no merge.
FAIL_CHECKS=1 run_case "12 check-runs query refused" \
  "$OKRUNS" "$GREEN" "$H1" "" 1 "error"

# 13. CI dispatch refused while requesting a verdict: annotated error.
FAIL_DISPATCH=1 run_case "13 ci dispatch refused" \
  "$OTHER_HEAD_RUN" "$NONE" "$H1" "" 1 "error"

# 14. Final re-dispatch refused after a successful merge: annotated, rc=1.
FAIL_DISPATCH=1 run_case "14 release re-dispatch refused" \
  "$OKRUNS" "$GREEN" "$H1" "" 1 "merged,error"

# 15. Auto-merge query fails. This call is a bare command substitution rather
#     than a guarded one, so a transient failure makes the comparison false and
#     the gate takes the "already enabled" branch: no merge, and the pass only
#     warns. That is the documented pre-existing gap, not the hardened path —
#     scenario 11 covers the guarded form. See docs/release-gate.md.
FAIL_AUTOMERGE=1 run_case "15 auto-merge query fails (unguarded)" \
  "$OKRUNS" "$GREEN" "$H1" "" 0 "warning"

# 16. A release PR open past the stall threshold is reported as stalled. This
#     path must not `continue` before reaching the stall check, so it uses the
#     "no verdict yet" branch rather than the head-moved one.
STALL_HOURS=0 run_case "16 stalled release PR" \
  '[{"headSha":"'$H1'","status":"completed","conclusion":"cancelled"}]' \
  "$GREEN" "$H1" "" 1 "ci_request,error,stalled"

rm -rf "$STUB_ROOT"

echo
if [ "$failures" -ne 0 ]; then
  echo "$failures scenario(s) failed"
  exit 1
fi
echo "all release gate scenarios passed"
