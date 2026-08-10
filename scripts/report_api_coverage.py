"""Print the Adobe facade coverage matrix from the API source registry."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any, Dict, List, Optional, Sequence

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.validate_api_sources import DEFAULT_IR_DIR, DEFAULT_REGISTRY, validate_registry


def load_json(path: pathlib.Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def build_rows(registry_path: pathlib.Path) -> List[Dict[str, Any]]:
    registry = load_json(registry_path)
    rows: List[Dict[str, Any]] = []
    for source in registry["sources"]:
        targets = source["coverageTargets"]
        mvp = [target for target in targets if target["level"] == "mvp"]
        planned = [target for target in targets if target["level"] == "planned"]
        ir = load_json(ROOT / source["ir"])
        structured_dom = any(namespace.get("name") == "dom" for namespace in ir["namespaces"])
        rows.append(
            {
                "host": source["host"],
                "bridge": source["bridgeKind"],
                "mvp": len(mvp),
                "planned": len(planned),
                "total": len(targets),
                "percent": round((len(mvp) / len(targets)) * 100, 1),
                "structured_dom": structured_dom,
                "next": [target["name"] for target in planned],
            }
        )
    return rows


def render_markdown(rows: List[Dict[str, Any]]) -> str:
    lines = [
        "Declared target progress measures only registry-listed typed facade families; "
        "it is not a percentage of Adobe's complete API surface.",
        "",
        "| Host | Bridge | Typed facade targets | Planned typed targets | Declared target progress | Structured official DOM | Next typed targets |",
        "| --- | --- | ---: | ---: | ---: | --- | --- |",
    ]
    for row in rows:
        next_targets = ", ".join(row["next"]) if row["next"] else "none"
        display = dict(row)
        display["next_targets"] = next_targets
        display["structured_dom"] = "yes" if row["structured_dom"] else "no"
        lines.append(
            "| {host} | {bridge} | {mvp} | {planned} | {percent}% | {structured_dom} | {next_targets} |".format(
                **display,
            )
        )
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Report Adobe API facade coverage")
    parser.add_argument("--registry", type=pathlib.Path, default=DEFAULT_REGISTRY)
    parser.add_argument("--ir-dir", type=pathlib.Path, default=DEFAULT_IR_DIR)
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args(argv)

    validate_registry(args.registry, args.ir_dir)
    rows = build_rows(args.registry)
    if args.format == "json":
        print(json.dumps(rows, indent=2, sort_keys=True))
    else:
        print(render_markdown(rows))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
