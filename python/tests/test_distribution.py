import json
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

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
    def test_release_version_projection_is_consistent(self):
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        package_lock = json.loads((REPO_ROOT / "package-lock.json").read_text(encoding="utf-8"))
        release_manifest = json.loads(
            (REPO_ROOT / ".github" / "release-please-manifest.json").read_text(encoding="utf-8")
        )
        pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        project_table = re.search(r"(?ms)^\[project\]\s*$\n(.*?)(?=^\[|\Z)", pyproject)
        self.assertIsNotNone(project_table)
        pyproject_version = re.search(
            r'(?m)^version\s*=\s*"([^"]+)"\s*$', project_table.group(1)
        )
        self.assertIsNotNone(pyproject_version)

        expected = package["version"]
        self.assertEqual(pyproject_version.group(1), expected)
        self.assertEqual(release_manifest["."], expected)
        self.assertEqual(package_lock["version"], expected)
        self.assertEqual(package_lock["packages"][""]["version"], expected)

    def test_release_please_projects_package_lock_versions(self):
        config = json.loads(
            (REPO_ROOT / ".github" / "release-please-config.json").read_text(encoding="utf-8")
        )
        extra_files = config["packages"]["."]["extra-files"]
        self.assertIn(
            {"type": "json", "path": "package-lock.json", "jsonpath": "$.version"},
            extra_files,
        )
        self.assertIn(
            {
                "type": "json",
                "path": "package-lock.json",
                "jsonpath": '$.packages[""].version',
            },
            extra_files,
        )

    def test_release_packager_validates_source_and_staged_versions(self):
        package_script = (REPO_ROOT / "scripts" / "package-release.ps1").read_text(
            encoding="utf-8-sig"
        )
        self.assertGreaterEqual(package_script.count("check-release-versions.js"), 2)
        self.assertIn('"package-lock.json"', package_script)
        self.assertIn('"package-manifest.json"', package_script)
        self.assertIn("Write-Utf8NoBom", package_script)
        self.assertIn("[System.Text.UTF8Encoding]::new($false)", package_script)
        self.assertLess(
            package_script.index("function Write-Utf8NoBom"),
            package_script.index("function Write-Installer"),
        )
        ci_workflow = (REPO_ROOT / ".github" / "workflows" / "ci.yml").read_text(
            encoding="utf-8"
        )
        self.assertIn("Expand-Archive", ci_workflow)
        self.assertIn("node scripts/check-release-versions.js --root", ci_workflow)

    def test_native_bootstrap_helper_is_built_packaged_and_smoke_checked(self):
        package_script = (REPO_ROOT / "scripts" / "package-release.ps1").read_text(
            encoding="utf-8-sig"
        )
        smoke_script = (REPO_ROOT / "scripts" / "smoke_install.ps1").read_text(
            encoding="utf-8-sig"
        )
        manifest_contract = (REPO_ROOT / "docs" / "distribution-contract.md").read_text(
            encoding="utf-8"
        )
        self.assertIn('"adobepy-bootstrap-helper"', package_script)
        self.assertGreaterEqual(package_script.count("adobepy-bootstrap-helper.exe"), 4)
        self.assertIn("adobepy-bootstrap-helper.exe", smoke_script)
        self.assertIn("--version", smoke_script)
        self.assertIn('$binDirectory = Join-Path $extractedRoot.FullName "bin"', smoke_script)
        self.assertNotIn('Join-Path $extractedRoot.FullName "bin" "', smoke_script)
        self.assertIn("adobepy-bootstrap-helper.exe", manifest_contract)
        self.assertIn("pure Python", manifest_contract)

    def test_release_version_checker_rejects_staged_drift(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is required to execute the release version contract")
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / "package.json").write_text(
                json.dumps({"name": "adobepy", "version": "0.7.0"}), encoding="utf-8"
            )
            (root / "package-lock.json").write_text(
                json.dumps(
                    {
                        "name": "adobepy",
                        "version": "0.7.0",
                        "packages": {"": {"name": "adobepy", "version": "0.6.2"}},
                    }
                ),
                encoding="utf-8",
            )
            (root / "pyproject.toml").write_text(
                '[project]\nname = "adobepy"\nversion = "0.7.0"\n', encoding="utf-8"
            )
            (root / "package-manifest.json").write_text(
                json.dumps({"name": "adobepy", "version": "0.7.0"}), encoding="utf-8"
            )
            result = subprocess.run(
                [
                    node,
                    str(REPO_ROOT / "scripts" / "check-release-versions.js"),
                    "--root",
                    str(root),
                    "--expected",
                    "0.7.0",
                ],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('package-lock.json packages[""].version', result.stderr)

    def test_installed_bridge_config_precedes_bundle(self):
        for kind, host in (
            ("cep", "after-effects"),
            ("cep", "illustrator"),
            ("uxp", "indesign"),
            ("uxp", "photoshop"),
            ("uxp", "premiere"),
        ):
            html = (REPO_ROOT / "bridges" / kind / host / "index.html").read_text(encoding="utf-8")
            self.assertLess(html.index("adobepy.config.js"), html.index("dist/main.js"))

    def test_cep_manifests_are_loadable(self):
        for host, adobe_host in (("after-effects", "AEFT"), ("illustrator", "ILST")):
            root = ET.parse(REPO_ROOT / "bridges" / "cep" / host / "CSXS" / "manifest.xml").getroot()
            extension_id = root.find("./ExtensionList/Extension").attrib["Id"]
            self.assertEqual(root.find("./ExecutionEnvironment/HostList/Host").attrib["Name"], adobe_host)
            self.assertEqual(root.findtext("./DispatchInfoList/Extension/DispatchInfo/Resources/MainPath"), "./index.html")
            self.assertEqual(root.findtext("./DispatchInfoList/Extension/DispatchInfo/Resources/ScriptPath"), "./host/dispatcher.jsx")
            self.assertEqual(root.find("./DispatchInfoList/Extension").attrib["Id"], extension_id)

    def test_cep_extendscript_receives_explicit_arguments(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node.js is required to execute the CEP dispatcher contract")
        script = r"""
const fs = require("fs");
const vm = require("vm");
vm.runInThisContext(fs.readFileSync(process.argv[1], "utf8"));
const response = JSON.parse(adobepyDispatch(JSON.stringify({
  jsonrpc: "2.0",
  id: "arguments-contract",
  namespace: "raw",
  method: "evalExtendScript",
  args: ["arguments[0] + arguments[1]", 2, 3]
})));
if (response.result !== 5) {
  throw new Error(`expected explicit arguments to produce 5, got ${JSON.stringify(response.result)}`);
}
"""
        for host in ("after-effects", "illustrator"):
            dispatcher = REPO_ROOT / "bridges" / "cep" / host / "host" / "dispatcher.jsx"
            subprocess.run(
                [node, "-e", script, str(dispatcher)],
                check=True,
                capture_output=True,
                text=True,
            )

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
