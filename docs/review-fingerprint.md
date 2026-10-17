# Review Diff Fingerprint

A review ACK is bound to the **content** of a pull request, not to its head
SHA. Rebasing a PR onto a moved `main` changes the SHA while leaving the diff
byte-identical, and in that case the ACK stands — re-running the full review
and re-collecting CI evidence would produce no new information.

That only works if both sides can reproduce the fingerprint independently.
This document fixes the recipe so no one has to guess it.

## Canonical recipe: `compare-lines-final-lf`

```text
entries = filename + TAB + patch   # one entry per changed file, from the
                                   # compare or PR-files API
join entries with LF
split the result into LINES
LC_ALL=C sort the lines
append exactly ONE trailing LF
sha256 -> 64 hex chars
```

Reference implementation:

```bash
gh api "repos/$OWNER/$REPO/compare/$BASE...$HEAD" \
  -q '.files[] | .filename + "\t" + (.patch // "")' \
  | LC_ALL=C sort \
  | awk 'BEGIN{ORS=""} {print $0 "\n"}' \
  | sha256sum
```

The `awk` step is what guarantees the single trailing LF regardless of whether
the API's last line ended with one. Do not drop it.

## Storing a fingerprint

Always record the atomic triple:

```text
(base_sha, fp@value, recipe)
```

A bare value is not evidence — it says nothing about what was hashed or
against which base. Never recompute a historical value to backdate-fix a
mismatch; if the recorded value cannot be reproduced, treat the ACK as void
and request a fresh review.

## Recipes that do not work

`git diff <base>...<head> | sha256sum` looks equivalent and is not. The
`index` line embeds blob hashes whose width depends on `core.abbrev`, which
differs across clones and platforms: the same diff on `ac91d22` hashes to
`b26fa531…` at `abbrev=7` and `b047cc2c…` at `abbrev=40`. It also varies with
`diff.algorithm`, `diff.renames`, and CRLF settings.

If a git-only fingerprint is ever needed, use patch-id, which is invariant to
all of those:

```bash
git diff <base>...<head> | git patch-id --stable
```

It still detects content and whitespace changes. It is a fallback, not the
canonical recipe.

## Why not a bare `sha256sum` of the patch text

Patching the API response through shell pipelines introduces trailing-newline
and locale-ordering drift between a Windows shell and a Linux runner. Sorting
lines under `LC_ALL=C` and pinning the trailing newline removes both.
