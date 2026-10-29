#!/usr/bin/env python3
"""Offline packaging gate regressions using fixture wheels and a fake CLI.

These tests exercise the real shell installer gate, not a native Rust binary or
an Adobe application. Native release binaries are exercised by package CI jobs.
"""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile


SCRIPTS = Path(__file__).resolve().parent
CHECKS = [
    {"name": "broker_port", "ok": False, "detail": "expected offline"},
    {"name": "python_runtime", "ok": True, "detail": "fixture"},
    {"name": "bootstrap_helper", "ok": True, "detail": "fixture"},
    {"name": "bridge_templates", "ok": True, "detail": "fixture"},
]
SDK = {"adobe/__init__.py": ""}
for module, name in [("photoshop", "Photoshop"), ("indesign", "InDesign"),
                     ("premiere", "Premiere"), ("after_effects", "AfterEffects"),
                     ("illustrator", "Illustrator"), ("raw", "RawSession")]:
    SDK["adobe/" + module + ".py"] = "class " + name + ":\n    pass\n"
SDK["adobe/dcc_mcp.py"] = "def adobe_success(value):\n    return {'success': True}\n"


def run(command, **kwargs):
    return subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          universal_newlines=True, timeout=90, **kwargs)


def wheel_bytes(complete=True):
    """Build a tiny standards-shaped pure Python fixture wheel without network."""
    files = dict(SDK) if complete else {"adobe/__init__.py": ""}
    dist = "adobepy_fixture-0.0.0.dist-info/"
    files[dist + "METADATA"] = "Metadata-Version: 2.1\nName: adobepy-fixture\nVersion: 0.0.0\n"
    files[dist + "WHEEL"] = "Wheel-Version: 1.0\nGenerator: smoke-fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    files[dist + "RECORD"] = "".join(name + ",,\n" for name in files) + dist + "RECORD,,\n"
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, contents in files.items():
            archive.writestr(name, contents)
    return buffer.getvalue()


class ChecksumTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="adobepy-checksum-")
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "package with spaces.zip"
        self.path.write_bytes(b"fixture archive bytes")
        self.sidecar = Path(str(self.path) + ".sha256")
        self.digest = hashlib.sha256(self.path.read_bytes()).hexdigest()
        self.sidecar.write_text(self.digest + "  " + self.path.name + "\n")

    def check(self):
        return run([sys.executable, str(SCRIPTS / "check_package_checksum.py"), str(self.path)])

    def test_correct_digest(self):
        result = self.check()
        self.assertEqual(result.returncode, 0, result.stdout)

    def test_missing_sidecar(self):
        self.sidecar.unlink()
        self.assertNotEqual(self.check().returncode, 0)

    def test_tampered_archive(self):
        self.path.write_bytes(b"tampered archive bytes")
        self.assertNotEqual(self.check().returncode, 0)

    def test_wrong_digest(self):
        self.sidecar.write_text("0" * 64 + "  " + self.path.name + "\n")
        self.assertNotEqual(self.check().returncode, 0)

    def test_malformed_or_wrong_target(self):
        for text in ["", "not-a-hash", self.digest + "  another.zip\n",
                     self.digest + "  " + self.path.name + "\nextra\n"]:
            with self.subTest(text=text):
                self.sidecar.write_text(text)
                self.assertNotEqual(self.check().returncode, 0)


class DoctorTests(unittest.TestCase):
    def check(self, value):
        return run([sys.executable, str(SCRIPTS / "check_package_doctor.py")], input=value)

    def test_only_broker_port_may_fail(self):
        result = self.check(json.dumps(CHECKS))
        self.assertEqual(result.returncode, 0, result.stdout)
        for name in ["python_runtime", "bootstrap_helper", "bridge_templates"]:
            checks = [dict(item, ok=False) if item["name"] == name else dict(item)
                      for item in CHECKS]
            with self.subTest(name=name):
                self.assertNotEqual(self.check(json.dumps(checks)).returncode, 0)

    def test_reject_invalid_incomplete_and_non_boolean_results(self):
        cases = ["", "not json", "{}", "null", "[]", json.dumps(CHECKS[:-1]),
                 json.dumps(CHECKS + [CHECKS[-1]]),
                 json.dumps([dict(item, ok="true") for item in CHECKS]),
                 json.dumps([dict(item, ok=1) for item in CHECKS]),
                 json.dumps(CHECKS + [{"name": "extra", "ok": False}])]
        for value in cases:
            with self.subTest(value=value):
                self.assertNotEqual(self.check(value).returncode, 0)


@unittest.skipUnless(os.name == "posix" and shutil.which("bash") and shutil.which("unzip"),
                     "POSIX bash/unzip smoke gate")
class SmokeFixtureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="adobepy-smoke-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.checkout = self.base / "checkout"
        self.checkout.mkdir()
        # Valid checkout modules must never rescue an incomplete installed wheel.
        for name, contents in SDK.items():
            path = self.checkout / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(contents)
        (self.checkout / "bridges").mkdir()
        self.path = self.base / "package.zip"

    def package(self, omit=(), doctor=None, doctor_exit=0, complete_wheel=True):
        output = json.dumps(CHECKS) if doctor is None else doctor
        cli = """#!/usr/bin/env bash
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
[ "$PWD" = "$root" ] || { echo 'doctor ran outside extracted package'; exit 9; }
[ -x "$root/bin/adobepy-bootstrap-helper" ] || exit 8
[ -d "$root/bridges" ] || exit 7
python=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--python' ]; then python="$2"; shift 2; else shift; fi
done
[ -n "$python" ] || exit 6
"$python" -I -c 'import sys; assert sys.prefix != sys.base_prefix'
printf '%s\\n' 'OUTPUT'
exit CODE
""".replace("OUTPUT", output.replace("'", "'\"'\"'")).replace("CODE", str(doctor_exit))
        # Exercise the actual generated installer, including its venv handling.
        package_source = (SCRIPTS / "package-release.sh").read_text()
        installer = package_source.split(
            'cat > "$STAGE_ROOT/install.sh" << \'SCRIPT\'\n', 1)[1].split("\nSCRIPT\n", 1)[0]
        files = {"install.sh": installer, "bin/adobepy": cli,
                 "bin/adobepy-bootstrap-helper": "#!/usr/bin/env bash\nexit 0\n",
                 "bridges/fixture.txt": "fixture", "python/fixture.txt": "fixture",
                 "wheels/adobepy_fixture-0.0.0-py3-none-any.whl": wheel_bytes(complete_wheel)}
        with zipfile.ZipFile(self.path, "w") as archive:
            for name, contents in files.items():
                if any(name == item or name.startswith(item + "/") for item in omit):
                    continue
                info = zipfile.ZipInfo("adobepy-fixture/" + name)
                info.create_system = 3
                mode = 0o755 if name.startswith("bin/") or name == "install.sh" else 0o644
                info.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(info, contents)
        self.checksum()

    def checksum(self):
        Path(str(self.path) + ".sha256").write_text(
            hashlib.sha256(self.path.read_bytes()).hexdigest() + "  " + self.path.name + "\n")

    def smoke(self):
        environment = dict(os.environ, PYTHONPATH=str(self.checkout), PIP_NO_INDEX="1",
                           PIP_DISABLE_PIP_VERSION_CHECK="1")
        return run(["bash", str(SCRIPTS / "smoke_install.sh"), "--zip", str(self.path),
                    "--python", sys.executable], cwd=str(self.checkout), env=environment)

    def test_complete_fixture_from_checkout(self):
        self.package()
        result = self.smoke()
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn("Install smoke test passed", result.stdout)

    def test_missing_helper_and_bridges_fail(self):
        for omit in [("bin/adobepy-bootstrap-helper",), ("bridges",)]:
            with self.subTest(omit=omit):
                self.package(omit=omit)
                self.assertNotEqual(self.smoke().returncode, 0)

    def test_multiple_package_roots_rejected(self):
        self.package()
        with zipfile.ZipFile(self.path, "a") as archive:
            archive.writestr("another-root/fixture.txt", "fixture")
        self.checksum()
        result = self.smoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Running install.sh", result.stdout)

    def test_checksum_failure_prevents_installer(self):
        self.package()
        Path(str(self.path) + ".sha256").write_text("0" * 64 + "  package.zip\n")
        result = self.smoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("Running install.sh", result.stdout)

    def test_doctor_failure_rejected(self):
        checks = [dict(item, ok=False) if item["name"] == "bootstrap_helper" else item
                  for item in CHECKS]
        self.package(doctor=json.dumps(checks))
        result = self.smoke()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("Install smoke test passed", result.stdout)

    def test_nonzero_doctor_rejected_even_with_valid_json(self):
        self.package(doctor_exit=7)
        self.assertNotEqual(self.smoke().returncode, 0)

    def test_invalid_doctor_json_rejected(self):
        self.package(doctor="not json")
        self.assertNotEqual(self.smoke().returncode, 0)

    def test_incomplete_wheel_not_rescued_by_checkout_or_pythonpath(self):
        self.package(complete_wheel=False)
        result = self.smoke()
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("Install smoke test passed", result.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
