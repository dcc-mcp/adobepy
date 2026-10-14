import io
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stdout
from unittest import mock

from adobe import cli
from adobe.runtime import ensure_broker


REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]


def _make_bridge_tree(root: pathlib.Path, kind: str, host: str) -> pathlib.Path:
    source = root / kind / host
    (source / "dist").mkdir(parents=True)
    (source / "dist" / "main.js").write_text("// bridge\n", encoding="utf-8")
    (source / "index.html").write_text("<html></html>\n", encoding="utf-8")
    if kind == "cep":
        (source / "dist" / "dom.jsx").write_text("// dom\n", encoding="utf-8")
    (source / "manifest.json").write_text("{}\n", encoding="utf-8")
    return source


class WebsocketUrlTests(unittest.TestCase):
    def test_default_and_scheme_conversion(self):
        self.assertEqual(
            cli.websocket_url("photoshop", None),
            "ws://127.0.0.1:47391/v1/bridge/photoshop/ws",
        )
        self.assertEqual(
            cli.websocket_url("photoshop", "http://127.0.0.1:5000"),
            "ws://127.0.0.1:5000/v1/bridge/photoshop/ws",
        )
        self.assertEqual(
            cli.websocket_url("photoshop", "https://broker.example.com"),
            "wss://broker.example.com/v1/bridge/photoshop/ws",
        )

    def test_explicit_bridge_url_is_preserved(self):
        url = "ws://127.0.0.1:5000/v1/bridge/photoshop/ws"
        self.assertEqual(cli.websocket_url("photoshop", url), url)

    def test_trailing_slash_is_normalized(self):
        self.assertEqual(
            cli.websocket_url("premiere", "http://127.0.0.1:5000/"),
            "ws://127.0.0.1:5000/v1/bridge/premiere/ws",
        )


class BridgeConfigTests(unittest.TestCase):
    def test_config_matches_the_rust_cli_contract(self):
        # Key names are unquoted exactly as the Rust CLI emits them; the bridge
        # reads this file, so the two implementations must stay byte-compatible.
        config = cli.bridge_config_js("photoshop", "http://127.0.0.1:47391", "tok", "default")
        self.assertIn('brokerUrl:"ws://127.0.0.1:47391/v1/bridge/photoshop/ws"', config)
        self.assertIn('token:"tok"', config)
        self.assertIn('target:"default"', config)
        self.assertIn("globalThis.__ADOBEPY_TOKEN", config)
        self.assertTrue(config.endswith("}());\n"))

    def test_non_ascii_token_and_target_stay_raw_utf8(self):
        # serde_json writes raw UTF-8; json.dumps escapes non-ASCII by default.
        # Installers hash this file, so the bytes must match the Rust CLI.
        config = cli.bridge_config_js("photoshop", None, "tokén-中文", "目标")
        self.assertIn('token:"tokén-中文"', config)
        self.assertIn('target:"目标"', config)
        self.assertNotIn("\\u", config)

    def test_config_is_written_with_lf_newlines(self):
        # Installers compare bridge files by hash and the Rust CLI writes LF on
        # every platform, so the Python path must not emit CRLF on Windows.
        config = cli.bridge_config_js("photoshop", None, "tok", "default")
        self.assertTrue(config.endswith("}());\n"))
        self.assertNotIn("\r", config)

    def test_default_bridge_kinds(self):
        self.assertEqual(cli.default_bridge_kind("photoshop"), "uxp")
        self.assertEqual(cli.default_bridge_kind("indesign"), "uxp")
        self.assertEqual(cli.default_bridge_kind("premiere"), "uxp")
        self.assertEqual(cli.default_bridge_kind("after-effects"), "cep")
        self.assertEqual(cli.default_bridge_kind("illustrator"), "cep")
        with self.assertRaises(cli.CliError):
            cli.default_bridge_kind("unknown-host")


class StageBridgeTests(unittest.TestCase):
    def test_stage_bridge_copies_template_and_writes_config(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            destination = root / "staged" / "bridge"
            payload = cli.stage_bridge(
                "photoshop",
                destination,
                "secret-token",
                broker_url="http://127.0.0.1:5000",
                bridge_root=root,
            )
            self.assertTrue(payload["success"])
            self.assertEqual(payload["kind"], "uxp")
            self.assertTrue((destination / "dist" / "main.js").is_file())
            self.assertTrue((destination / "index.html").is_file())
            config = (destination / "adobepy.config.js").read_text(encoding="utf-8")
            self.assertIn("ws://127.0.0.1:5000/v1/bridge/photoshop/ws", config)
            self.assertIn('token:"secret-token"', config)
            self.assertEqual(payload["config"], str(destination / "adobepy.config.js"))

    def test_reported_destination_is_the_path_the_caller_passed(self):
        # Windows canonicalization rewrites a path into its 8.3 short form
        # (for example RUNNER~1). Installers match the reported destination
        # against the directory they created, so it must be echoed verbatim,
        # the same way the Rust CLI reports it.
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            destination = root / "staged"
            with mock.patch.object(
                cli,
                "_canonical_destination_root",
                return_value=pathlib.Path("C:/Users/RUNNER~1/staged"),
            ):
                payload = cli.stage_bridge("photoshop", destination, "token", bridge_root=root)
            self.assertEqual(payload["destination"], str(destination))
            self.assertEqual(payload["config"], str(destination / "adobepy.config.js"))

    def test_cep_requires_the_dom_artifact(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = root / "cep" / "illustrator"
            (source / "dist").mkdir(parents=True)
            (source / "dist" / "main.js").write_text("// bridge\n", encoding="utf-8")
            with self.assertRaises(cli.CliError) as raised:
                cli.stage_bridge("illustrator", root / "staged", "token", bridge_root=root)
            self.assertIn("npm run cep:build", str(raised.exception))

    def test_explicit_bridges_dir_is_named_in_the_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            custom = pathlib.Path(tmp) / "custom"
            custom.mkdir()
            with self.assertRaises(cli.CliError) as raised:
                cli.stage_bridge("photoshop", pathlib.Path(tmp) / "staged", "token", bridge_root=custom)
            self.assertIn(str(custom), str(raised.exception))
            self.assertIn("--bridges-dir", str(raised.exception))

    def test_missing_bridge_root_reports_probed_locations(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                cli, "_bundled_bridge_root", return_value=None
            ), mock.patch.object(cli, "_find_repo_root", return_value=None), mock.patch.object(
                cli, "resolve_broker_executable", return_value=(None, [])
            ):
                with self.assertRaises(cli.CliError) as raised:
                    cli.stage_bridge("photoshop", pathlib.Path(tmp) / "staged", "token")
            message = str(raised.exception)
            self.assertIn("bridge templates not found", message)
            self.assertIn("ADOBEPY_BRIDGES_DIR", message)
            self.assertIn("https://github.com/dcc-mcp/adobepy/releases/latest", message)

    def test_destination_inside_source_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            source = _make_bridge_tree(root, "uxp", "photoshop")
            with self.assertRaises(cli.CliError):
                cli.stage_bridge("photoshop", source / "nested", "token", bridge_root=root)

    def test_empty_token_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            with self.assertRaises(cli.CliError):
                cli.stage_bridge("photoshop", pathlib.Path(tmp) / "staged", "   ", bridge_root=root)

    def test_host_must_be_a_known_bridge_host(self):
        # Without this check a host such as `../../..` would escape the bridge
        # root; the Rust CLI parses the host into a fixed enum instead.
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            for host in ("../../..", "bogus-host", ""):
                with self.assertRaises(cli.CliError) as raised:
                    cli.stage_bridge(host, root / "staged", "token", bridge_root=root)
                self.assertIn("unsupported bridge host", str(raised.exception))

    def test_unknown_kind_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            with self.assertRaises(cli.CliError):
                cli.stage_bridge(
                    "photoshop", pathlib.Path(tmp) / "staged", "token", kind="nope", bridge_root=root
                )

    def test_missing_host_template_is_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            with self.assertRaises(cli.CliError) as raised:
                cli.stage_bridge("premiere", pathlib.Path(tmp) / "staged", "token", bridge_root=root)
            self.assertIn("bridge template is missing", str(raised.exception))


class BridgeRootResolutionTests(unittest.TestCase):
    def test_bridges_dir_env_wins(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root / "bridges", "uxp", "photoshop")
            with mock.patch.dict(os.environ, {"ADOBEPY_BRIDGES_DIR": str(root / "bridges")}, clear=True):
                resolved, locations = cli.resolve_bridge_root()
                self.assertEqual(resolved, root / "bridges")
            self.assertTrue(any("ADOBEPY_BRIDGES_DIR" in item for item in locations))

    def test_bundled_wheel_assets_are_used_when_present(self):
        with tempfile.TemporaryDirectory() as tmp:
            bundled = pathlib.Path(tmp)
            _make_bridge_tree(bundled, "uxp", "photoshop")
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                cli, "_bundled_bridge_root", return_value=bundled
            ), mock.patch.object(cli, "_find_repo_root", return_value=None):
                resolved, _locations = cli.resolve_bridge_root()
            self.assertEqual(resolved, bundled)

    def test_adobepy_home_bridges_are_probed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            _make_bridge_tree(home / "bridges", "uxp", "photoshop")
            with mock.patch.dict(os.environ, {"ADOBEPY_HOME": str(home)}, clear=True), mock.patch.object(
                cli, "_bundled_bridge_root", return_value=None
            ), mock.patch.object(cli, "_find_repo_root", return_value=None):
                resolved, _locations = cli.resolve_bridge_root()
            self.assertEqual(resolved, home / "bridges")

    def test_repository_root_is_discovered_last(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root / "bridges", "uxp", "photoshop")
            (root / "python").mkdir()
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                cli, "_bundled_bridge_root", return_value=None
            ), mock.patch.object(cli, "_find_repo_root", return_value=root):
                resolved, _locations = cli.resolve_bridge_root()
            self.assertEqual(resolved, root / "bridges")

    def test_probe_locations_mention_every_strategy(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            binary = home / "bin" / cli._executable_name("adobepy")
            binary.parent.mkdir(parents=True)
            binary.write_text("", encoding="utf-8")
            (home / "bridges").mkdir()
            with mock.patch.dict(
                os.environ, {"ADOBEPY_HOME": str(home), "ADOBEPY_BROKER_PATH": str(binary)}, clear=True
            ), mock.patch.object(cli, "_bundled_bridge_root", return_value=None), mock.patch.object(
                cli, "_find_repo_root", return_value=None
            ):
                locations = cli.bridge_probe_locations()
        joined = " ".join(locations)
        self.assertIn("ADOBEPY_HOME", joined)
        self.assertIn("source checkout", joined)
        self.assertIn("not bundled", joined)

    def test_sdk_version_falls_back_to_unknown(self):
        with mock.patch("adobe.cli._distribution_version", side_effect=cli.PackageNotFoundError("adobepy")):
            self.assertEqual(cli.sdk_version(), "unknown")


class BrokerResolutionTests(unittest.TestCase):
    def test_environment_overrides_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            executable = pathlib.Path(tmp) / cli._executable_name("adobepy")
            executable.write_text("", encoding="utf-8")
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(executable)}, clear=True
            ):
                resolved, locations = cli.resolve_broker_executable()
            self.assertEqual(resolved, str(executable))
            self.assertTrue(any("ADOBEPY_BROKER_PATH" in item for item in locations))

    def test_adobepy_home_layout_is_probed(self):
        with tempfile.TemporaryDirectory() as tmp:
            home = pathlib.Path(tmp)
            binary = home / "bin" / cli._executable_name("adobepy")
            binary.parent.mkdir(parents=True)
            binary.write_text("", encoding="utf-8")
            with mock.patch.dict(os.environ, {"ADOBEPY_HOME": str(home)}, clear=True):
                resolved, _locations = cli.resolve_broker_executable()
            self.assertEqual(resolved, str(binary))

    def test_directory_environment_value_resolves_the_executable_inside_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = pathlib.Path(tmp) / cli._executable_name("adobepy")
            binary.write_text("", encoding="utf-8")
            with mock.patch.dict(os.environ, {"ADOBEPY_BROKER_PATH": str(tmp)}, clear=True):
                resolved, _locations = cli.resolve_broker_executable()
            self.assertEqual(resolved, str(binary))

    def test_path_lookup_is_used_when_no_environment_variable_is_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = pathlib.Path(tmp) / cli._executable_name("adobepy")
            binary.write_text("", encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
                "adobe.cli.shutil.which", return_value=str(binary)
            ):
                resolved, locations = cli.resolve_broker_executable()
            self.assertEqual(resolved, str(binary))
            self.assertIn(str(binary), locations)

    def test_unresolvable_pin_never_falls_back_to_path(self):
        # docs/runtime-discovery.md 1.1: an explicit pin must be used directly
        # and all later discovery steps skipped. Falling through to PATH here
        # would start an unverified binary for an adapter that pinned the one it
        # verified by checksum.
        with tempfile.TemporaryDirectory() as tmp:
            on_path = pathlib.Path(tmp) / cli._executable_name("adobepy")
            on_path.write_text("", encoding="utf-8")
            missing = pathlib.Path(tmp) / "missing" / "adobepy.exe"
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(missing)}, clear=True
            ), mock.patch("adobe.cli.shutil.which", return_value=str(on_path)):
                resolved, _locations = cli.resolve_broker_executable()
            self.assertIsNone(resolved)
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(missing)}, clear=True
            ), mock.patch("adobe.cli.shutil.which", return_value=str(on_path)):
                with mock.patch("adobe.runtime._healthy", return_value=False), self.assertRaises(
                    FileNotFoundError
                ):
                    ensure_broker()

    def test_unresolvable_cli_pin_never_falls_back_to_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            on_path = pathlib.Path(tmp) / cli._executable_name("adobepy")
            on_path.write_text("", encoding="utf-8")
            with mock.patch.dict(
                os.environ, {"ADOBEPY_CLI": str(pathlib.Path(tmp) / "nope" / "adobepy.exe")}, clear=True
            ), mock.patch("adobe.cli.shutil.which", return_value=str(on_path)):
                resolved, _locations = cli.resolve_broker_executable()
            self.assertIsNone(resolved)

    def test_pin_to_a_directory_without_the_executable_is_an_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            on_path = pathlib.Path(tmp) / "bin" / cli._executable_name("adobepy")
            on_path.parent.mkdir()
            on_path.write_text("", encoding="utf-8")
            empty_dir = pathlib.Path(tmp) / "empty"
            empty_dir.mkdir()
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(empty_dir)}, clear=True
            ), mock.patch("adobe.cli.shutil.which", return_value=str(on_path)):
                resolved, _locations = cli.resolve_broker_executable()
            self.assertIsNone(resolved)

    def test_missing_broker_names_every_probe(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.cli.shutil.which", return_value=None
        ):
            resolved, locations = cli.resolve_broker_executable()
            message = cli.broker_remediation(locations)
        self.assertIsNone(resolved)
        self.assertIn("PATH", " ".join(locations))
        self.assertIn("adobepy broker executable not found", message)
        self.assertIn("ADOBEPY_BROKER_PATH", message)
        self.assertIn("cargo build --release -p adobepy-cli", message)

    def test_run_broker_without_executable_returns_runtime_exit_code(self):
        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.cli.shutil.which", return_value=None
        ), mock.patch.object(sys, "stderr", stderr):
            code = cli.run_broker([])
        self.assertEqual(code, cli.EXIT_MISSING_RUNTIME)
        self.assertIn("releases/latest", stderr.getvalue())

    def test_run_broker_forwards_arguments(self):
        with mock.patch.object(cli, "resolve_broker_executable", return_value=("/tmp/adobepy", [])), mock.patch(
            "adobe.cli.subprocess.run", return_value=subprocess.CompletedProcess([], 0)
        ) as runner:
            code = cli.run_broker(["--bind", "127.0.0.1:47391"])
        self.assertEqual(code, 0)
        self.assertEqual(runner.call_args[0][0], ["/tmp/adobepy", "broker", "--bind", "127.0.0.1:47391"])


class DoctorTests(unittest.TestCase):
    def test_doctor_json_reports_every_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root / "bridges", "uxp", "photoshop")
            binary = root / "bin" / cli._executable_name("adobepy")
            binary.parent.mkdir(parents=True)
            binary.write_text("", encoding="utf-8")
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(binary)}, clear=True
            ), mock.patch.object(cli, "_find_repo_root", return_value=None), mock.patch.object(
                cli, "_bundled_bridge_root", return_value=None
            ), mock.patch.object(cli, "_broker_health", return_value=(True, "ok")):
                buffer = io.StringIO()
                with redirect_stdout(buffer):
                    code = cli.doctor(json_output=True, broker_url="http://127.0.0.1:47391")
        self.assertEqual(code, cli.EXIT_OK)
        payload = json.loads(buffer.getvalue())
        names = [check["name"] for check in payload]
        self.assertEqual(
            names, ["sdk", "python_runtime", "broker_executable", "broker_port", "bridge_templates"]
        )
        self.assertTrue(all(check["ok"] for check in payload))

    def test_doctor_fails_when_broker_is_missing(self):
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch(
            "adobe.cli.shutil.which", return_value=None
        ), mock.patch.object(cli, "_find_repo_root", return_value=None), mock.patch.object(
            cli, "_bundled_bridge_root", return_value=None
        ), mock.patch.object(cli, "_broker_health", return_value=(False, "refused")):
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = cli.doctor(json_output=False, broker_url="http://127.0.0.1:47391")
        self.assertEqual(code, cli.EXIT_FAILURE)
        self.assertIn("broker_executable", buffer.getvalue())
        self.assertIn("releases/latest", buffer.getvalue())


class MainTests(unittest.TestCase):
    def test_install_bridge_cli_writes_json_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            destination = root / "staged"
            buffer = io.StringIO()
            with redirect_stdout(buffer):
                code = cli.main(
                    [
                        "install-bridge",
                        "photoshop",
                        "--dest",
                        str(destination),
                        "--token",
                        "cli-token",
                        "--bridges-dir",
                        str(root),
                        "--json",
                    ]
                )
            self.assertEqual(code, cli.EXIT_OK)
            payload = json.loads(buffer.getvalue())
            self.assertTrue(payload["success"])
            self.assertEqual(payload["host"], "photoshop")
            self.assertTrue((destination / "adobepy.config.js").is_file())
            written = (destination / "adobepy.config.js").read_bytes()
            self.assertEqual(
                written,
                cli.bridge_config_js("photoshop", None, "cli-token", "default").encode("utf-8"),
            )
            self.assertNotIn(b"\r", written)

    def test_bridge_install_subcommand_matches_the_legacy_alias(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            _make_bridge_tree(root, "uxp", "photoshop")
            destination = root / "staged"
            code = cli.main(
                [
                    "bridge",
                    "install",
                    "photoshop",
                    "--dest",
                    str(destination),
                    "--token",
                    "cli-token",
                    "--bridges-dir",
                    str(root),
                ]
            )
            self.assertEqual(code, cli.EXIT_OK)
            self.assertTrue((destination / "adobepy.config.js").is_file())

    def test_missing_bridge_assets_exit_with_a_failure_code(self):
        stderr = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp, mock.patch.dict(
            os.environ, {}, clear=True
        ), mock.patch.object(cli, "_find_repo_root", return_value=None), mock.patch.object(
            cli, "_bundled_bridge_root", return_value=None
        ), mock.patch.object(cli, "resolve_broker_executable", return_value=(None, [])), mock.patch.object(
            sys, "stderr", stderr
        ):
            code = cli.main(
                [
                    "install-bridge",
                    "photoshop",
                    "--dest",
                    str(pathlib.Path(tmp) / "staged"),
                    "--token",
                    "cli-token",
                ]
            )
            self.assertEqual(code, cli.EXIT_FAILURE)
            self.assertIn("bridge templates not found", stderr.getvalue())

    def test_broker_subcommand_starts_the_resolved_binary(self):
        with tempfile.TemporaryDirectory() as tmp:
            binary = pathlib.Path(tmp) / cli._executable_name("adobepy")
            binary.write_text("", encoding="utf-8")
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(binary)}, clear=True
            ), mock.patch(
                "adobe.cli.subprocess.run", return_value=subprocess.CompletedProcess([], 0)
            ) as runner:
                code = cli.main(
                    ["broker", "--bind", "127.0.0.1:47391", "--token", "t", "--default-timeout-ms", "1000"]
                )
        self.assertEqual(code, 0)
        self.assertEqual(
            runner.call_args[0][0],
            [
                str(binary),
                "broker",
                "--bind",
                "127.0.0.1:47391",
                "--token",
                "t",
                "--default-timeout-ms",
                "1000",
            ],
        )

    def test_doctor_subcommand_prints_human_readable_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            binary = root / "bin" / cli._executable_name("adobepy")
            binary.parent.mkdir(parents=True)
            binary.write_text("", encoding="utf-8")
            _make_bridge_tree(root / "bridges", "uxp", "photoshop")
            buffer = io.StringIO()
            with mock.patch.dict(
                os.environ, {"ADOBEPY_BROKER_PATH": str(binary)}, clear=True
            ), mock.patch.object(cli, "_bundled_bridge_root", return_value=None), mock.patch.object(
                cli, "_find_repo_root", return_value=None
            ), mock.patch.object(cli, "_broker_health", return_value=(True, "ok")), redirect_stdout(
                buffer
            ):
                code = cli.main(["doctor"])
        self.assertEqual(code, cli.EXIT_OK)
        self.assertIn("broker_executable", buffer.getvalue())
        self.assertIn("bridge_templates", buffer.getvalue())

    def test_broker_health_maps_http_and_connection_results(self):
        response = mock.MagicMock()
        response.__enter__.return_value.status = 200
        with mock.patch("adobe.cli.urllib.request.urlopen", return_value=response):
            self.assertEqual(cli._broker_health("http://127.0.0.1:47391/"), (True, "http://127.0.0.1:47391/health -> HTTP 200"))
        with mock.patch(
            "adobe.cli.urllib.request.urlopen", side_effect=urllib.error.URLError("down")
        ):
            healthy, detail = cli._broker_health("http://127.0.0.1:47391")
        self.assertFalse(healthy)
        self.assertIn("URLError", detail)

    def test_empty_destination_is_rejected(self):
        with self.assertRaises(cli.CliError):
            cli.stage_bridge("photoshop", pathlib.Path(""), "token", bridge_root=pathlib.Path("."))

    def test_module_entry_point_runs_doctor(self):
        # `doctor` exits non-zero when no broker is installed, which is the point
        # of the command; only its JSON contract is asserted here.
        result = subprocess.run(
            [sys.executable, "-m", "adobe", "doctor", "--json"],
            cwd=str(REPO_ROOT / "python"),
            capture_output=True,
            text=True,
        )
        self.assertIn(result.returncode, (cli.EXIT_OK, cli.EXIT_FAILURE), result.stderr)
        payload = json.loads(result.stdout)
        self.assertTrue(any(check["name"] == "sdk" for check in payload))

    def test_module_main_guard_delegates_to_the_cli(self):
        buffer = io.StringIO()
        with mock.patch.object(sys, "argv", ["adobe", "doctor", "--json"]), mock.patch.object(
            cli, "_broker_health", return_value=(True, "ok")
        ), redirect_stdout(buffer):
            with self.assertRaises(SystemExit) as raised:
                runpy.run_module("adobe", run_name="__main__", alter_sys=True)
        self.assertIn(raised.exception.code, (cli.EXIT_OK, cli.EXIT_FAILURE))
        self.assertTrue(any(check["name"] == "sdk" for check in json.loads(buffer.getvalue())))


if __name__ == "__main__":
    unittest.main()
