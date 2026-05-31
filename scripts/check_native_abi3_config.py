"""Check the native-extension packaging contract for future Python modules."""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
from typing import Iterable, Optional, Sequence

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.check_wheel_compat import (
    ABI3_PY38_TAG,
    PURE_PYTHON_TAG,
    WheelCompatibilityError,
    assert_compatible_wheel_name,
)


ABI3_FEATURE = "abi3-py38"
ABI3_FEATURE_RE = re.compile(r"\babi3-py\d+\b")
SKIP_DIRS = {".git", ".venv", "dist", "node_modules", "target"}


class NativeAbi3ConfigError(ValueError):
    """Raised when the native-extension canary is no longer abi3-py38-safe."""


def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError as exc:
        raise NativeAbi3ConfigError(f"missing required abi3 config file: {path}") from exc


def iter_cargo_tomls(root: pathlib.Path) -> Iterable[pathlib.Path]:
    for path in root.rglob("Cargo.toml"):
        if SKIP_DIRS.intersection(path.relative_to(root).parts):
            continue
        yield path


def assert_root_package_stays_pure_python(root: pathlib.Path) -> None:
    pyproject = read_text(root / "pyproject.toml")
    if 'build-backend = "setuptools.build_meta"' not in pyproject:
        raise NativeAbi3ConfigError(
            "the root Python package should stay on setuptools while the wheel is pure Python"
        )
    if "maturin" in pyproject or "setuptools-rust" in pyproject:
        raise NativeAbi3ConfigError(
            "the root Python package should not enable a native backend until a real extension ships"
        )


def abi3_features(text: str) -> set[str]:
    return set(ABI3_FEATURE_RE.findall(text))


def assert_pyo3_cargo_toml(path: pathlib.Path) -> None:
    text = read_text(path)
    if "pyo3" not in text:
        return
    features = abi3_features(text)
    if ABI3_FEATURE not in features:
        raise NativeAbi3ConfigError(f"{path} uses pyo3 but does not enable {ABI3_FEATURE}")
    extra = sorted(features - {ABI3_FEATURE})
    if extra:
        raise NativeAbi3ConfigError(
            f"{path} must keep the native extension floor at {ABI3_FEATURE}; found {extra}"
        )
    if "crate-type" not in text or "cdylib" not in text:
        raise NativeAbi3ConfigError(f"{path} uses pyo3 but does not declare a cdylib extension")


def assert_native_template(root: pathlib.Path) -> None:
    template = root / "packaging" / "native-extension-template"
    cargo_toml = template / "Cargo.toml"
    pyproject = template / "pyproject.toml"
    root_cargo = read_text(root / "Cargo.toml")
    if 'exclude = ["packaging/native-extension-template"]' not in root_cargo:
        raise NativeAbi3ConfigError("the native-extension template must stay outside the workspace")
    assert_pyo3_cargo_toml(cargo_toml)
    pyproject_text = read_text(pyproject)
    expected = {
        'build-backend = "maturin"',
        'requires-python = ">=3.8"',
        'bindings = "pyo3"',
        'module-name = "adobe._native"',
    }
    missing = sorted(item for item in expected if item not in pyproject_text)
    if missing:
        raise NativeAbi3ConfigError(f"{pyproject} is missing native wheel settings: {missing}")


def assert_wheel_tag_canary() -> None:
    if PURE_PYTHON_TAG != ("py3", "none", "any"):
        raise NativeAbi3ConfigError("pure Python wheel tag canary changed unexpectedly")
    if ABI3_PY38_TAG != ("cp38", "abi3"):
        raise NativeAbi3ConfigError("native wheel tag canary must stay cp38-abi3")
    assert_compatible_wheel_name("adobepy-0.1.0-py3-none-any.whl")
    assert_compatible_wheel_name("adobepy-0.1.0-cp38-abi3-win_amd64.whl")
    for filename in (
        "adobepy-0.1.0-cp38-cp38-win_amd64.whl",
        "adobepy-0.1.0-cp39-abi3-win_amd64.whl",
        "adobepy-0.1.0-cp312-cp312-win_amd64.whl",
    ):
        try:
            assert_compatible_wheel_name(filename)
        except WheelCompatibilityError:
            continue
        raise NativeAbi3ConfigError(f"wheel tag canary should reject {filename!r}")


def assert_native_abi3_contract(root: pathlib.Path) -> None:
    root = root.resolve()
    assert_root_package_stays_pure_python(root)
    assert_native_template(root)
    for cargo_toml in iter_cargo_tomls(root):
        assert_pyo3_cargo_toml(cargo_toml)
    assert_wheel_tag_canary()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Check that future native Python extensions are configured for abi3-py38."
    )
    parser.add_argument(
        "--root",
        type=pathlib.Path,
        default=REPO_ROOT,
        help="Repository root to check",
    )
    args = parser.parse_args(argv)
    try:
        assert_native_abi3_contract(args.root)
    except NativeAbi3ConfigError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print("native abi3 contract ok: pure wheel now, future pyo3 extensions must use abi3-py38")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
