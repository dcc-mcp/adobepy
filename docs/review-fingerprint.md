# Review Diff Fingerprint

A diff fingerprint records the content covered by a review ACK. It can support
reusing that content review after a rebase only when the complete diff still
matches and the reviewer confirms that the new base introduces no relevant
integration changes. It never transfers CI evidence: every new head, including
a rebase with the same fingerprint, needs fresh required checks on that exact
head before merge.

## Canonical recipe: `pr-files-records-v1`

Capture the PR's exact base SHA, head SHA, and `changed_files` count. Fetch all
pages of the [PR-files API](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests-files),
then re-read those PR fields and refuse the receipt if any changed during the
capture. The API returns at most 3,000 files; the fetched count must equal the
captured `changed_files` count, with no duplicate filenames.

Use this recipe only for complete text patches. Missing, binary, or truncated
patches cannot be replaced with an empty string. Check patch completeness
against the actual diff, including hunk lengths and addition/deletion counts;
if it cannot be established, do not reuse an ACK through this recipe.

```text
record = {filename, previous_filename (or null), status, patch}
sort complete records by the UTF-8 bytes of filename
serialize the record array as compact JSON with sorted keys and unescaped Unicode
encode as UTF-8, then append exactly one LF
sha256 -> 64 lowercase hex characters
```

Keep each `patch` string intact, including its line order and whitespace. Only
the file records are sorted. Sorting individual patch lines loses ordering and
can give different code the same fingerprint.

Reference implementation (Python 3, after the completeness checks above):

```bash
gh api --paginate --slurp \
  "repos/$OWNER/$REPO/pulls/$PR/files?per_page=100" > pr-files.json
python - <<'PY'
import hashlib
import json
from pathlib import Path

pages = json.loads(Path("pr-files.json").read_text(encoding="utf-8-sig"))
files = [entry for page in pages for entry in page]
records = []
seen = set()
for entry in files:
    filename = entry["filename"]
    if filename in seen or not isinstance(entry.get("patch"), str):
        raise SystemExit("Duplicate filename or missing text patch; no fingerprint")
    seen.add(filename)
    records.append({
        "filename": filename,
        "previous_filename": entry.get("previous_filename"),
        "status": entry["status"],
        "patch": entry["patch"],
    })
records.sort(key=lambda record: record["filename"].encode("utf-8"))
payload = json.dumps(
    records, ensure_ascii=False, sort_keys=True, separators=(",", ":")
).encode("utf-8") + b"\n"
print(hashlib.sha256(payload).hexdigest())
PY
```

The JSON encoding preserves patch line order while escaping embedded newlines
inside each record. Explicit UTF-8 encoding and a single final LF make the
hashed bytes independent of the shell's output encoding and newline handling.
The snippet hashes the supplied records; it does not replace the capture,
file-count, or patch-completeness checks.

## Storing a fingerprint

Always record the base and head that were reviewed alongside the fingerprint
and its recipe:

```text
(base_sha, head_sha, fp@value, recipe)
```

A bare value is not evidence. Never recompute a historical value to backdate-fix
a mismatch. Receipts using the old `compare-lines-final-lf` recipe cannot be
silently migrated or treated as equivalent: it sorted patch lines and lost
content ordering. Request a fresh review and record a new receipt instead.

If the base or head moves, capture the new pair again. Even when a reviewer
accepts an unchanged content fingerprint, required CI must complete successfully
for the new exact head; a fingerprint or prior ACK cannot substitute for it.

## Recipes that do not work

`git diff <base>...<head> | sha256sum` depends on local diff formatting, including
abbreviated blob IDs, diff algorithms, rename settings, and line endings.

`git patch-id --stable` is useful for finding likely duplicate commits, but
[it ignores whitespace](https://git-scm.com/docs/git-patch-id#Documentation/git-patch-id.txt---stable).
It is not an exact content fingerprint and must not replace this recipe.

Global line sorting is also unsuitable. For example, changing the order of
`+authorize()` and `+execute()` in a patch changes the code while leaving the
sorted lines identical. Sort whole file records and retain the patch order.
