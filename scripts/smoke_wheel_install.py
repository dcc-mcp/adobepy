"""Install built wheels in a temporary environment and import public facades."""

from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys
import tempfile
import venv
from typing import Iterable, Sequence


SMOKE_SOURCE = """
from adobe.photoshop import Photoshop
from adobe.indesign import InDesign
from adobe.premiere import Premiere
from adobe.after_effects import AfterEffects
from adobe.illustrator import ExportResultProxy, Illustrator, SwatchProxy, TextFrameProxy
from adobe.photoshop._facade_contract import FACADE_CONTRACT as PHOTOSHOP_FACADE_CONTRACT
from adobe.raw import RawSession
from adobe.dcc_mcp import adobe_success

assert Photoshop.__name__ == "Photoshop"
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


def run(command: Sequence[str], *, cwd: pathlib.Path) -> None:
    subprocess.run(command, cwd=str(cwd), check=True)


def smoke_wheel(wheel: pathlib.Path) -> None:
    with tempfile.TemporaryDirectory(prefix="adobepy-wheel-smoke-") as tmp:
        tmp_path = pathlib.Path(tmp)
        venv_dir = tmp_path / ".venv"
        venv.EnvBuilder(with_pip=True).create(venv_dir)
        python = venv_python(venv_dir)
        run([str(python), "-m", "pip", "install", "--no-deps", str(wheel)], cwd=tmp_path)
        run([str(python), "-c", SMOKE_SOURCE], cwd=tmp_path)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Smoke-test built adobepy wheels in a temporary venv")
    parser.add_argument("paths", nargs="+", type=pathlib.Path, help="Wheel files or directories")
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
