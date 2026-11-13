"""Assert that built wheels carry the bundled bridge templates.

``python -m adobe install-bridge`` resolves ``adobe/_bridges`` first. If a wheel
was built without staging that tree, a wheel-only install can only report that
bridge templates are missing. This check fails the build in that case instead of
shipping a wheel that cannot install a bridge.
"""

from __future__ import annotations

import argparse
import pathlib
import sys
import zipfile
from typing import Iterable, List, Optional, Sequence

BRIDGE_PREFIX = "adobe/_bridges/"

# Mirrors the artifacts `python -m adobe install-bridge` requires per host.
REQUIRED_BRIDGE_FILES = (
    "adobe/_bridges/uxp/photoshop/manifest.json",
    "adobe/_bridges/uxp/photoshop/index.html",
    "adobe/_bridges/uxp/photoshop/dist/main.js",
    "adobe/_bridges/uxp/indesign/manifest.json",
    "adobe/_bridges/uxp/indesign/index.html",
    "adobe/_bridges/uxp/indesign/dist/main.js",
    "adobe/_bridges/uxp/premiere/manifest.json",
    "adobe/_bridges/uxp/premiere/index.html",
    "adobe/_bridges/uxp/premiere/dist/main.js",
    # A CEP panel is only loadable with its CSXS manifest; the UXP hosts above
    # declare themselves with manifest.json instead.
    "adobe/_bridges/cep/after-effects/CSXS/manifest.xml",
    "adobe/_bridges/cep/after-effects/index.html",
    "adobe/_bridges/cep/after-effects/dist/main.js",
    "adobe/_bridges/cep/after-effects/dist/dom.jsx",
    "adobe/_bridges/cep/illustrator/CSXS/manifest.xml",
    "adobe/_bridges/cep/illustrator/index.html",
    "adobe/_bridges/cep/illustrator/dist/main.js",
    "adobe/_bridges/cep/illustrator/dist/dom.jsx",
)


class WheelBridgeError(RuntimeError):
    """Raised when a wheel does not carry the bundled bridge templates."""


def assert_bundled_bridges(wheel: pathlib.Path) -> int:
    """Ensure ``wheel`` carries the bridge tree. Returns the entry count."""

    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    missing = sorted(name for name in REQUIRED_BRIDGE_FILES if name not in names)
    if missing:
        raise WheelBridgeError(
            f"{wheel.name!r} does not bundle bridge templates; missing {missing}. "
            "Run `npm run uxp:build`, `npm run cep:build`, and "
            "`python scripts/stage_wheel_bridges.py` before building the wheel."
        )
    return sum(1 for name in names if name.startswith(BRIDGE_PREFIX))


def iter_wheels(paths: Sequence[pathlib.Path]) -> Iterable[pathlib.Path]:
    for path in paths:
        if path.is_dir():
            yield from sorted(path.glob("*.whl"))
        elif path.suffix == ".whl":
            yield path


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check that adobepy wheels bundle the built bridge templates."
    )
    parser.add_argument("paths", nargs="+", type=pathlib.Path, help="Wheel files or directories")
    args = parser.parse_args(argv)

    wheels = list(iter_wheels(args.paths))
    if not wheels:
        print("no wheels found", file=sys.stderr)
        return 1

    failures: List[str] = []
    for wheel in wheels:
        try:
            count = assert_bundled_bridges(wheel)
        except WheelBridgeError as exc:
            failures.append(str(exc))
            continue
        print(f"bundled bridges: {wheel.name} ({count} entries)")

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
