"""Keep generated runtime facade contracts in sync with IR and runtime classes."""

from __future__ import annotations

import argparse
import ast
import difflib
import pathlib
import sys
from typing import Dict, Iterable, List, Optional, Sequence, Set


ROOT = pathlib.Path(__file__).resolve().parents[1]
PYTHON_ROOT = ROOT / "python" / "adobe"
IR_DIR = ROOT / "generators" / "ir"

if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from generators.ir_to_python import HostIr, facade_manifest_from_ir, load_ir, render_facade_contract, snake_case


class FacadeContractCheckError(AssertionError):
    """Raised when generated facade contracts drift from IR or runtime code."""


def public_members_from_source(source: str, filename: str) -> Dict[str, Set[str]]:
    tree = ast.parse(source, filename=filename)
    classes: Dict[str, Set[str]] = {}
    for node in tree.body:
        if not isinstance(node, ast.ClassDef):
            continue
        members: Set[str] = set()
        for item in node.body:
            if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) and not item.name.startswith("__"):
                members.add(item.name)
        classes[node.name] = members
    return classes


def public_members(path: pathlib.Path) -> Dict[str, Set[str]]:
    return public_members_from_source(path.read_text(encoding="utf-8"), str(path))


def iter_contracts() -> Iterable[HostIr]:
    for path in sorted(IR_DIR.glob("*.json")):
        yield load_ir(path)


def expected_contract_path(contract: HostIr) -> pathlib.Path:
    return PYTHON_ROOT / snake_case(contract.host) / "_facade_contract.py"


def runtime_path(contract: HostIr) -> pathlib.Path:
    return PYTHON_ROOT / snake_case(contract.host) / "session.py"


def write_contract(contract: HostIr) -> pathlib.Path:
    target = expected_contract_path(contract)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_facade_contract(contract), encoding="utf-8")
    return target


def compare_generated_file(contract: HostIr) -> List[str]:
    target = expected_contract_path(contract)
    expected = render_facade_contract(contract)
    if not target.exists():
        return [
            f"{target.relative_to(ROOT)}: missing generated facade contract; "
            "run python scripts/check_generated_facade_contracts.py --write"
        ]
    actual = target.read_text(encoding="utf-8")
    if actual == expected:
        return []
    diff = "\n".join(
        difflib.unified_diff(
            actual.splitlines(),
            expected.splitlines(),
            fromfile=str(target.relative_to(ROOT)),
            tofile=f"generated:{target.relative_to(ROOT)}",
            lineterm="",
        )
    )
    return [f"{target.relative_to(ROOT)} is out of date:\n{diff}"]


def compare_runtime_members(contract: HostIr) -> List[str]:
    manifest = facade_manifest_from_ir(contract)
    runtime_members = public_members(runtime_path(contract))
    failures: List[str] = []
    for class_name, class_payload in sorted(manifest["classes"].items()):
        expected = set(class_payload["properties"]) | set(class_payload["methods"])
        actual = runtime_members.get(class_name)
        if actual is None:
            failures.append(f"{runtime_path(contract).relative_to(ROOT)}: missing runtime class {class_name}")
            continue
        missing = expected - actual
        if missing:
            failures.append(
                f"{runtime_path(contract).relative_to(ROOT)}:{class_name} "
                f"missing generated facade members {sorted(missing)}"
            )
    return failures


def check_contracts() -> List[str]:
    errors: List[str] = []
    messages: List[str] = []
    for contract in iter_contracts():
        errors.extend(compare_generated_file(contract))
        errors.extend(compare_runtime_members(contract))
        manifest = facade_manifest_from_ir(contract)
        class_count = len(manifest["classes"])
        member_count = sum(len(item["properties"]) + len(item["methods"]) for item in manifest["classes"].values())
        messages.append(
            f"{contract.host}: generated facade contract matches IR and runtime "
            f"({class_count} classes, {member_count} public members)"
        )
    if errors:
        raise FacadeContractCheckError("\n".join(errors))
    return messages


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Check generated Adobe runtime facade contracts")
    parser.add_argument("--write", action="store_true", help="rewrite committed facade contracts from the IR")
    args = parser.parse_args(argv)

    if args.write:
        for contract in iter_contracts():
            print(write_contract(contract).relative_to(ROOT))
        return 0

    try:
        messages = check_contracts()
    except FacadeContractCheckError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    for message in messages:
        print(f"facade contract ok: {message}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
