"""Validate that Python wheels keep the project-wide compatibility contract."""

from __future__ import annotations

import argparse
import pathlib
import sys
import zipfile
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence


PURE_PYTHON_TAG = ("py3", "none", "any")
ABI3_PY38_TAG = ("cp38", "abi3")
REQUIRED_PACKAGE_FILES = frozenset(
    {
        "adobe/after_effects/py.typed",
        "adobe/after_effects/_facade_contract.py",
        "adobe/after_effects/session.pyi",
        "adobe/core/py.typed",
        "adobe/dcc_mcp/py.typed",
        "adobe/illustrator/py.typed",
        "adobe/illustrator/_facade_contract.py",
        "adobe/illustrator/session.pyi",
        "adobe/indesign/py.typed",
        "adobe/indesign/_facade_contract.py",
        "adobe/indesign/session.pyi",
        "adobe/photoshop/py.typed",
        "adobe/photoshop/_facade_contract.py",
        "adobe/photoshop/session.pyi",
        "adobe/premiere/py.typed",
        "adobe/premiere/_facade_contract.py",
        "adobe/premiere/session.pyi",
        "adobe/raw/py.typed",
    }
)


class WheelCompatibilityError(ValueError):
    """Raised when a wheel filename does not match the supported tags."""


@dataclass(frozen=True)
class WheelTags:
    python: str
    abi: str
    platform: str


def parse_wheel_tags(filename: str) -> WheelTags:
    if not filename.endswith(".whl"):
        raise WheelCompatibilityError(f"{filename!r} is not a wheel")
    stem = filename[:-4]
    parts = stem.rsplit("-", 3)
    if len(parts) != 4:
        raise WheelCompatibilityError(f"{filename!r} is not a valid wheel filename")
    return WheelTags(python=parts[1], abi=parts[2], platform=parts[3])


def assert_compatible_wheel_name(filename: str) -> None:
    tags = parse_wheel_tags(filename)
    if (tags.python, tags.abi, tags.platform) == PURE_PYTHON_TAG:
        return
    python_tags = set(tags.python.split("."))
    abi_tags = set(tags.abi.split("."))
    if ABI3_PY38_TAG[0] in python_tags and ABI3_PY38_TAG[1] in abi_tags:
        return
    raise WheelCompatibilityError(
        f"{filename!r} must be a pure py3-none-any wheel or a native cp38-abi3 wheel"
    )


def assert_required_package_files(wheel: pathlib.Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    missing = sorted(REQUIRED_PACKAGE_FILES - names)
    if missing:
        raise WheelCompatibilityError(f"{wheel.name!r} is missing package typing files: {missing}")


def iter_wheels(paths: Sequence[pathlib.Path]) -> Iterable[pathlib.Path]:
    for path in paths:
        if path.is_dir():
            yield from sorted(path.glob("*.whl"))
        elif path.suffix == ".whl":
            yield path


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check adobepy wheel tags. Native extensions must use abi3-py38."
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
            assert_compatible_wheel_name(wheel.name)
            assert_required_package_files(wheel)
        except WheelCompatibilityError as exc:
            failures.append(str(exc))

    if failures:
        for failure in failures:
            print(failure, file=sys.stderr)
        return 1

    for wheel in wheels:
        print(f"compatible wheel: {wheel.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
