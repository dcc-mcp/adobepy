"""Regressions for the PR #93 review findings (PIP-1191).

These tests reproduce the findings with real-order counterexamples rather than
only exercising a single helper:

* P1 -- a multi-command ``run:`` step on the windows-latest default pwsh shell
  only checks ``$LASTEXITCODE`` after the final command, so "fail then succeed"
  used to be reported as a green step.
* P2 -- ``smoke_wheel_install.py`` required the whole ``doctor`` to exit 0,
  which a wheel-only install can never do (the broker is not shipped in the
  wheel).
* P2 -- ``test:quick``/``test:all`` staged bridges *before* checking them, so
  the committed tree was overwritten and drift could never be detected; the
  staged-host inventory was also never compared as a whole.

Two follow-up counterexamples from the independent coordinator probe are also
covered: a blanket escaped-newline normalization accepted a semantic JS string
change, and a forged ``--isolated-document-id`` still mutated the user's active
layer. The live-smoke regressions prove the ownership gate fails closed and
that the revised ``finally`` restore fixes the visibility snapshot.
"""

from __future__ import annotations

import contextlib
import json
import os
import pathlib
import re
import shutil
import site
import subprocess
import sys
import sysconfig
import tempfile
import types
import unittest
import zipfile
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import scripts.live_photoshop_smoke as live  # noqa: E402
import scripts.smoke_wheel_install as smoke  # noqa: E402
from scripts.check_wheel_bridges import REQUIRED_BRIDGE_FILES  # noqa: E402

CI_FILE = ROOT / ".github/workflows/ci.yml"
RELEASE_FILE = ROOT / ".github/workflows/release.yml"
PACKAGE_FILE = ROOT / "package.json"
CHECK_WHEEL_BRIDGES = ROOT / "scripts" / "check_wheel_bridges.py"

DISTRIBUTION_COMMANDS = (
    "npm run uxp:build",
    "npm run cep:build",
    "python scripts/stage_wheel_bridges.py",
    "python -m build",
    "python -m twine check dist/*",
    "python scripts/check_native_abi3_config.py",
    "python scripts/check_wheel_compat.py dist",
    "python scripts/smoke_wheel_install.py dist",
    "python scripts/check_wheel_bridges.py dist",
)

# The active Windows standalone wheel chain from release.yml. The R1 finding
# was that all seven native commands shared one pwsh `run:` block, so a failing
# command followed by the passing final checker was reported as a green step.
RELEASE_STANDALONE_JOB = "windows-standalone-package"
ACTIVE_WINDOWS_PWSH_JOBS = ("windows-package", "windows-standalone-package")
RETIRED_STANDALONE_JOBS = ("macos-standalone-package", "linux-standalone-package")
RELEASE_WHEEL_COMMANDS = (
    "python -m pip install --upgrade build wheel",
    "npm ci",
    "npm run uxp:build",
    "npm run cep:build",
    "python scripts/stage_wheel_bridges.py",
    "python -m build --wheel --outdir dist",
    "python scripts/check_wheel_bridges.py dist",
)

# Lines that start a real native process in a pwsh step. PowerShell cmdlets and
# `.ps1` calls are in-process and must not be counted here.
_NATIVE_LINE = re.compile(r"^(?:python3?|npm|node|pyoxidizer|gh|pip)\s|^&\s+\$")
# A job-level `if: false` (four-space indent), not the phrase inside comments
# that explain how the disabled macOS/Linux jobs are re-enabled.
_JOB_DISABLED = re.compile(r"(?m)^ {4}if:\s*false\s*$")


def _inline_run_commands(text: str) -> set[str]:
    commands: set[str] = set()
    for line in text.splitlines():
        match = re.match(r"^\s*(?:-\s+)?run:\s*(\S.*)$", line)
        if match and match.group(1).strip() != "|":
            commands.add(match.group(1).strip())
    return commands


def _multiline_run_blocks(text: str) -> list[list[str]]:
    lines = text.splitlines()
    blocks: list[list[str]] = []
    i = 0
    while i < len(lines):
        match = re.match(r"^(\s*)run:\s*\|\s*$", lines[i])
        if not match:
            i += 1
            continue
        indent = len(match.group(1))
        body: list[str] = []
        j = i + 1
        while j < len(lines):
            stripped = lines[j].lstrip(" ")
            current_indent = len(lines[j]) - len(stripped)
            if stripped and current_indent <= indent:
                break
            body.append(stripped)
            j += 1
        blocks.append(body)
        i = j
    return blocks


def _find_pwsh() -> str | None:
    found = shutil.which("pwsh")
    if found:
        return found
    for candidate in (
        r"C:\Program Files\PowerShell\7\pwsh.exe",
        r"C:\Program Files\PowerShell\6\pwsh.exe",
    ):
        if pathlib.Path(candidate).is_file():
            return candidate
    return None


def _pwsh_step(pwsh: str, outcomes: list[int], tmp: pathlib.Path) -> int:
    """Emulate one GitHub Actions default-shell step and return its exit code.

    A native command's non-zero exit lands in ``$LASTEXITCODE``; the generated
    step wrapper inspects that variable only *after the last command*. We model
    each checker's outcome with an explicit assignment so the test never has to
    spawn a second interpreter (flaky on Windows console hosts), while still
    exercising the exact wrapper semantics that produced the false-green.
    """

    script = "\n".join(
        [
            "$ErrorActionPreference = 'stop'",
            *(f"$LASTEXITCODE = {outcome}" for outcome in outcomes),
            "exit $LASTEXITCODE",
        ]
    )
    ps1 = tmp / "step.ps1"
    ps1.write_text(script, encoding="utf-8")
    return subprocess.run(
        [pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(ps1)],
        capture_output=True,
        text=True,
        timeout=20,
    ).returncode


def _job_block(text: str, job: str) -> str:
    """Return the YAML body of one top-level workflow job."""

    lines = text.splitlines()
    header = f"  {job}:"
    for start, line in enumerate(lines):
        if line.rstrip() == header:
            break
    else:
        return ""
    end = len(lines)
    for candidate in range(start + 1, len(lines)):
        if re.match(r"^  [A-Za-z0-9_-]+:\s*$", lines[candidate]):
            end = candidate
            break
    return "\n".join(lines[start:end])


def _synthetic_wheel(tmp: pathlib.Path, name: str, entries) -> pathlib.Path:
    """Build an isolated ZIP with wheel-like names only, not an installable wheel.

    The coordinator counterexample used exactly this fixture: entry names are
    all `check_wheel_bridges.py` inspects, so a passing run proves the checker
    itself succeeded rather than being skipped or short-circuited.
    """

    wheel = tmp / name
    with zipfile.ZipFile(wheel, "w") as archive:
        for entry in entries:
            archive.writestr(entry, b"")
    return wheel


def _ps_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _real_native_pwsh_step(
    pwsh: str,
    body: list[str],
    tmp: pathlib.Path,
    name: str = "step.ps1",
) -> subprocess.CompletedProcess[str]:
    """Run a GitHub Actions pwsh step whose exits come from REAL native calls.

    The generated wrapper prepends `$ErrorActionPreference = 'stop'` and appends
    `if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }`.
    GitHub Actions pins `$PSNativeCommandUseErrorActionPreference` to `$false`,
    so native failures do not throw and only the *last* native exit decides the
    step. Pin it explicitly here so the counterexample is deterministic across
    pwsh 7.3/7.4+ defaults. Unlike `_pwsh_step`, no `$LASTEXITCODE` value is
    ever assigned: each exit is produced by an actual child process.
    """

    script = "\n".join(
        [
            "$ErrorActionPreference = 'stop'",
            "Write-Output ('native_error_preference=' + $PSNativeCommandUseErrorActionPreference)",
            # Match the GitHub Actions pwsh wrapper regardless of the local
            # PowerShell version's default for this preference.
            "$PSNativeCommandUseErrorActionPreference = $false",
            "Write-Output ('pinned_native_error_preference=' + $PSNativeCommandUseErrorActionPreference)",
            *body,
            "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }",
        ]
    )
    ps1 = tmp / name
    ps1.write_text(script, encoding="utf-8")
    return subprocess.run(
        [pwsh, "-NoLogo", "-NoProfile", "-NonInteractive", "-File", str(ps1)],
        capture_output=True,
        text=True,
        timeout=30,
    )


class CiFailPropagationTests(unittest.TestCase):
    def test_distribution_commands_are_single_command_steps(self) -> None:
        text = CI_FILE.read_text(encoding="utf-8")
        inline = _inline_run_commands(text)
        for command in DISTRIBUTION_COMMANDS:
            self.assertIn(command, inline, f"{command!r} is not an inline run step")
        for block in _multiline_run_blocks(text):
            for command in DISTRIBUTION_COMMANDS:
                self.assertNotIn(
                    command,
                    block,
                    f"{command!r} still lives in a multi-command run block",
                )

    @unittest.skipUnless(_find_pwsh(), "pwsh is not available")
    def test_fail_then_succeed_is_green_only_in_the_old_layout(self) -> None:
        """Real-order counterexample: fail-first/succeed-last masks the failure."""

        pwsh = _find_pwsh()
        with tempfile.TemporaryDirectory(prefix="adobepy-pwsh-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            # OLD layout: both checkers share one step; the succeeding final
            # checker resets $LASTEXITCODE and the step is reported green.
            old_exit = _pwsh_step(pwsh, [1, 0], tmp)
            # NEW layout: the failing checker is the last (and only) command of
            # its own step, so the job goes red.
            new_exit = _pwsh_step(pwsh, [1], tmp)

        self.assertEqual(old_exit, 0, "the old multi-command layout should be false-green")
        self.assertNotEqual(new_exit, 0, "the split step must propagate the failure")


class ReleasePathFailPropagationTests(unittest.TestCase):
    """R1 follow-up: the active Windows pwsh chains in release.yml must fail fast.

    The first PR #93 fix only split ci.yml's Windows package job. The active
    `windows-standalone-package` job in release.yml still put seven native
    commands in one pwsh `run:` block, so a real failing command followed by
    the passing `check_wheel_bridges.py` was reported as a green step.
    """

    def test_release_standalone_wheel_commands_are_single_command_steps(self) -> None:
        job = _job_block(
            RELEASE_FILE.read_text(encoding="utf-8"), RELEASE_STANDALONE_JOB
        )
        self.assertTrue(job, "the active Windows standalone job is missing")
        self.assertIsNone(
            _JOB_DISABLED.search(job), "the R1 target job must stay reachable"
        )
        self.assertIn("shell: pwsh", job)

        inline = _inline_run_commands(job)
        for command in RELEASE_WHEEL_COMMANDS:
            self.assertIn(
                command, inline, f"{command!r} is not an inline single-command step"
            )
        for block in _multiline_run_blocks(job):
            for command in RELEASE_WHEEL_COMMANDS:
                self.assertNotIn(
                    command,
                    block,
                    f"{command!r} still shares a multi-command pwsh run block",
                )

    def test_release_pyoxidizer_step_checks_each_native_exit(self) -> None:
        job = _job_block(
            RELEASE_FILE.read_text(encoding="utf-8"), RELEASE_STANDALONE_JOB
        )
        blocks = [
            block
            for block in _multiline_run_blocks(job)
            if any(line.startswith("pyoxidizer build") for line in block)
        ]
        self.assertEqual(len(blocks), 1, "expected exactly one PyOxidizer step")
        block = blocks[0]
        native_indices = [
            index
            for index, line in enumerate(block)
            if line.startswith("python -m pip install pyoxidizer")
            or line.startswith("pyoxidizer build")
        ]
        self.assertEqual(len(native_indices), 2)
        for index in native_indices:
            self.assertIn(
                "$LASTEXITCODE",
                block[index + 1],
                "every native exit in the PyOxidizer step must be checked immediately",
            )

    def test_no_active_windows_pwsh_block_shares_unguarded_native_exits(self) -> None:
        text = RELEASE_FILE.read_text(encoding="utf-8")
        for job_name in ACTIVE_WINDOWS_PWSH_JOBS:
            job = _job_block(text, job_name)
            self.assertTrue(job, job_name)
            self.assertIsNone(
                _JOB_DISABLED.search(job), f"{job_name} must remain reachable"
            )
            for block in _multiline_run_blocks(job):
                native_indices = [
                    index
                    for index, line in enumerate(block)
                    if _NATIVE_LINE.match(line)
                ]
                if len(native_indices) < 2:
                    # A single native command is the last command of the step,
                    # or is followed by its own guard; either is decisive.
                    continue
                for index in native_indices:
                    self.assertIn(
                        "$LASTEXITCODE",
                        block[index + 1],
                        f"{job_name}: native exits are shared without a guard",
                    )

    def test_manual_release_does_not_duplicate_standalone_publishers(self) -> None:
        text = RELEASE_FILE.read_text(encoding="utf-8")
        for job_name in RETIRED_STANDALONE_JOBS:
            job = _job_block(text, job_name)
            self.assertFalse(job, f"{job_name} belongs only to release-please.yml")

    @unittest.skipUnless(_find_pwsh(), "pwsh is not available")
    def test_real_native_fail_then_succeed_is_false_green_only_when_unguarded(
        self,
    ) -> None:
        """Reproduce R1 with real child processes, not assigned exit codes.

        A real native command exits 7, then the real `check_wheel_bridges.py`
        succeeds against an isolated synthetic wheel. The unguarded wrapper
        exits 0; the guarded and split variants propagate the failure. This
        proves only that the *step* was false-green -- downstream missing-wheel,
        PyOxidizer and smoke gates are separate and are not exercised here.
        """

        pwsh = _find_pwsh()
        with tempfile.TemporaryDirectory(prefix="adobepy-release-pwsh-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            good = _synthetic_wheel(
                tmp, "synthetic-checker-fixture.whl", REQUIRED_BRIDGE_FILES
            )
            py = _ps_quote(sys.executable)
            checker = _ps_quote(CHECK_WHEEL_BRIDGES)
            failing = f"& {py} -c 'import sys; sys.exit(7)'"
            passing = f"& {py} -I -B {checker} {_ps_quote(good)}"
            report = "Write-Output ('first_native_exit=' + $LASTEXITCODE)"

            unguarded = _real_native_pwsh_step(
                pwsh,
                [
                    failing,
                    report,
                    passing,
                    "Write-Output ('last_checker_exit=' + $LASTEXITCODE)",
                ],
                tmp,
                "unguarded.ps1",
            )
            guarded = _real_native_pwsh_step(
                pwsh,
                [
                    failing,
                    report,
                    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
                    passing,
                ],
                tmp,
                "guarded.ps1",
            )
            throw_guarded = _real_native_pwsh_step(
                pwsh,
                [
                    failing,
                    report,
                    "if ($LASTEXITCODE -ne 0) { throw 'native command failed' }",
                    passing,
                ],
                tmp,
                "throw-guarded.ps1",
            )
            split = _real_native_pwsh_step(
                pwsh, [failing, report], tmp, "split.ps1"
            )
            all_green = _real_native_pwsh_step(
                pwsh,
                [f"& {py} -c 'import sys; sys.exit(0)'", passing],
                tmp,
                "all-green.ps1",
            )

        self.assertEqual(
            unguarded.returncode,
            0,
            "unguarded fail-first/succeed-last must reproduce the false-green: "
            + unguarded.stdout
            + unguarded.stderr,
        )
        self.assertIn("pinned_native_error_preference=False", unguarded.stdout)
        self.assertIn("bundled bridges:", unguarded.stdout)
        self.assertEqual(guarded.returncode, 7, guarded.stdout + guarded.stderr)
        self.assertNotEqual(
            throw_guarded.returncode, 0, throw_guarded.stdout + throw_guarded.stderr
        )
        self.assertEqual(split.returncode, 7, split.stdout + split.stderr)
        self.assertEqual(
            all_green.returncode, 0, all_green.stdout + all_green.stderr
        )

    @unittest.skipUnless(_find_pwsh(), "pwsh is not available")
    def test_real_checker_rejects_missing_bridge_entries(self) -> None:
        """The final checker genuinely fails a wheel missing bridge entries.

        This control keeps the false-green counterexample honest: the passing
        final command above is a real checker that exits 0 on a complete wheel
        and 1 on one missing the required entries. It is a synthetic ZIP with
        entry names only, not a real installable wheel, and no release, upload
        or downstream gate is claimed to have succeeded.
        """

        pwsh = _find_pwsh()
        with tempfile.TemporaryDirectory(prefix="adobepy-release-checker-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            complete = _synthetic_wheel(tmp, "complete.whl", REQUIRED_BRIDGE_FILES)
            missing = _synthetic_wheel(
                tmp, "missing-entries.whl", ("adobe/photoshop/session.py",)
            )
            py = _ps_quote(sys.executable)
            checker = _ps_quote(CHECK_WHEEL_BRIDGES)

            accepted = _real_native_pwsh_step(
                pwsh,
                [f"& {py} -I -B {checker} {_ps_quote(complete)}"],
                tmp,
                "accepted.ps1",
            )
            rejected = _real_native_pwsh_step(
                pwsh,
                [f"& {py} -I -B {checker} {_ps_quote(missing)}"],
                tmp,
                "rejected.ps1",
            )

        self.assertEqual(
            accepted.returncode, 0, accepted.stdout + accepted.stderr
        )
        self.assertIn("bundled bridges:", accepted.stdout)
        self.assertEqual(
            rejected.returncode, 1, rejected.stdout + rejected.stderr
        )
        self.assertIn("does not bundle bridge templates", rejected.stderr)


class PackageOrderTests(unittest.TestCase):
    def test_check_precedes_stage_in_both_test_scripts(self) -> None:
        scripts = json.loads(PACKAGE_FILE.read_text(encoding="utf-8"))["scripts"]
        for name in ("test:quick", "test:all"):
            body = scripts[name]
            self.assertLess(
                body.index("npm run bridges:check"),
                body.index("npm run bridges:stage"),
                f"{name} must compare the committed tree before overwriting it",
            )

    def test_real_order_counterexample_detects_committed_drift(self) -> None:
        """Exercise the actual CLI in both orders against a stale staged byte."""

        with tempfile.TemporaryDirectory(prefix="adobepy-stage-order-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            files = {
                "uxp/photoshop/manifest.json": '{"id":"ps"}',
                "uxp/photoshop/index.html": "<html></html>",
                "uxp/photoshop/src/main.ts": "export const a=1;",
                "uxp/photoshop/dist/main.js": "console.log('v1');",
                "cep/after-effects/CSXS/manifest.xml": "<manifest/>",
                "cep/after-effects/index.html": "<html></html>",
                "cep/after-effects/dist/main.js": "console.log('v1');",
                "cep/after-effects/dist/dom.jsx": "var x=1;",
            }
            for rel, content in files.items():
                path = bridge_root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")

            def cli(*extra: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                        "--bridge-root",
                        str(bridge_root),
                        "--stage-root",
                        str(stage_root),
                        *extra,
                    ],
                    capture_output=True,
                    text=True,
                )

            # Build a correct staged tree first (this also creates the dirs).
            self.assertEqual(cli().returncode, 0)
            stale = stage_root / "uxp" / "photoshop" / "dist" / "main.js"
            self.assertTrue(stale.is_file())

            # OLD order (stage, then check): staging overwrites the stale byte,
            # so the subsequent check passes and the committed drift is masked.
            stale.write_text("console.log('STALE');", encoding="utf-8")
            self.assertEqual(cli().returncode, 0)
            self.assertEqual(cli("--check").returncode, 0)
            self.assertNotIn("STALE", stale.read_text(encoding="utf-8"))

            # NEW order (check, then stage): checking first must fail loudly and
            # leave the stale byte in place for inspection.
            stale.write_text("console.log('STALE');", encoding="utf-8")
            before = cli("--check")
            self.assertNotEqual(before.returncode, 0)
            self.assertIn("stale", before.stderr)
            self.assertIn("STALE", stale.read_text(encoding="utf-8"))

    def test_retired_source_host_is_detected_in_staged_inventory(self) -> None:
        with tempfile.TemporaryDirectory(prefix="adobepy-retired-host-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            for kind, host, artifacts in (
                ("uxp", "photoshop", ("dist/main.js", "index.html", "manifest.json")),
                ("cep", "after-effects", ("dist/main.js", "dist/dom.jsx", "index.html")),
            ):
                for artifact in artifacts:
                    path = bridge_root / kind / host / artifact
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("built", encoding="utf-8")
            self.assertEqual(
                subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                        "--bridge-root",
                        str(bridge_root),
                        "--stage-root",
                        str(stage_root),
                    ],
                    capture_output=True,
                    text=True,
                ).returncode,
                0,
            )
            # Retire a whole source host; its staged copy is never visited by the
            # per-file comparison, so only a whole-inventory check can catch it.
            shutil.rmtree(bridge_root / "cep" / "after-effects")
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                    "--bridge-root",
                    str(bridge_root),
                    "--stage-root",
                    str(stage_root),
                    "--check",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("hosts the source no longer builds", result.stderr)

    def test_line_ending_only_differences_do_not_fail_the_check(self) -> None:
        """A Windows checkout is CRLF and LF-escaped sourcemaps; still green.

        The reorder makes `bridges:check` read the committed tree before it is
        overwritten. On Windows that tree has CRLF line endings and sourcemaps
        with JSON-escaped CRLF, while a fresh esbuild output uses LF. Without
        canonicalization this would be a false positive on every Windows run.
        """

        with tempfile.TemporaryDirectory(prefix="adobepy-eol-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            js_lf = b"console.log('v1');\nconsole.log('v2');"
            js_crlf = b"console.log('v1');\r\nconsole.log('v2');"
            # A sourcemap embeds source text as JSON-escaped newlines.
            map_lf = b'{"version":3,"sourcesContent":["const a=1;\\nconst b=2;"]}'
            map_crlf = b'{"version":3,"sourcesContent":["const a=1;\\r\\nconst b=2;"]}'
            files = {
                "uxp/photoshop/manifest.json": b'{"id":"ps"}',
                "uxp/photoshop/index.html": b"<html></html>",
                "uxp/photoshop/dist/main.js": js_lf,
                "uxp/photoshop/dist/main.js.map": map_lf,
                "cep/after-effects/CSXS/manifest.xml": b"<manifest/>",
                "cep/after-effects/index.html": b"<html></html>",
                "cep/after-effects/dist/main.js": js_lf,
                "cep/after-effects/dist/dom.jsx": b"var x=1;",
            }
            for rel, content in files.items():
                path = bridge_root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)

            def cli(*extra: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                        "--bridge-root",
                        str(bridge_root),
                        "--stage-root",
                        str(stage_root),
                        *extra,
                    ],
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(cli().returncode, 0)
            # Simulate a CRLF checkout of the tracked staged tree.
            (stage_root / "uxp/photoshop/dist/main.js").write_bytes(js_crlf)
            (stage_root / "uxp/photoshop/dist/main.js.map").write_bytes(map_crlf)
            result = cli("--check")
            self.assertEqual(result.returncode, 0, result.stderr)

            # Real content drift alongside the CRLF must still be caught.
            (stage_root / "uxp/photoshop/dist/main.js").write_bytes(
                b"console.log('STALE');\r\nconsole.log('v2');"
            )
            drift = cli("--check")
            self.assertNotEqual(drift.returncode, 0)
            self.assertIn("stale", drift.stderr)

    def test_semantic_escaped_crlf_in_js_is_rejected(self) -> None:
        """Failing-before/fixed-after: a JS separator is content, not an EOL.

        The independent coordinator probe built a two-character separator
        against a staged one-character separator. The old blanket
        escaped-newline canonicalizer equated them and accepted the drift.
        Reproduce that canonicalizer locally to prove it masks the difference,
        then require the real CLI to reject the same pair.
        """

        backslash = bytes([92])
        source_js = (
            b'globalThis.separator="' + backslash + b"r" + backslash
            + b"n" + b'";' + bytes([10])
        )
        staged_js = b'globalThis.separator="' + backslash + b"n" + b'";' + bytes([10])
        with tempfile.TemporaryDirectory(prefix="adobepy-semantic-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            files = {
                "uxp/photoshop/manifest.json": b"{}",
                "uxp/photoshop/index.html": b"<html/>",
                "uxp/photoshop/dist/main.js": source_js,
            }
            for rel, content in files.items():
                path = bridge_root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)

            def cli(*extra: str) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                        "--bridge-root",
                        str(bridge_root),
                        "--stage-root",
                        str(stage_root),
                        *extra,
                    ],
                    capture_output=True,
                    text=True,
                )

            self.assertEqual(cli().returncode, 0)
            (stage_root / "uxp" / "photoshop" / "dist" / "main.js").write_bytes(
                staged_js
            )

            def old_canonical(data: bytes) -> bytes:
                return data.replace(bytes([13, 10]), bytes([10])).replace(
                    backslash + b"r" + backslash + b"n", backslash + b"n"
                )

            self.assertEqual(
                old_canonical(source_js),
                old_canonical(staged_js),
                "the old blanket canonicalizer did mask this semantic drift",
            )
            result = cli("--check")
            self.assertNotEqual(result.returncode, 0, "semantic drift must fail")
            self.assertIn("stale", result.stderr)

    def test_semantic_string_drift_inside_a_sourcemap_is_rejected(self) -> None:
        """Format-aware handling must not hide a JS literal in sourcesContent."""

        backslash = chr(92)
        quote = chr(34)
        source_text = (
            "globalThis.separator=" + quote + backslash + "r" + backslash
            + "n" + quote + ";"
        )
        staged_text = "globalThis.separator=" + quote + backslash + "n" + quote + ";"
        map_src = json.dumps({"version": 3, "sourcesContent": [source_text]}).encode()
        map_stg = json.dumps({"version": 3, "sourcesContent": [staged_text]}).encode()
        with tempfile.TemporaryDirectory(prefix="adobepy-map-semantic-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            files = {
                "uxp/photoshop/manifest.json": b"{}",
                "uxp/photoshop/index.html": b"<html/>",
                "uxp/photoshop/dist/main.js": b"console.log(1);",
                "uxp/photoshop/dist/main.js.map": map_src,
            }
            for rel, content in files.items():
                path = bridge_root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            result = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                    "--bridge-root",
                    str(bridge_root),
                    "--stage-root",
                    str(stage_root),
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            (stage_root / "uxp" / "photoshop" / "dist" / "main.js.map").write_bytes(
                map_stg
            )
            drift = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                    "--bridge-root",
                    str(bridge_root),
                    "--stage-root",
                    str(stage_root),
                    "--check",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(drift.returncode, 0)
            self.assertIn("stale", drift.stderr)

    def test_malformed_sourcemap_is_rejected(self) -> None:
        """A .map that is not JSON is drift, never an implicit pass."""

        with tempfile.TemporaryDirectory(prefix="adobepy-bad-map-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            bridge_root = tmp / "bridges"
            stage_root = tmp / "staged"
            files = {
                "uxp/photoshop/manifest.json": b"{}",
                "uxp/photoshop/index.html": b"<html/>",
                "uxp/photoshop/dist/main.js": b"console.log(1);",
                "uxp/photoshop/dist/main.js.map": b'{"version":3}',
            }
            for rel, content in files.items():
                path = bridge_root / rel
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
            self.assertEqual(
                subprocess.run(
                    [
                        sys.executable,
                        "-I",
                        str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                        "--bridge-root",
                        str(bridge_root),
                        "--stage-root",
                        str(stage_root),
                    ],
                    capture_output=True,
                    text=True,
                ).returncode,
                0,
            )
            (stage_root / "uxp" / "photoshop" / "dist" / "main.js.map").write_bytes(
                b"not-json"
            )
            drift = subprocess.run(
                [
                    sys.executable,
                    "-I",
                    str(ROOT / "scripts" / "stage_wheel_bridges.py"),
                    "--bridge-root",
                    str(bridge_root),
                    "--stage-root",
                    str(stage_root),
                    "--check",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(drift.returncode, 0)
            self.assertIn("stale", drift.stderr)


def _doctor_report(*, overrides: dict | None = None) -> str:
    checks = [
        {"name": "sdk", "ok": True, "detail": "adobepy 0.11.0"},
        {"name": "python_runtime", "ok": True, "detail": sys.executable},
        {"name": "broker_executable", "ok": False, "detail": "not found"},
        {"name": "broker_port", "ok": False, "detail": "health -> URLError"},
        {
            "name": "bridge_templates",
            "ok": True,
            "detail": ".../site-packages/adobe/_bridges",
        },
    ]
    if overrides:
        by_name = {check["name"]: check for check in checks}
        for name, patch in overrides.items():
            if patch is None:
                checks = [c for c in checks if c["name"] != name]
            else:
                by_name[name].update(patch)
    return json.dumps(checks)


class WheelOnlyDoctorTests(unittest.TestCase):
    def _invoke(self, report: str, returncode: int = 1):
        doctor = subprocess.CompletedProcess([], returncode, stdout=report, stderr="")
        with mock.patch.object(smoke, "run") as install, mock.patch.object(
            smoke.subprocess, "run", return_value=doctor
        ) as doctor_run:
            smoke.smoke_bridge_install(pathlib.Path("python"), pathlib.Path("."))
        return install, doctor_run

    def test_valid_wheel_without_runtime_passes(self) -> None:
        # Previously this raised on `doctor.returncode != 0`. A wheel-only
        # install is expected to exit 1 because the broker is not shipped.
        install, doctor_run = self._invoke(_doctor_report(), returncode=1)
        self.assertEqual(install.call_count, 1)
        self.assertEqual(
            doctor_run.call_args.args[0][1:], ["-m", "adobe", "doctor", "--json"]
        )

    def test_all_checks_ok_also_passes(self) -> None:
        report = _doctor_report(
            overrides={"broker_executable": {"ok": True}, "broker_port": {"ok": True}}
        )
        self._invoke(report, returncode=0)

    def test_malformed_json_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            self._invoke("Traceback (most recent call last): ...", returncode=1)
        self.assertIn("parseable JSON", str(ctx.exception))

    def test_unexpected_report_shape_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            self._invoke(json.dumps({"sdk": True}), returncode=1)

    def test_failed_bridge_templates_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            self._invoke(_doctor_report(overrides={"bridge_templates": {"ok": False}}))
        self.assertIn("bridge_templates", str(ctx.exception))

    def test_templates_from_source_checkout_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            self._invoke(
                _doctor_report(
                    overrides={"bridge_templates": {"detail": "/repo/python/adobe"}}
                )
            )
        self.assertIn("adobe/_bridges", str(ctx.exception))

    def test_unexpected_failing_check_is_not_ignored(self) -> None:
        # Proves the fix does not "ignore all errors": a genuine new failure
        # outside the explicit allow-list must still fail the smoke.
        report = json.dumps(
            json.loads(_doctor_report())
            + [{"name": "license", "ok": False, "detail": "expired"}]
        )
        with self.assertRaises(SystemExit) as ctx:
            self._invoke(report)
        self.assertIn("license", str(ctx.exception))

    def test_missing_required_check_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            self._invoke(_doctor_report(overrides={"sdk": None}))

    def test_missing_runtime_diagnostic_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            self._invoke(_doctor_report(overrides={"broker_port": None}))

    def test_crash_exit_code_is_rejected(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            self._invoke(_doctor_report(), returncode=2)
        self.assertIn("expected 0 or 1", str(ctx.exception))


class _FakeLayer:
    def __init__(self, visible: bool | None = True) -> None:
        self.id = 7
        self.name = "scratch"
        self.visible = visible


class _FakeDocument:
    def __init__(self, doc_id: int | str, layers: list[_FakeLayer]) -> None:
        self.id = doc_id
        self.name = "adobepy-scratch"
        self._layers = layers

    @property
    def layers(self) -> list[_FakeLayer]:
        return list(self._layers)


class _FakeApp:
    """A fake facade whose active layer is deliberately NOT the owned layer."""

    def __init__(
        self, layer: _FakeLayer, active_id: int = 42, fail_on_call: int = 99
    ) -> None:
        self.layer = layer
        self.calls = 0
        self.fail_on_call = fail_on_call
        self.targets: list[tuple[str, object]] = []
        self.version = "26.0"
        self.client = types.SimpleNamespace(
            broker_url="http://127.0.0.1:47391", target="default"
        )
        self.active_document = _FakeDocument(active_id, [])
        self.user_layer = _FakeLayer(True)
        self.user_layer.id = 7
        self.active_layers = [self.user_layer]

    def capabilities(self) -> list:
        return []

    @contextlib.contextmanager
    def execute_as_modal(self, command_name: str | None = None):
        yield

    def batch_play(self, descriptors, modal: bool = False) -> None:
        self.calls += 1
        if self.calls == self.fail_on_call:
            raise RuntimeError("simulated show failure")
        self.targets.append(
            (descriptors[0]["_obj"], descriptors[0]["_target"][0].get("_id"))
        )
        self.layer.visible = descriptors[0]["_obj"] == "show"


def _unsafe_visibility_cycle(app: _FakeApp, layer: _FakeLayer) -> None:
    """The original hide/show path: no visibility snapshot, no finally."""

    with app.execute_as_modal(command_name="adobepy live smoke hide/show"):
        app.batch_play([live.hide_show_descriptor("hide", layer.id)], modal=True)
        app.batch_play([live.hide_show_descriptor("show", layer.id)], modal=True)


class LiveSmokeSafetyTests(unittest.TestCase):
    def _owned(self, app: _FakeApp, layer: _FakeLayer) -> live.IsolatedDocument:
        app.active_document = _FakeDocument(app.active_document.id, [layer])
        return live.IsolatedDocument(app.active_document, "run-nonce")

    @contextlib.contextmanager
    def _wheel_env(self, tmp: pathlib.Path, *, extra_path=(), pythonpath: str = ""):
        """Model a clean venv without changing the real interpreter."""

        purelib = tmp / ".venv" / "Lib" / "site-packages"
        (purelib / "adobe").mkdir(parents=True)
        origin = purelib / "adobe" / "__init__.py"
        origin.write_text("", encoding="utf-8")
        fake = type(sys)("adobe")
        fake.__file__ = str(origin)
        path_entries = [str(purelib), str(tmp), *(str(p) for p in extra_path)]
        with mock.patch.dict(sys.modules, {"adobe": fake}), mock.patch.object(
            sys, "prefix", str(tmp / ".venv")
        ), mock.patch.object(sys, "path", path_entries), mock.patch.dict(
            os.environ, {"PYTHONPATH": pythonpath}
        ), mock.patch.object(
            site, "ENABLE_USER_SITE", False, create=True
        ), mock.patch.object(
            sysconfig, "get_paths", return_value={"purelib": str(purelib)}
        ):
            yield origin

    def test_unsafe_cycle_counterexample_leaves_layer_hidden(self) -> None:
        layer = _FakeLayer(True)
        app = _FakeApp(layer, fail_on_call=2)
        with self.assertRaises(RuntimeError):
            _unsafe_visibility_cycle(app, layer)
        self.assertFalse(layer.visible, "the old path leaves the user's layer hidden")

    def test_safe_cycle_restores_visibility_in_finally(self) -> None:
        layer = _FakeLayer(True)
        layer.id = 101
        app = _FakeApp(layer, fail_on_call=2)
        owned = self._owned(app, layer)
        with self.assertRaises(RuntimeError):
            live.safe_visibility_cycle(app, layer, owned)
        self.assertTrue(layer.visible, "finally must restore the original visibility")

    def test_safe_cycle_refuses_unknown_visibility(self) -> None:
        layer = _FakeLayer(None)
        layer.id = 101
        app = _FakeApp(layer)
        owned = self._owned(app, layer)
        with self.assertRaises(RuntimeError):
            live.safe_visibility_cycle(app, layer, owned)
        self.assertEqual(app.calls, 0)

    def test_forged_isolated_document_id_never_touches_active_layer(self) -> None:
        """A different or forged id must not mutate the user's active layer."""

        layer = _FakeLayer(True)
        layer.id = 101
        app = _FakeApp(layer)
        with mock.patch.dict(
            os.environ, {"ADOBEPY_LIVE_PHOTOSHOP": "1"}
        ), mock.patch.object(live, "load_sdk", return_value=lambda **kwargs: app):
            for forged in ("999", "42", "7"):
                app.calls = 0
                app.targets.clear()
                app.user_layer.visible = True
                code = live.main(["--mutate", "--isolated-document-id", forged])
                self.assertEqual(code, 2)
                self.assertEqual(app.calls, 0, "a forged id must not reach batch_play")
                self.assertEqual(app.targets, [])
                self.assertTrue(app.user_layer.visible)

    def test_run_isolated_mutation_resolves_only_owned_layers(self) -> None:
        """The safe isolated entry point never uses app.active_layers."""

        owned_layer = _FakeLayer(True)
        owned_layer.id = 101
        app = _FakeApp(owned_layer, active_id=42)
        owned = self._owned(app, owned_layer)
        live.run_isolated_mutation(app, owned, declared_id="42")
        self.assertTrue(app.targets)
        self.assertTrue(all(target == 101 for _, target in app.targets))
        self.assertEqual({obj for obj, _ in app.targets}, {"hide", "show"})
        self.assertTrue(app.user_layer.visible, "the user's active layer is untouched")

    def test_mismatched_declared_id_does_not_mutate(self) -> None:
        owned_layer = _FakeLayer(True)
        owned_layer.id = 101
        app = _FakeApp(owned_layer, active_id=42)
        owned = self._owned(app, owned_layer)
        with self.assertRaises(RuntimeError):
            live.run_isolated_mutation(app, owned, declared_id="999")
        self.assertEqual(app.calls, 0)
        self.assertTrue(app.user_layer.visible)

    def test_active_document_switch_aborts_before_the_next_mutation(self) -> None:
        """If ownership is no longer provable, fail closed without a blind restore."""

        owned_layer = _FakeLayer(True)
        owned_layer.id = 101
        app = _FakeApp(owned_layer, active_id=42)
        owned = self._owned(app, owned_layer)
        original_batch_play = app.batch_play

        def switch_after_first(descriptors, modal: bool = False) -> None:
            original_batch_play(descriptors, modal=modal)
            if len(app.targets) == 1:
                app.active_document = _FakeDocument(999, [])

        app.batch_play = switch_after_first
        with self.assertRaises(RuntimeError):
            live.run_isolated_mutation(app, owned)
        self.assertEqual(len(app.targets), 1, "no second mutation after the switch")
        self.assertTrue(app.user_layer.visible)

    def test_source_checkout_is_not_injected_by_default(self) -> None:
        path = str(live.PYTHON_ROOT)
        original = list(sys.path)
        try:
            while path in sys.path:
                sys.path.remove(path)
            live.configure_import_path(source_python=False)
            self.assertNotIn(path, sys.path)
            live.configure_import_path(source_python=True)
            self.assertIn(path, sys.path)
        finally:
            sys.path[:] = original

    def test_require_wheel_rejects_a_checkout_import(self) -> None:
        fake = type(sys)("adobe")
        fake.__file__ = str(ROOT / "python" / "adobe" / "__init__.py")
        with mock.patch.dict(sys.modules, {"adobe": fake}):
            with self.assertRaises(SystemExit) as ctx:
                live.assert_wheel_only()
        self.assertIn("source checkout", str(ctx.exception))

    def test_require_wheel_accepts_a_clean_venv_install(self) -> None:
        with tempfile.TemporaryDirectory(prefix="adobepy-wheel-proof-") as tmp_dir:
            with self._wheel_env(pathlib.Path(tmp_dir)) as origin:
                self.assertEqual(live.assert_wheel_only(), origin.resolve())

    def test_require_wheel_rejects_another_source_checkout_on_sys_path(self) -> None:
        with tempfile.TemporaryDirectory(prefix="adobepy-wheel-inject-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            other = tmp / "other-checkout" / "python"
            (other / "adobe").mkdir(parents=True)
            (other / "adobe" / "__init__.py").write_text("", encoding="utf-8")
            with self._wheel_env(tmp, extra_path=(other,)):
                with self.assertRaises(SystemExit) as ctx:
                    live.assert_wheel_only()
            self.assertIn("source checkout is on sys.path", str(ctx.exception))

    def test_require_wheel_rejects_pythonpath_injection(self) -> None:
        with tempfile.TemporaryDirectory(prefix="adobepy-wheel-path-") as tmp_dir:
            tmp = pathlib.Path(tmp_dir)
            with self._wheel_env(tmp, pythonpath=str(tmp)):
                with self.assertRaises(SystemExit) as ctx:
                    live.assert_wheel_only()
            self.assertIn("PYTHONPATH is set", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
