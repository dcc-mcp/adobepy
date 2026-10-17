#!/usr/bin/env bash
# Gate the release PR on green checks, merge it, then re-dispatch this workflow
# to cut the release.
#
# Extracted verbatim from the "Gate and merge the release PR" step of
# .github/workflows/release-please.yml so the logic can be driven by a stub
# `gh` in tests. The workflow calls this script with the same env it used to
# inline: GH_TOKEN, GH_REPO, STALL_HOURS, MERGE_TIMEOUT_SECONDS,
# MERGE_POLL_SECONDS. Behaviour is identical; keep the two in sync.
#
# Defaults below mirror the workflow `env:` block so the script stays runnable
# on its own.
# Guardrails run before the extracted block's own `set -euo pipefail`.
: "${GH_REPO:?GH_REPO is required}"
: "${STALL_HOURS:=6}"
: "${MERGE_TIMEOUT_SECONDS:=300}"
: "${MERGE_POLL_SECONDS:=15}"
set -euo pipefail
prs=$(gh pr list --base main --limit 100 --state open --json number,headRefName,headRefOid \
  --jq '.[] | select(.headRefName | startswith("release-please--branches--main")) | "\(.number) \(.headRefName) \(.headRefOid)"')
if [ -z "$prs" ]; then
  echo "No open release PR; nothing to fast-forward."
  exit 0
fi

mapfile -t entries <<< "$prs"
if [ "${#entries[@]}" -ne 1 ]; then
  echo "::warning title=Unexpected release PR count::Found ${#entries[@]} open release PRs; merging more than one would collide on PyPI."
fi

request_ci() {
  echo "  requesting CI on $branch"
  if ! gh workflow run ci.yml --ref "$branch"; then
    echo "::error title=CI dispatch failed::Could not start ci.yml on $branch"
    fail=1
  fi
}

fail=0
merged=0
for entry in "${entries[@]}"; do
  read -r number branch head_sha <<< "$entry"
  echo "Release PR #$number on $branch at $head_sha"
  landed=0

  # Check runs are created one job at a time, so "nothing is pending"
  # is not the same as "every job has run": a pass that lands early
  # enough could see only a prefix of the CI matrix. The ci.yml run
  # for this exact head is authoritative for completion, because a
  # workflow run only reaches `success` once every one of its jobs
  # has finished successfully.
  #
  # Filtering on the head SHA is what makes that safe: release-please
  # reuses the same branch across release cycles, so an older run on
  # this branch would otherwise clear a head that was never verified.
  #
  # Only the newest run for that head is adjudicated. A head can
  # carry several runs — each pass that finds no verdict asks for a
  # new one, and GitHub keeps the superseded ones — and the check-run
  # side already collapses those with `filter=latest`. Counting every
  # run here would leave a cancelled or failed ancestor on the record
  # forever, so the verdict would keep re-requesting CI on a head
  # whose latest run already succeeded, and never merge it. `gh run
  # list` returns runs newest-first, so the first match is the newest.
  if ! ci_raw=$(gh run list --branch "$branch" --workflow ci.yml --limit 50 \
    --json headSha,status,conclusion \
    --jq '[.[] | select(.headSha == "'"$head_sha"'") | "\(.status)|\(.conclusion)"] | .[0] // empty'); then
    echo "::warning title=CI run query failed::Falling back to check runs for $head_sha"
    ci_raw=""
  fi
  ci_total=0; ci_running=0; ci_ok=0; ci_cancelled=0; ci_broken=0
  if [ -n "$ci_raw" ]; then
    ci_total=1
    ci_status="${ci_raw%%|*}"
    ci_conclusion="${ci_raw##*|}"
    if [ "$ci_status" != "completed" ]; then
      ci_running=1
    elif [ "$ci_conclusion" = "success" ]; then
      ci_ok=1
    elif [ "$ci_conclusion" = "cancelled" ]; then
      ci_cancelled=1
    else
      ci_broken=1
    fi
  fi
  echo "  ci.yml: $ci_ok succeeded, $ci_running running, $ci_cancelled cancelled, $ci_broken failed ($ci_total run(s) for $head_sha)"

  check_url="repos/$GH_REPO/commits/$head_sha/check-runs?per_page=100&filter=latest"
  if ! raw=$(gh api --paginate "$check_url" --jq '.check_runs[] | "\(.status)|\(.conclusion)"'); then
    echo "::error title=Check query failed::Could not read check runs for $head_sha"
    fail=1
    continue
  fi
  total=0; pending=0; passed=0; cancelled=0; broken=0
  if [ -n "$raw" ]; then
    mapfile -t runs <<< "$raw"
    total=${#runs[@]}
    for run in "${runs[@]}"; do
      status="${run%%|*}"
      conclusion="${run##*|}"
      if [ "$status" != "completed" ]; then
        pending=$((pending + 1))
      elif [ "$conclusion" = "success" ]; then
        passed=$((passed + 1))
      elif [ "$conclusion" = "cancelled" ]; then
        cancelled=$((cancelled + 1))
      elif [ "$conclusion" = "skipped" ] || [ "$conclusion" = "neutral" ]; then
        :
      else
        broken=$((broken + 1))
      fi
    done
  fi
  echo "  checks: $passed passed, $pending pending, $cancelled cancelled, $broken failed, $total total"

  if [ "$ci_total" -eq 0 ] || [ "$total" -eq 0 ]; then
    echo "  no CI verdict for $head_sha yet"
    request_ci
  elif [ "$ci_running" -gt 0 ] || [ "$pending" -gt 0 ]; then
    echo "  CI still running on $head_sha; waiting for the next pass."
  elif [ "$broken" -gt 0 ] || [ "$ci_broken" -gt 0 ]; then
    echo "::error title=Release PR checks are not green::PR #$number at $head_sha reports $broken failing check(s) and $ci_broken failed ci.yml run(s); refusing to merge it."
    fail=1
  elif [ "$cancelled" -gt 0 ] || [ "$ci_cancelled" -gt 0 ] || [ "$passed" -eq 0 ]; then
    # A cancelled job carries no verdict. Counting it as a failure
    # would strand the release PR until the stall timer fires, so ask
    # for CI again rather than waiting for that.
    echo "  no verdict for $head_sha: $cancelled cancelled check(s), $ci_cancelled cancelled ci.yml run(s), $passed successful check(s)"
    request_ci
  else
    # Every verdict above was computed against $head_sha. `main`
    # declares no required status checks, so auto-merge would land
    # whatever the branch points at when it is armed — including a
    # commit release-please pushed after those queries ran, which
    # this pass never looked at. Two layers close that:
    #
    # 1. Re-read the head and leave the round to the next pass
    #    instead of merging an unverified commit; that pass re-runs
    #    the whole verdict against the new head. Deliberately no CI
    #    request here: the head that would need one is the new one,
    #    and the next pass discovers it.
    # 2. `--match-head-commit` on the merge below. The re-read is
    #    still check-then-act: the head can move between it and the
    #    merge call. Handing the SHA to the API makes GitHub enforce
    #    the match at merge time, so a late move fails the merge
    #    instead of landing an unverified commit.
    #
    #    That late move is a benign race, but it is *not* silent:
    #    `gh pr merge` rejects it, this step reports
    #    `::error title=Auto-merge request failed` and exits
    #    non-zero, so the pass runs red. It self-clears on the next
    #    pass, which re-adjudicates the new head. Read the red run
    #    as "someone pushed mid-pass", not as a defect in the gate.
    # Same degradation contract as the other guarded `gh` calls in
    # this step: a bare assignment under `set -euo pipefail` would
    # abort the whole gate on one transient API error, with no
    # `::error` annotation and no chance to fall through to the stall
    # check. Not every call here is guarded -- the bare `gh pr list`,
    # `--json autoMergeRequest`, `--json state` and `--json createdAt`
    # reads still abort on a transient error, which is left as is
    # until those are converted too.
    if ! current_sha=$(gh pr view "$number" --json headRefOid --jq .headRefOid); then
      echo "::error title=Head re-read failed::could not re-read headRefOid for PR #$number"
      fail=1; continue
    fi
    if [ "$current_sha" != "$head_sha" ]; then
      echo "  head moved under the verdict: judged $head_sha, now $current_sha; skipping this pass."
      continue
    fi

    if [ "$(gh pr view "$number" --json autoMergeRequest --jq '.autoMergeRequest == null')" = "true" ]; then
      echo "  checks are green for $head_sha; enabling auto-merge"
      merge_status=0
      merge_output=$(gh pr merge --auto --squash --match-head-commit "$head_sha" "$number" 2>&1) || merge_status=$?
      [ -z "$merge_output" ] || printf '%s\n' "$merge_output" >&2
      if [ "$merge_status" -ne 0 ]; then
        # GitHub rejects auto-merge when the branch has no required rules.
        # Retry only that exact refusal, retaining the adjudicated head.
        if [ "$merge_status" -eq 1 ] && [ "$merge_output" = 'GraphQL: Pull request Branch does not have required protected branch rules (enablePullRequestAutoMerge)' ]; then
          echo "  auto-merge is unavailable; merging verified $head_sha normally"
          if ! gh pr merge --squash --match-head-commit "$head_sha" "$number"; then
            echo "::error title=Merge request failed::Could not merge #$number at $head_sha after auto-merge was unavailable"
            fail=1
            continue
          fi
        else
          echo "::error title=Auto-merge request failed::Could not enable auto-merge for #$number at $head_sha"
          fail=1
          continue
        fi
      fi
    else
      echo "  auto-merge already enabled."
    fi

    deadline=$(( $(date -u +%s) + MERGE_TIMEOUT_SECONDS ))
    while [ "$(date -u +%s)" -lt "$deadline" ] \
      && [ "$(gh pr view "$number" --json state --jq .state)" = "OPEN" ]; do
      sleep "$MERGE_POLL_SECONDS"
    done

    if [ "$(gh pr view "$number" --json state --jq .state)" = "MERGED" ]; then
      echo "  release PR #$number merged"
      landed=1
      merged=$((merged + 1))
    else
      echo "::warning title=Release PR merge did not land::PR #$number is still open ${MERGE_TIMEOUT_SECONDS}s after auto-merge was armed; the next pass will retry."
    fi
  fi

  if [ "$landed" -eq 0 ]; then
    created_at=$(gh pr view "$number" --json createdAt --jq .createdAt)
    age_hours=$(( ($(date -u +%s) - $(date -u -d "$created_at" +%s)) / 3600 ))
    if [ "$age_hours" -ge "$STALL_HOURS" ]; then
      echo "::error title=Release PR is stalled::PR #$number has been open ${age_hours}h; it should have merged once its checks were green."
      fail=1
    fi
  fi
done

if [ "$merged" -eq 0 ]; then
  exit "$fail"
fi

# The merge commit was pushed by GITHUB_TOKEN, which raises no `push`
# event, so ask for the pass that cuts the tag and publishes it.
echo "Release PR merged; re-dispatching this workflow to cut the release."
if ! gh workflow run release-please.yml --ref main; then
  echo "::error title=Release dispatch failed::Could not start release-please.yml on main"
  fail=1
fi

exit "$fail"
