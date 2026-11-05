"""Install built wheels in a temporary environment and import public facades."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import venv
from typing import Iterable, Optional, Sequence

SMOKE_SOURCE = """
from adobe.photoshop import Photoshop
from adobe.core import PhotoshopBootstrapRequest, PhotoshopBootstrapResult
from adobe.indesign import InDesign
from adobe.premiere import Premiere
from adobe.after_effects import AfterEffects
from adobe.illustrator import ExportResultProxy, Illustrator, SwatchProxy, TextFrameProxy
from adobe.photoshop._facade_contract import FACADE_CONTRACT as PHOTOSHOP_FACADE_CONTRACT
from adobe.raw import RawSession
from adobe.dcc_mcp import adobe_success

assert Photoshop.__name__ == "Photoshop"
assert PhotoshopBootstrapRequest.__name__ == "PhotoshopBootstrapRequest"
assert PhotoshopBootstrapResult.__name__ == "PhotoshopBootstrapResult"
assert InDesign.__name__ == "InDesign"
assert Premiere.__name__ == "Premiere"
assert AfterEffects.__name__ == "AfterEffects"
assert Illustrator.__name__ == "Illustrator"
assert TextFrameProxy.__name__ == "TextFrameProxy"
assert SwatchProxy.__name__ == "SwatchProxy"
assert ExportResultProxy.__name__ == "ExportResultProxy"
assert PHOTOSHOP_FACADE_CONTRACT["host"] == "photoshop"
assert RawSession.__name__ == "RawSession"
assert adobe_success("ok")["success"] is True
print("adobepy wheel import smoke passed")
"""


def iter_wheels(paths: Sequence[pathlib.Path]) -> Iterable[pathlib.Path]:
    for path in paths:
        if path.is_dir():
            yield from sorted(path.glob("*.whl"))
        elif path.suffix == ".whl":
            yield path


def venv_python(venv_dir: pathlib.Path) -> pathlib.Path:
    if os.name == "nt":
        return venv_dir / "Scripts" / "python.exe"
    return venv_dir / "bin" / "python"


def run(
    command: Sequence[str], *, cwd: pathlib.Path, env: Optional[dict] = None
) -> None:
    subprocess.run(command, cwd=str(cwd), check=True, env=env)


# The wheel-only path that used to fail outright: no release bundle, no
# ADOBEPY_* overrides, and a cwd outside any source checkout.
BRIDGE_SMOKE_SOURCE = """
import json
import pathlib
import subprocess
import sys

destination = pathlib.Path(sys.argv[1])
result = subprocess.run(
    [
        sys.executable,
        "-m",
        "adobe",
        "install-bridge",
        "photoshop",
        "--dest",
        str(destination),
        "--token",
        "smoke-token",
        "--json",
    ],
    capture_output=True,
    text=True,
)
if result.returncode != 0:
    raise SystemExit(
        "install-bridge failed with exit code "
        f"{result.returncode}\\nstdout: {result.stdout}\\nstderr: {result.stderr}"
    )
payload = json.loads(result.stdout)
assert payload["success"] is True, payload
for artifact in (
    "manifest.json",
    "index.html",
    "adobepy.config.js",
    "src/main.ts",
    "dist/main.js",
):
    if not (destination / artifact).is_file():
        raise SystemExit(f"staged bridge is missing {artifact}")
print("adobepy wheel bridge install smoke passed")
"""


def bridge_smoke_environment() -> dict:
    """Strip every ADOBEPY_* override so only bundled assets can resolve."""

    return {key: value for key, value in os.environ.items() if not key.startswith("ADOBEPY_")}


# Doctor checks that describe the wheel itself; these must pass in a clean,
# wheel-only virtual environment.
WHEEL_REQUIRED_CHECKS = ("sdk", "python_runtime", "bridge_templates")
# Runtime integration checks are not part of the wheel: it ships neither the
# broker executable nor a running broker, so a wheel-only install reports these
# as failed diagnostics. They are validated explicitly below and are never
# silently ignored (any *other* failing check still fails the smoke).
RUNTIME_OPTIONAL_CHECKS = ("broker_executable", "broker_port")


def _parse_doctor_report(doctor: subprocess.CompletedProcess) -> dict:
    """Parse ``doctor --json`` output regardless of its exit status.

    A wheel-only install is *expected* to exit non-zero because the runtime
    integration checks fail. We must still inspect the JSON report to tell that
    expected condition apart from a genuine wheel defect, so the report shape
    and every check are validated instead of trusting the return code.
    """

    try:
        payload = json.loads(doctor.stdout)
    except (json.JSONDecodeError, TypeError) as error:
        raise SystemExit(
            "`adobe doctor --json` did not produce a parseable JSON report: "
            f"{error}; exit={doctor.returncode}; "
            f"stdout={(doctor.stdout or '').strip()!r}; "
            f"stderr={(doctor.stderr or '').strip()!r}"
        )
    if not isinstance(payload, list) or not all(
        isinstance(check, dict) and "name" in check and "ok" in check
        for check in payload
    ):
        raise SystemExit(
            "`adobe doctor --json` returned an unexpected report shape; "
            f"got {type(payload).__name__}"
        )
    return {check["name"]: check for check in payload}


def smoke_bridge_install(python: pathlib.Path, cwd: pathlib.Path) -> None:
    destination = cwd / "staged-bridge"
    run(
        [
            str(python),
            "-c",
            BRIDGE_SMOKE_SOURCE,
            str(destination),
        ],
        cwd=cwd,
        env=bridge_smoke_environment(),
    )
    doctor = subprocess.run(
        [str(python), "-m", "adobe", "doctor", "--json"],
        cwd=str(cwd),
        capture_output=True,
        text=True,
        env=bridge_smoke_environment(),
    )
    # `doctor` returns 0 only when every check passes and 1 when a check
    # fails. A wheel-only install lands on 1 by design; anything else means the
    # command crashed rather than produced a usable report.
    if doctor.returncode not in (0, 1):
        raise SystemExit(
            f"`adobe doctor --json` exited {doctor.returncode}, expected 0 or 1"
        )
    checks = _parse_doctor_report(doctor)

    # The wheel's own contract must be fully healthy.
    for name in WHEEL_REQUIRED_CHECKS:
        check = checks.get(name)
        if check is None:
            raise SystemExit(
                f"`adobe doctor --json` is missing required check {name!r}"
            )
        if not check["ok"]:
            raise SystemExit(
                f"wheel-only install failed required doctor check {name!r}: "
                f"{check.get('detail')}"
            )

    # Templates must resolve from the wheel's bundled tree, never a source
    # checkout that happens to be on sys.path.
    detail = str(checks["bridge_templates"].get("detail", ""))
    if "_bridges" not in detail:
        raise SystemExit(
            "doctor resolved bridge templates from somewhere other than adobe/_bridges: "
            + detail
        )

    # Expected absent-runtime diagnostics must at least be reported. Their `ok`
    # may be True if the runner happens to have a broker installed; we never
    # require (or fake) one, and we never start the user's broker.
    for name in RUNTIME_OPTIONAL_CHECKS:
        if name not in checks:
            raise SystemExit(
                f"`adobe doctor --json` is missing expected runtime check {name!r}"
            )

    # Do not green the smoke by ignoring errors: any failing check outside the
    # explicit allow-list is a real regression and must fail this step.
    allowed = set(WHEEL_REQUIRED_CHECKS) | set(RUNTIME_OPTIONAL_CHECKS)
    unexpected = sorted(
        name
        for name, check in checks.items()
        if not check["ok"] and name not in allowed
    )
    if unexpected:
        raise SystemExit(
            "wheel-only install reported unexpected failing doctor checks: "
            + ", ".join(unexpected)
        )


def smoke_wheel(wheel: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory(prefix="adobepy-wheel-smoke-") as tmp:
        tmp_path = pathlib.Path(tmp)
        venv_dir = tmp_path / ".venv"
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        python = venv_python(venv_dir)
        run(
            [str(python), "-m", "pip", "install", "--no-deps", str(wheel)], cwd=tmp_path
        )
        run([str(python), "-c", SMOKE_SOURCE], cwd=tmp_path)
        smoke_bridge_install(python, tmp_path)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Smoke-test built adobepy wheels in a temporary venv"
    )
    parser.add_argument(
        "paths", nargs="+", type=pathlib.Path, help="Wheel files or directories"
    )
    args = parser.parse_args(argv)

    wheels = list(iter_wheels(args.paths))
    if not wheels:
        print("no wheels found", file=sys.stderr)
        return 1

    for wheel in wheels:
        smoke_wheel(wheel.resolve())
        print(f"smoked wheel: {wheel.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
