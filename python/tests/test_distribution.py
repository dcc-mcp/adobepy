import pathlib
import tempfile
import unittest
import zipfile

from scripts.check_wheel_compat import (
    REQUIRED_PACKAGE_FILES,
    WheelCompatibilityError,
    assert_required_package_files,
    assert_compatible_wheel_name,
    parse_wheel_tags,
)
from scripts.check_native_abi3_config import (
    NativeAbi3ConfigError,
    assert_native_abi3_contract,
    assert_pyo3_cargo_toml,
)


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


class DistributionTests(unittest.TestCase):
    def test_wheel_tags_accept_pure_python_and_abi3_py38(self):
        assert_compatible_wheel_name("adobepy-0.1.0-py3-none-any.whl")
        assert_compatible_wheel_name("adobepy-0.1.0-cp38-abi3-win_amd64.whl")
        tags = parse_wheel_tags("adobepy-0.1.0-cp38-abi3-manylinux_2_28_x86_64.whl")
        self.assertEqual(tags.python, "cp38")
        self.assertEqual(tags.abi, "abi3")

    def test_wheel_tags_reject_per_minor_native_builds(self):
        with self.assertRaises(WheelCompatibilityError):
            assert_compatible_wheel_name("adobepy-0.1.0-cp38-cp38-win_amd64.whl")
        with self.assertRaises(WheelCompatibilityError):
            assert_compatible_wheel_name("adobepy-0.1.0-cp312-cp312-win_amd64.whl")
        with self.assertRaises(WheelCompatibilityError):
            assert_compatible_wheel_name("adobepy-0.1.0-cp39-abi3-win_amd64.whl")

    def test_wheel_contains_typing_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            wheel = pathlib.Path(tmp) / "adobepy-0.1.0-py3-none-any.whl"
            with zipfile.ZipFile(wheel, "w") as archive:
                for name in REQUIRED_PACKAGE_FILES:
                    archive.writestr(name, "")
            assert_required_package_files(wheel)

            incomplete = pathlib.Path(tmp) / "adobepy-0.1.0-cp38-abi3-win_amd64.whl"
            with zipfile.ZipFile(incomplete, "w") as archive:
                archive.writestr("adobe/photoshop/session.pyi", "")
            with self.assertRaises(WheelCompatibilityError):
                assert_required_package_files(incomplete)

    def test_native_abi3_contract(self):
        assert_native_abi3_contract(REPO_ROOT)

    def test_native_abi3_contract_rejects_wrong_pyo3_floor(self):
        with tempfile.TemporaryDirectory() as tmp:
            cargo_toml = pathlib.Path(tmp) / "Cargo.toml"
            cargo_toml.write_text(
                """
[lib]
crate-type = ["cdylib"]

[dependencies]
pyo3 = { version = "0.28", features = ["abi3-py312"] }
""".lstrip(),
                encoding="utf-8",
            )
            with self.assertRaises(NativeAbi3ConfigError):
                assert_pyo3_cargo_toml(cargo_toml)


if __name__ == "__main__":
    unittest.main()
