"""Copy built bridge templates into the wheel package data tree.

``python -m adobe install-bridge`` resolves ``adobe/_bridges`` first (see
``python/adobe/cli.py``), but nothing in the repository produced that directory
until now, so a wheel-only install always failed to find bridge templates. This
script copies the bridge trees built by ``npm run uxp:build`` and
``npm run cep:build`` into ``python/adobe/_bridges`` so they are packaged as
package data.

Run it after the bridge builds and before building the wheel; the CI packaging
jobs do exactly that. The target directory is generated, so it is cleaned on
every run rather than left to accumulate stale hosts.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import shutil
import sys
from typing import List, Optional, Sequence

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
BRIDGE_ROOT = REPO_ROOT / "bridges"
PACKAGE_ROOT = REPO_ROOT / "python" / "adobe"
STAGE_ROOT = PACKAGE_ROOT / "_bridges"

KINDS = ("uxp", "cep")

# Each host template must carry at least these build outputs, or the staged copy
# would install a bridge that the host cannot load.
REQUIRED_ARTIFACTS = {
    "uxp": ("dist/main.js", "index.html", "manifest.json"),
    "cep": ("dist/main.js", "dist/dom.jsx", "index.html"),
}


class BridgeStagingError(RuntimeError):
    """Raised when a bridge template cannot be staged into the wheel tree."""


def discover_hosts(bridge_root: pathlib.Path, kind: str) -> List[str]:
    kind_root = bridge_root / kind
    if not kind_root.is_dir():
        return []
    return sorted(
        entry.name
        for entry in kind_root.iterdir()
        if entry.is_dir() and entry.name != "core"
    )


def _copy_tree(source: pathlib.Path, dest: pathlib.Path) -> None:
    dest.mkdir(parents=True, exist_ok=True)
    for entry in sorted(source.iterdir()):
        target = dest / entry.name
        if entry.is_dir() and not entry.is_symlink():
            _copy_tree(entry, target)
        elif entry.is_file():
            shutil.copy2(entry, target)


def stage_kind(bridge_root: pathlib.Path, stage_root: pathlib.Path, kind: str) -> List[str]:
    """Stage every host of ``kind`` and return the staged host names."""

    hosts = discover_hosts(bridge_root, kind)
    missing: List[str] = []
    for host in hosts:
        source = bridge_root / kind / host
        for artifact in REQUIRED_ARTIFACTS[kind]:
            if not (source / artifact).is_file():
                missing.append(f"{kind}/{host}/{artifact}")
    if missing:
        raise BridgeStagingError(
            "bridge build outputs are missing; run `npm ci` and `npm run "
            f"{kind}:build` before staging: {', '.join(missing)}"
        )
    for host in hosts:
        source = bridge_root / kind / host
        target = stage_root / kind / host
        if target.exists():
            shutil.rmtree(target)
        _copy_tree(source, target)
    return hosts


def stage_bridges(
    bridge_root: pathlib.Path = BRIDGE_ROOT,
    stage_root: pathlib.Path = STAGE_ROOT,
) -> List[str]:
    """Copy every built bridge template into ``stage_root``.

    Returns the staged relative paths, for example ``uxp/photoshop``.
    """

    if not bridge_root.is_dir():
        raise BridgeStagingError(f"bridge source tree is missing: {bridge_root}")
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True)

    staged: List[str] = []
    for kind in KINDS:
        for host in stage_kind(bridge_root, stage_root, kind):
            staged.append(f"{kind}/{host}")
    if not staged:
        raise BridgeStagingError(f"no bridge templates were found under {bridge_root}")
    return staged


def _canonical_bytes(data: bytes) -> bytes:
    """Normalize physical CRLF line endings only, never string contents.

    Git checks out tracked text files with CRLF on Windows (core.autocrlf),
    while esbuild emits LF. Physical line endings carry no meaning for
    JS/JSON/HTML/XML assets, so compare a canonical form. An escaped carriage
    return inside a JS string literal is NOT a line ending: a blanket escaped
    replacement would silently accept a semantic change from a two-character
    separator to a one-character separator. Those differences must stay
    visible, so they are deliberately left untouched here.
    """

    return data.replace(bytes([13, 10]), bytes([10]))


def _canonical_sourcemap(data: bytes) -> object:
    """Parse a sourcemap and canonicalize only embedded source line endings.

    A sourcemap embeds the original source text in ``sourcesContent`` as JSON
    strings. A source file checked out with CRLF encodes those physical line
    breaks differently from an LF checkout. Decode the JSON and normalize the
    physical line breaks in the decoded string values only. An escaped
    carriage return in a JS string literal is four ordinary characters after
    decoding, so it is unchanged and semantic drift stays visible.
    """

    payload = json.loads(_canonical_bytes(data).decode("utf-8"))
    if isinstance(payload, dict) and isinstance(payload.get("sourcesContent"), list):
        payload["sourcesContent"] = [
            item.replace("\r\n", "\n").replace("\r", "\n")
            if isinstance(item, str)
            else item
            for item in payload["sourcesContent"]
        ]
    return payload


def _assets_match(relative: str, source_bytes: bytes, staged_bytes: bytes) -> bool:
    """Compare generated assets without masking semantic content differences."""

    if not relative.endswith(".map"):
        return _canonical_bytes(source_bytes) == _canonical_bytes(staged_bytes)
    try:
        return _canonical_sourcemap(source_bytes) == _canonical_sourcemap(staged_bytes)
    except (ValueError, UnicodeDecodeError):
        # A malformed sourcemap is drift in itself; never accept it as equal.
        return False


def assert_staged_matches_source(
    bridge_root: pathlib.Path = BRIDGE_ROOT,
    stage_root: pathlib.Path = STAGE_ROOT,
) -> List[str]:
    """Verify the staged tree matches the built source.

    The staged files are tracked in git, so a clean checkout can build a wheel
    without running the npm bridge builds. That convenience becomes a hazard if
    the committed copy silently drifts from `bridges/`: the wheel would ship
    stale templates and nothing would notice. Compare contents (canonicalized
    for physical line endings only), not just presence, so semantic drift
    still fails loudly.
    """

    compared: List[str] = []
    for kind in KINDS:
        # A retired host disappears from `bridges/` entirely, so the per-file
        # comparison below never visits its staged copy. Compare the complete
        # host inventory first; otherwise a whole stale host can survive
        # `--check` unnoticed.
        source_hosts = discover_hosts(bridge_root, kind)
        staged_kind_root = stage_root / kind
        staged_hosts = (
            {entry.name for entry in staged_kind_root.iterdir() if entry.is_dir()}
            if staged_kind_root.is_dir()
            else set()
        )
        retired = sorted(staged_hosts - set(source_hosts))
        if retired:
            raise BridgeStagingError(
                "staged bridge tree contains hosts the source no longer builds: "
                + ", ".join(f"{kind}/{host}" for host in retired)
                + "; run `python scripts/stage_wheel_bridges.py`"
            )
        for host in source_hosts:
            source_host = bridge_root / kind / host
            staged_host = stage_root / kind / host
            source_files = sorted(
                path.relative_to(source_host).as_posix()
                for path in source_host.rglob("*")
                if path.is_file()
            )
            for relative in source_files:
                staged_file = staged_host / relative
                if not staged_file.is_file():
                    raise BridgeStagingError(
                        f"staged bridge tree is missing {kind}/{host}/{relative}; "
                        "run `python scripts/stage_wheel_bridges.py`"
                    )
                source_bytes = (source_host / relative).read_bytes()
                staged_bytes = staged_file.read_bytes()
                if not _assets_match(relative, source_bytes, staged_bytes):
                    raise BridgeStagingError(
                        f"staged bridge file is stale: {kind}/{host}/{relative} differs "
                        "from the built source; run `python scripts/stage_wheel_bridges.py` "
                        "and commit the refreshed tree"
                    )
                compared.append(f"{kind}/{host}/{relative}")
            # Files staged for a host that no longer exists upstream are drift too.
            if staged_host.is_dir():
                stray = sorted(
                    path.relative_to(staged_host).as_posix()
                    for path in staged_host.rglob("*")
                    if path.is_file()
                )
                for relative in stray:
                    if relative not in source_files:
                        raise BridgeStagingError(
                            f"staged bridge tree has a file the source no longer builds: "
                            f"{kind}/{host}/{relative}; run "
                            "`python scripts/stage_wheel_bridges.py`"
                        )
    if not compared:
        raise BridgeStagingError(f"no bridge templates were found under {bridge_root}")
    return compared


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Stage built bridge templates into the wheel package data tree."
    )
    parser.add_argument(
        "--bridge-root",
        type=pathlib.Path,
        default=BRIDGE_ROOT,
        help=f"bridge source tree (default: {BRIDGE_ROOT})",
    )
    parser.add_argument(
        "--stage-root",
        type=pathlib.Path,
        default=STAGE_ROOT,
        help=f"wheel package data tree (default: {STAGE_ROOT})",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="verify the staged tree without rebuilding it",
    )
    args = parser.parse_args(argv)

    try:
        if args.check:
            if not args.stage_root.is_dir():
                raise BridgeStagingError(
                    f"staged bridge tree is missing: {args.stage_root}"
                )
            assert_staged_matches_source(args.bridge_root, args.stage_root)
            staged: List[str] = []
            for kind in KINDS:
                for host in discover_hosts(args.bridge_root, kind):
                    for artifact in REQUIRED_ARTIFACTS[kind]:
                        path = args.stage_root / kind / host / artifact
                        if not path.is_file():
                            raise BridgeStagingError(
                                f"staged bridge artifact is missing: {path}"
                            )
                    staged.append(f"{kind}/{host}")
            if not staged:
                raise BridgeStagingError(
                    f"no bridge templates were found under {args.bridge_root}"
                )
        else:
            staged = stage_bridges(args.bridge_root, args.stage_root)
    except BridgeStagingError as error:
        print(str(error), file=sys.stderr)
        return 1

    for item in staged:
        print(f"staged bridge: {item}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
