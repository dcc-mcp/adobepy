from __future__ import annotations

import argparse
import glob
import json
import keyword
import pathlib
import re
from dataclasses import dataclass, field
from typing import Any


class IrValidationError(ValueError):
    pass


IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")


@dataclass(frozen=True)
class MethodIr:
    name: str
    returns: str = "Any"
    mutates_state: bool = False
    requires_modal_when_mutating: bool = False

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "MethodIr":
        name = required_string(payload, "name")
        mutates_state = bool(payload.get("mutatesState", False))
        requires_modal = bool(payload.get("requiresModalWhenMutating", False))
        if requires_modal and not mutates_state:
            raise IrValidationError(f"method {name} sets requiresModalWhenMutating without mutatesState")
        return cls(
            name=name,
            returns=str(payload.get("returns", "Any")),
            mutates_state=mutates_state,
            requires_modal_when_mutating=requires_modal,
        )


@dataclass(frozen=True)
class PropertyIr:
    name: str
    type: str
    source: str

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "PropertyIr":
        return cls(
            name=required_string(payload, "name"),
            type=required_string(payload, "type"),
            source=required_string(payload, "source"),
        )


@dataclass(frozen=True)
class FacadePropertyIr:
    name: str
    type: str

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "FacadePropertyIr":
        return cls(
            name=required_string(payload, "name"),
            type=required_string(payload, "type"),
        )


@dataclass(frozen=True)
class FacadeMethodIr:
    name: str
    returns: str = "Any"

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "FacadeMethodIr":
        return cls(
            name=required_string(payload, "name"),
            returns=str(payload.get("returns", "Any")),
        )


@dataclass(frozen=True)
class ProxyIr:
    name: str
    properties: tuple[FacadePropertyIr, ...] = ()
    methods: tuple[FacadeMethodIr, ...] = ()

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "ProxyIr":
        name = required_string(payload, "name")
        if not name.isidentifier() or keyword.iskeyword(name):
            raise IrValidationError(f"invalid proxy name: {name}")
        properties = tuple(FacadePropertyIr.from_mapping(item) for item in payload.get("properties", ()))
        methods = tuple(FacadeMethodIr.from_mapping(item) for item in payload.get("methods", ()))
        ensure_unique_names(properties, f"proxy {name}: property")
        ensure_unique_names(methods, f"proxy {name}: method")
        return cls(name=name, properties=properties, methods=methods)


@dataclass(frozen=True)
class NamespaceIr:
    name: str
    methods: tuple[MethodIr, ...] = ()
    properties: tuple[PropertyIr, ...] = ()

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "NamespaceIr":
        name = required_string(payload, "name")
        methods = tuple(MethodIr.from_mapping(item) for item in payload.get("methods", ()))
        properties = tuple(PropertyIr.from_mapping(item) for item in payload.get("properties", ()))
        ensure_unique_names(methods, f"{name}: method")
        ensure_unique_names(properties, f"{name}: property")
        return cls(name=name, methods=methods, properties=properties)


@dataclass(frozen=True)
class HostIr:
    host: str
    version: str
    namespaces: tuple[NamespaceIr, ...] = field(default_factory=tuple)
    proxies: tuple[ProxyIr, ...] = field(default_factory=tuple)

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "HostIr":
        host = required_string(payload, "host")
        version = required_string(payload, "version")
        if not IDENTIFIER_RE.match(host) or keyword.iskeyword(host):
            raise IrValidationError(f"invalid host: {host}")
        namespaces = tuple(NamespaceIr.from_mapping(item) for item in payload.get("namespaces", ()))
        proxies = tuple(ProxyIr.from_mapping(item) for item in payload.get("proxies", ()))
        if not namespaces:
            raise IrValidationError("IR must define at least one namespace")
        ensure_unique_names(namespaces, f"{host}: namespace")
        ensure_unique_names(proxies, f"{host}: proxy")

        method_index = {(namespace.name, method.name) for namespace in namespaces for method in namespace.methods}
        for namespace in namespaces:
            for prop in namespace.properties:
                parts = prop.source.split(".")
                if len(parts) != 2:
                    raise IrValidationError(f"property {prop.name} source must be namespace.method")
                if (parts[0], parts[1]) not in method_index:
                    raise IrValidationError(f"property {prop.name} does not reference a declared method")
        return cls(host=host, version=version, namespaces=namespaces, proxies=proxies)

    def namespace(self, name: str) -> NamespaceIr | None:
        return next((namespace for namespace in self.namespaces if namespace.name == name), None)

    def method(self, namespace: str, method: str) -> MethodIr | None:
        ns = self.namespace(namespace)
        if ns is None:
            return None
        return next((item for item in ns.methods if item.name == method), None)


def required_string(payload: dict[str, Any], name: str) -> str:
    value = payload.get(name)
    if not isinstance(value, str) or not value:
        raise IrValidationError(f"required string field is missing: {name}")
    return value


def ensure_unique_names(items: tuple[Any, ...], context: str) -> None:
    seen: set[str] = set()
    for item in items:
        name = getattr(item, "name", None)
        if name in seen:
            raise IrValidationError(f"duplicate {context} {name}")
        seen.add(name)


def load_ir(path: pathlib.Path | str) -> HostIr:
    return HostIr.from_mapping(json.loads(pathlib.Path(path).read_text(encoding="utf-8")))


def capabilities_from_ir(contract: HostIr) -> dict[str, Any]:
    return {
        "host": contract.host,
        "bridgeKind": "generated",
        "bridgeVersion": contract.version,
        "namespaces": [namespace.name for namespace in contract.namespaces],
        "features": [],
        "methods": {
            namespace.name: [method.name for method in namespace.methods]
            for namespace in contract.namespaces
            if namespace.methods
        },
    }


def snake_case(value: str) -> str:
    value = value.replace("-", "_")
    value = re.sub(r"(?<!^)(?=[A-Z])", "_", value).lower()
    return value


def pascal_case(value: str) -> str:
    aliases = {"indesign": "InDesign"}
    if value in aliases:
        return aliases[value]
    return "".join(part.capitalize() for part in re.split(r"[-_]", value))


def camel_case(value: str) -> str:
    parts = value.split("_")
    return parts[0] + "".join(part.capitalize() for part in parts[1:])


def py_type(value: str) -> str:
    return re.sub(r"\b(Channel|Document|Layer|Project|Selection)\b", r"\1Proxy", value)


def render_property(name: str, type_name: str, indent: str = "    ") -> list[str]:
    return [f"{indent}@property", f"{indent}def {name}(self) -> {py_type(type_name)}: ..."]


def render_property_with_aliases(name: str, type_name: str, indent: str = "    ") -> list[str]:
    lines = render_property(name, type_name, indent=indent)
    camel = camel_case(name)
    if camel != name:
        lines.extend(render_property(camel, type_name, indent=indent))
    return lines


def render_method_with_aliases(name: str, returns: str = "Any", indent: str = "    ") -> list[str]:
    method_name = snake_case(name)
    lines = [f"{indent}def {method_name}(self, *args: Any, **kwargs: Any) -> {py_type(returns)}: ..."]
    if method_name != name:
        lines.append(f"{indent}def {name}(self, *args: Any, **kwargs: Any) -> {py_type(returns)}: ...")
    return lines


def app_has_get_version(app: NamespaceIr) -> bool:
    return any(method.name == "getVersion" for method in app.methods)


def app_method_return(app: NamespaceIr | None, method_name: str) -> str | None:
    if app is None:
        return None
    method = next((item for item in app.methods if item.name == method_name), None)
    return method.returns if method else None


def render_pyi(contract: HostIr) -> str:
    class_name = pascal_case(contract.host)
    session_name = f"{class_name}Session"
    lines = [
        "from __future__ import annotations",
        "",
        "from typing import Any",
        "from adobe.core import BrokerClient",
        "from adobe.core.session import HostSession",
        "",
        f"class {session_name}(HostSession):",
        "    def __init__(self, client: BrokerClient | None = ...) -> None: ...",
        "",
        "",
        f"class {class_name}({session_name}):",
        "    def __init__(self, *, broker_url: str | None = ..., token: str | None = ..., target: str = \"default\", timeout: float = ..., client: BrokerClient | None = ...) -> None: ...",
    ]

    app = contract.namespace("app")
    if app and app_has_get_version(app):
        lines.extend(["    @property", "    def version(self) -> str: ..."])
    app_property_names = {prop.name for prop in app.properties} if app else set()
    documents_type = app_method_return(app, "getDocuments")
    if documents_type and "documents" not in app_property_names:
        lines.extend(render_property("documents", documents_type, indent="    "))
    if app:
        for prop in app.properties:
            lines.extend(render_property_with_aliases(prop.name, prop.type, indent="    "))
    if contract.method("action", "batchPlay"):
        lines.append("    def batch_play(self, descriptors: list[dict[str, Any]], options: dict[str, Any] | None = ..., **kwargs: Any) -> Any: ...")
        lines.append("    def batchPlay(self, descriptors: list[dict[str, Any]], options: dict[str, Any] | None = ..., **kwargs: Any) -> Any: ...")

    lines.extend(["", "", f"class {class_name}App:"])
    if app and app_has_get_version(app):
        lines.extend(["    @property", "    def version(self) -> str: ..."])
    if documents_type and "documents" not in app_property_names:
        lines.extend(render_property("documents", documents_type, indent="    "))
    if app:
        for prop in app.properties:
            lines.extend(render_property_with_aliases(prop.name, prop.type, indent="    "))

    action = contract.namespace("action")
    if action:
        lines.extend(["", "", f"class {class_name}Action:"])
        for method in action.methods:
            lines.extend(render_method_with_aliases(method.name, method.returns, indent="    "))

    for proxy in contract.proxies:
        lines.extend(["", "", f"class {proxy.name}:"])
        if not proxy.properties and not proxy.methods:
            lines.append("    pass")
            continue
        for prop in proxy.properties:
            lines.extend(render_property_with_aliases(prop.name, prop.type, indent="    "))
        for method in proxy.methods:
            lines.extend(render_method_with_aliases(method.name, method.returns, indent="    "))
    return "\n".join(lines) + "\n"


def write_pyi(contract: HostIr, out_dir: pathlib.Path) -> pathlib.Path:
    target_dir = out_dir / snake_case(contract.host)
    target_dir.mkdir(parents=True, exist_ok=True)
    output = target_dir / "session.pyi"
    output.write_text(render_pyi(contract), encoding="utf-8")
    return output


def expand_paths(patterns: list[str]) -> list[pathlib.Path]:
    paths: list[pathlib.Path] = []
    for pattern in patterns:
        matches = sorted(glob.glob(pattern))
        paths.extend(pathlib.Path(match) for match in matches)
    return paths


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    validate = sub.add_parser("validate")
    validate.add_argument("paths", nargs="+")
    pyi = sub.add_parser("pyi")
    pyi.add_argument("paths", nargs="+")
    pyi.add_argument("--out-dir", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)

    paths = expand_paths(args.paths)
    if not paths:
        raise SystemExit("no IR files matched")

    contracts = [load_ir(path) for path in paths]
    if args.command == "validate":
        for contract in contracts:
            print(f"valid {contract.host} {contract.version}")
        return 0
    if args.command == "pyi":
        for contract in contracts:
            print(write_pyi(contract, args.out_dir))
        return 0
    return 1  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
