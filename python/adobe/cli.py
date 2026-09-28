"""Pure-Python command line surface for the ``adobepy`` SDK.

Run it with ``python -m adobe``. The Rust ``adobepy`` executable stays the
supported runtime for the broker and for DCC MCP adapters: it ships in the
platform bundle published on GitHub Releases, not in the PyPI wheel. This module
exists so a wheel-only install is still operable and diagnosable:

* ``python -m adobe doctor`` reports what is installed, what is missing, and
  where to get it, in text or JSON;
* ``python -m adobe install-bridge <host> --dest <dir> --json`` stages a bridge
  from any resolvable bridge tree, including the one next to a released CLI;
* ``python -m adobe broker`` starts the Rust broker when one is resolvable and
  fails with actionable remediation instead of a bare ``FileNotFoundError``.

The module is standard library only and keeps Python 3.8 compatibility.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

try:  # pragma: no cover - importlib.metadata exists on every supported runtime
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as _distribution_version
except ImportError:  # pragma: no cover - Python 3.7 and older are unsupported
    PackageNotFoundError = Exception  # type: ignore[assignment,misc]

    def _distribution_version(name: str) -> str:  # type: ignore[misc]
        raise PackageNotFoundError(name)


RELEASES_URL = "https://github.com/dcc-mcp/adobepy/releases/latest"
DEFAULT_BROKER_URL = "http://127.0.0.1:47391"
DEFAULT_BROKER_BIND = "127.0.0.1:47391"
DEFAULT_TARGET = "default"

EXIT_OK = 0
EXIT_FAILURE = 1
EXIT_MISSING_RUNTIME = 3

UXP_HOSTS = ("photoshop", "indesign", "premiere")
CEP_HOSTS = ("after-effects", "illustrator")
BRIDGE_KIND_BY_HOST = {**{host: "uxp" for host in UXP_HOSTS}, **{host: "cep" for host in CEP_HOSTS}}
BRIDGE_BUILD_COMMAND = {"uxp": "npm run uxp:build", "cep": "npm run cep:build"}
BRIDGE_REQUIRED_ARTIFACTS = {"uxp": ("dist/main.js",), "cep": ("dist/main.js", "dist/dom.jsx")}


class CliError(RuntimeError):
    """A user-facing CLI failure that already carries its remediation."""


def sdk_version() -> str:
    """Return the installed ``adobepy`` distribution version."""

    try:
        return _distribution_version("adobepy")
    except PackageNotFoundError:
        return "unknown"  # a source checkout that was never pip-installed


def _executable_name(base: str) -> str:
    return f"{base}.exe" if os.name == "nt" else base


def _read_env(name: str) -> str:
    return (os.environ.get(name) or "").strip()


def broker_probe_locations() -> List[str]:
    """Describe every broker location this module probes, in order."""

    locations: List[str] = []
    for variable in ("ADOBEPY_BROKER_PATH", "ADOBEPY_CLI"):
        value = _read_env(variable)
        if value:
            locations.append(f"${variable} = {value}")
    found = shutil.which("adobepy")
    locations.append(found if found else "PATH (no 'adobepy' executable)")
    home = _read_env("ADOBEPY_HOME")
    if home:
        locations.append(f"$ADOBEPY_HOME/bin = {Path(home) / 'bin' / _executable_name('adobepy')}")
    return locations


def resolve_broker_executable() -> Tuple[Optional[str], List[str]]:
    """Return the broker executable path and the locations probed to find it."""

    locations = broker_probe_locations()
    for variable in ("ADOBEPY_BROKER_PATH", "ADOBEPY_CLI"):
        value = _read_env(variable)
        if value and os.path.isfile(value):
            return value, locations
        if value and os.path.isdir(value):
            candidate = Path(value) / _executable_name("adobepy")
            if candidate.is_file():
                return str(candidate), locations
    found = shutil.which("adobepy")
    if found and os.path.isfile(found):
        return found, locations
    home = _read_env("ADOBEPY_HOME")
    if home:
        candidate = Path(home) / "bin" / _executable_name("adobepy")
        if candidate.is_file():
            return str(candidate), locations
    return None, locations


def broker_remediation(locations: Optional[Sequence[str]] = None) -> str:
    """Explain how to obtain the broker when it cannot be resolved."""

    probed = ", ".join(locations if locations is not None else broker_probe_locations())
    return (
        "adobepy broker executable not found.\n"
        f"probed: {probed}\n"
        f"install it from the runtime bundle published at {RELEASES_URL}\n"
        "  (adobepy-<version>-windows-x64.zip) and either add its bin directory to\n"
        "  PATH, set ADOBEPY_BROKER_PATH to the executable, or set ADOBEPY_HOME to\n"
        "  the extracted bundle root.\n"
        "no released binary is published for macOS or Linux: build one from source\n"
        "  with `cargo build --release -p adobepy-cli` and point ADOBEPY_BROKER_PATH\n"
        "  at target/release/adobepy."
    )


def _bundled_bridge_root() -> Optional[Path]:
    candidate = Path(__file__).resolve().parent / "_bridges"
    return candidate if candidate.is_dir() else None


def _find_repo_root() -> Optional[Path]:
    """Mirror the Rust CLI's repository root discovery."""

    candidates = [Path.cwd(), Path(__file__).resolve().parent]
    for start in candidates:
        for ancestor in start.parents:
            if (ancestor / "bridges").is_dir() and (ancestor / "python").is_dir():
                return ancestor
    return None


def bridge_probe_locations() -> List[str]:
    """Describe every bridge tree this module probes, in order."""

    locations: List[str] = []
    directory = _read_env("ADOBEPY_BRIDGES_DIR")
    if directory:
        locations.append(f"$ADOBEPY_BRIDGES_DIR = {directory}")
    bundled = _bundled_bridge_root()
    locations.append(str(bundled) if bundled else "wheel bridge assets (not bundled in this install)")
    executable, _ = resolve_broker_executable()
    if executable:
        locations.append(str(Path(executable).resolve().parent.parent / "bridges"))
    home = _read_env("ADOBEPY_HOME")
    if home:
        locations.append(f"$ADOBEPY_HOME/bridges = {Path(home) / 'bridges'}")
    repo_root = _find_repo_root()
    locations.append(str(repo_root / "bridges") if repo_root else "source checkout (no repository root found)")
    return locations


def resolve_bridge_root() -> Tuple[Optional[Path], List[str]]:
    """Return the bridge template root and the locations probed to find it."""

    locations = bridge_probe_locations()
    directory = _read_env("ADOBEPY_BRIDGES_DIR")
    if directory and Path(directory).is_dir():
        return Path(directory), locations
    bundled = _bundled_bridge_root()
    if bundled is not None:
        return bundled, locations
    executable, _ = resolve_broker_executable()
    if executable:
        candidate = Path(executable).resolve().parent.parent / "bridges"
        if candidate.is_dir():
            return candidate, locations
    home = _read_env("ADOBEPY_HOME")
    if home:
        candidate = Path(home) / "bridges"
        if candidate.is_dir():
            return candidate, locations
    repo_root = _find_repo_root()
    if repo_root is not None:
        candidate = repo_root / "bridges"
        if candidate.is_dir():
            return candidate, locations
    return None, locations


def bridge_remediation(locations: Optional[Sequence[str]] = None) -> str:
    """Explain how to obtain bridge templates when none are resolvable."""

    probed = ", ".join(locations if locations is not None else bridge_probe_locations())
    return (
        "adobepy bridge templates not found.\n"
        f"probed: {probed}\n"
        f"install the runtime bundle published at {RELEASES_URL} and set\n"
        "  ADOBEPY_BRIDGES_DIR to its bridges directory (or ADOBEPY_HOME to the\n"
        "  extracted bundle root), or run `npm ci` and `npm run uxp:build` /\n"
        "  `npm run cep:build` in a source checkout."
    )


def default_bridge_kind(host: str) -> str:
    """Return the default bridge kind for ``host``."""

    try:
        return BRIDGE_KIND_BY_HOST[host]
    except KeyError:
        raise CliError(
            f"no default bridge template is available for {host} yet; "
            f"known hosts: {', '.join(sorted(BRIDGE_KIND_BY_HOST))}"
        ) from None


def websocket_url(host: str, broker_url: Optional[str]) -> str:
    """Convert a broker HTTP URL into the host bridge websocket URL."""

    if not broker_url or not broker_url.strip():
        return f"ws://127.0.0.1:47391/v1/bridge/{host}/ws"
    url = broker_url.strip()
    if url.startswith("http://"):
        converted = f"ws://{url[len('http://') :]}"
    elif url.startswith("https://"):
        converted = f"wss://{url[len('https://') :]}"
    else:
        converted = url
    if "/v1/bridge/" in converted:
        return converted
    return f"{converted.rstrip('/')}/v1/bridge/{host}/ws"


def bridge_config_js(host: str, broker_url: Optional[str], token: str, target: str) -> str:
    """Render ``adobepy.config.js`` exactly as the Rust CLI does."""

    return (
        "(function(){var config={brokerUrl:"
        f"{json.dumps(websocket_url(host, broker_url))},token:{json.dumps(token)},target:{json.dumps(target)}"
        "};globalThis.__ADOBEPY_BROKER_URL=globalThis.__ADOBEPY_BROKER_URL||config.brokerUrl;"
        "globalThis.__ADOBEPY_TOKEN=globalThis.__ADOBEPY_TOKEN||config.token;"
        "globalThis.__ADOBEPY_TARGET=globalThis.__ADOBEPY_TARGET||config.target;}());\n"
    )


def _resolve_destination_root(dest: Path) -> Path:
    current = dest
    missing: List[str] = []
    while not current.exists():
        if not current.name:
            raise CliError(f"bridge install destination must name a directory: {dest}")
        missing.append(current.name)
        parent = current.parent
        if parent == current:  # pragma: no cover - filesystem root
            break
        current = parent
    resolved = current.resolve()
    for part in reversed(missing):
        resolved = resolved / part
    return resolved


def _copy_tree(source: Path, dest: Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source.iterdir()):
        target = dest / entry.name
        if entry.is_dir() and not entry.is_symlink():
            _copy_tree(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)


def stage_bridge(
    host: str,
    dest: Path,
    token: str,
    *,
    broker_url: Optional[str] = None,
    target: str = DEFAULT_TARGET,
    kind: Optional[str] = None,
    bridge_root: Optional[Path] = None,
) -> Dict[str, Any]:
    """Copy one bridge template into ``dest`` and write its broker config."""

    if not token.strip():
        raise CliError("a broker token is required; pass --token or set ADOBEPY_TOKEN")
    resolved_kind = (kind or "auto").lower()
    if resolved_kind in ("", "auto"):
        resolved_kind = default_bridge_kind(host)
    if resolved_kind not in BRIDGE_REQUIRED_ARTIFACTS:
        raise CliError(f"unsupported bridge kind {resolved_kind!r}; expected 'uxp' or 'cep'")

    root, locations = (Path(bridge_root), list(bridge_probe_locations())) if bridge_root else resolve_bridge_root()
    if root is None:
        raise CliError(bridge_remediation(locations))
    source = root / resolved_kind / host
    if not source.is_dir():
        raise CliError(
            f"bridge template is missing at {source}\n" + bridge_remediation(locations)
        )
    for artifact in BRIDGE_REQUIRED_ARTIFACTS[resolved_kind]:
        if not (source / artifact).is_file():
            raise CliError(
                f"bridge artifact is missing at {source / artifact}; "
                f"source checkouts must run `npm ci` and `{BRIDGE_BUILD_COMMAND[resolved_kind]}` before install-bridge"
            )

    destination = _resolve_destination_root(Path(dest))
    source_root = source.resolve()
    if destination == source_root or source_root in destination.parents:
        raise CliError(f"bridge install destination must not be inside the source template: {dest}")
    _copy_tree(source_root, destination)
    config_path = destination / "adobepy.config.js"
    # Write bytes with an explicit LF newline: the Rust CLI emits the same file
    # and installers compare bridge files by hash.
    config_path.write_bytes(bridge_config_js(host, broker_url, token, target).encode("utf-8"))
    return {
        "success": True,
        "host": host,
        "kind": resolved_kind,
        "destination": str(destination),
        "config": str(config_path),
        "token_configured": True,
    }


def _broker_health(url: str) -> Tuple[bool, str]:
    try:
        with urllib.request.urlopen(f"{url.rstrip('/')}/health", timeout=1.0) as response:
            return response.status == 200, f"{url.rstrip('/')}/health -> HTTP {response.status}"
    except (OSError, urllib.error.URLError) as error:
        return False, f"{url.rstrip('/')}/health -> {error.__class__.__name__}"


def doctor(*, json_output: bool, broker_url: Optional[str] = None) -> int:
    """Report install health. Returns the process exit code."""

    url = broker_url or _read_env("ADOBEPY_BROKER_URL") or DEFAULT_BROKER_URL
    executable, broker_locations = resolve_broker_executable()
    bridge_root, bridge_locations = resolve_bridge_root()
    healthy, health_detail = _broker_health(url)
    checks: List[Dict[str, Any]] = [
        {"name": "sdk", "ok": True, "detail": f"adobepy {sdk_version()} (import name: adobe)"},
        {"name": "python_runtime", "ok": True, "detail": sys.executable},
        {
            "name": "broker_executable",
            "ok": executable is not None,
            "detail": executable if executable else broker_remediation(broker_locations),
        },
        {"name": "broker_port", "ok": healthy, "detail": health_detail},
        {
            "name": "bridge_templates",
            "ok": bridge_root is not None,
            "detail": str(bridge_root) if bridge_root else bridge_remediation(bridge_locations),
        },
    ]
    if json_output:
        print(json.dumps(checks, indent=2))
    else:
        for check in checks:
            status = "ok  " if check["ok"] else "warn"
            print(f"{status}  {check['name']:<18} {check['detail']}")
        if not all(check["ok"] for check in checks):
            print(
                "\nSome checks need attention. The PyPI wheel ships the Python SDK only;\n"
                f"the broker and bridge templates ship in the runtime bundle at {RELEASES_URL}."
            )
    return EXIT_OK if all(check["ok"] for check in checks) else EXIT_FAILURE


def run_broker(argv: Sequence[str]) -> int:
    """Start the Rust broker from a resolved executable."""

    executable, locations = resolve_broker_executable()
    if executable is None:
        print(broker_remediation(locations), file=sys.stderr)
        return EXIT_MISSING_RUNTIME
    result = subprocess.run([executable, "broker", *argv])
    return int(result.returncode)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m adobe",
        description="Pure-Python helpers for the adobepy SDK (the Rust CLI remains the runtime broker).",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    doctor_parser = subparsers.add_parser("doctor", help="report SDK, broker, and bridge availability")
    doctor_parser.add_argument("--broker", default=None, help=f"broker URL to probe (default: {DEFAULT_BROKER_URL})")
    doctor_parser.add_argument("--json", action="store_true", help="print machine-readable JSON")

    bridge_parser = subparsers.add_parser("bridge", help="bridge template commands")
    bridge_subparsers = bridge_parser.add_subparsers(dest="bridge_command", required=True)
    install_parser = bridge_subparsers.add_parser("install", help="copy a bridge template and write its config")
    _add_install_bridge_arguments(install_parser)

    legacy_parser = subparsers.add_parser(
        "install-bridge",
        help="alias of `bridge install` that mirrors the Rust CLI",
    )
    _add_install_bridge_arguments(legacy_parser)

    broker_parser = subparsers.add_parser("broker", help="start the Rust broker")
    broker_parser.add_argument("--bind", default=None, help=f"address to bind (default: {DEFAULT_BROKER_BIND})")
    broker_parser.add_argument("--token", default=None, help="broker token (default: $ADOBEPY_TOKEN)")
    broker_parser.add_argument("--default-timeout-ms", default=None, help="default request timeout in ms")

    return parser


def _add_install_bridge_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("host", help=f"target host: {', '.join(sorted(BRIDGE_KIND_BY_HOST))}")
    parser.add_argument("--dest", required=True, help="destination directory for the staged bridge")
    parser.add_argument("--kind", choices=("auto", "uxp", "cep"), default="auto", help="bridge kind (default: auto)")
    parser.add_argument("--broker-url", default=None, help=f"broker URL (default: {DEFAULT_BROKER_URL})")
    parser.add_argument("--token", default=None, help="broker token (default: $ADOBEPY_TOKEN)")
    parser.add_argument("--target", default=DEFAULT_TARGET, help=f"session target (default: {DEFAULT_TARGET})")
    parser.add_argument("--bridges-dir", default=None, help="bridge template root (default: auto-discovered)")
    parser.add_argument("--json", action="store_true", help="print machine-readable JSON")


def main(argv: Optional[Sequence[str]] = None) -> int:
    """CLI entry point. Returns the process exit code."""

    parser = build_parser()
    args = parser.parse_args(list(argv) if argv is not None else None)

    if args.command == "doctor":
        return doctor(json_output=args.json, broker_url=args.broker)

    if args.command in ("install-bridge", "bridge"):
        token = args.token if args.token is not None else _read_env("ADOBEPY_TOKEN")
        broker_url = args.broker_url if args.broker_url is not None else _read_env("ADOBEPY_BROKER_URL")
        try:
            payload = stage_bridge(
                args.host,
                Path(args.dest),
                token or "",
                broker_url=broker_url,
                target=args.target,
                kind=None if args.kind == "auto" else args.kind,
                bridge_root=Path(args.bridges_dir) if args.bridges_dir else None,
            )
        except CliError as error:
            print(str(error), file=sys.stderr)
            return EXIT_FAILURE
        if args.json:
            print(json.dumps(payload, indent=2))
        else:
            print(f"installed bridge template for {args.host} to {payload['destination']} (token configured)")
        return EXIT_OK

    if args.command == "broker":
        forwarded: List[str] = []
        if args.bind:
            forwarded += ["--bind", args.bind]
        token = args.token if args.token is not None else _read_env("ADOBEPY_TOKEN")
        if token:
            forwarded += ["--token", token]
        if args.default_timeout_ms:
            forwarded += ["--default-timeout-ms", str(args.default_timeout_ms)]
        return run_broker(forwarded)

    parser.error(f"unknown command: {args.command}")  # pragma: no cover - argparse guards this
    return EXIT_FAILURE  # pragma: no cover


__all__ = [
    "BRIDGE_KIND_BY_HOST",
    "CliError",
    "broker_remediation",
    "bridge_config_js",
    "bridge_remediation",
    "build_parser",
    "doctor",
    "main",
    "resolve_broker_executable",
    "resolve_bridge_root",
    "stage_bridge",
    "websocket_url",
]
