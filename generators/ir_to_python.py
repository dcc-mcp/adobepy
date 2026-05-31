from __future__ import annotations

import argparse
import glob
import json
import keyword
import pathlib
import pprint
import re
from dataclasses import dataclass, field
from typing import Any


class IrValidationError(ValueError):
    pass


IDENTIFIER_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*$")
MEMBER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass(frozen=True)
class MethodIr:
    name: str
    returns: str
    mutates_state: bool = False
    requires_modal_when_mutating: bool = False
    raw: bool = False

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "MethodIr":
        name = required_string(payload, "name")
        ensure_member_name(name, f"method {name}")
        returns = required_string(payload, "returns")
        mutates_state = optional_bool(payload, "mutatesState", default=False)
        requires_modal = optional_bool(payload, "requiresModalWhenMutating", default=False)
        raw = optional_bool(payload, "raw", default=False)
        if requires_modal and not mutates_state:
            raise IrValidationError(f"method {name} sets requiresModalWhenMutating without mutatesState")
        return cls(
            name=name,
            returns=returns,
            mutates_state=mutates_state,
            requires_modal_when_mutating=requires_modal,
            raw=raw,
        )


@dataclass(frozen=True)
class PropertyIr:
    name: str
    type: str
    source: str

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "PropertyIr":
        name = required_string(payload, "name")
        ensure_pythonic_property_name(name, f"property {name}")
        return cls(
            name=name,
            type=required_string(payload, "type"),
            source=required_string(payload, "source"),
        )


@dataclass(frozen=True)
class FacadePropertyIr:
    name: str
    type: str

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "FacadePropertyIr":
        name = required_string(payload, "name")
        ensure_pythonic_property_name(name, f"facade property {name}")
        return cls(
            name=name,
            type=required_string(payload, "type"),
        )


@dataclass(frozen=True)
class FacadeMethodIr:
    name: str
    returns: str
    source: str | None = None

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "FacadeMethodIr":
        name = required_string(payload, "name")
        ensure_member_name(name, f"facade method {name}")
        return cls(
            name=name,
            returns=required_string(payload, "returns"),
            source=optional_string(payload, "source"),
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
        ensure_unique_public_names(
            (*properties, *methods),
            f"proxy {name}",
        )
        return cls(name=name, properties=properties, methods=methods)


@dataclass(frozen=True)
class NamespaceIr:
    name: str
    methods: tuple[MethodIr, ...] = ()
    properties: tuple[PropertyIr, ...] = ()

    @classmethod
    def from_mapping(cls, payload: dict[str, Any]) -> "NamespaceIr":
        name = required_string(payload, "name")
        ensure_member_name(name, f"namespace {name}")
        methods = tuple(MethodIr.from_mapping(item) for item in payload.get("methods", ()))
        properties = tuple(PropertyIr.from_mapping(item) for item in payload.get("properties", ()))
        ensure_unique_names(methods, f"{name}: method")
        ensure_unique_names(properties, f"{name}: property")
        ensure_unique_public_names(methods, f"{name}: method aliases")
        ensure_unique_public_names(properties, f"{name}: property aliases")
        for method in methods:
            if name == "raw" and not method.raw:
                raise IrValidationError(f"raw namespace method {method.name} must set raw true")
            if name != "raw" and method.raw:
                raise IrValidationError(f"non-raw method {name}.{method.name} must not set raw true")
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
                ensure_source_reference(prop.source, method_index, f"property {prop.name}")
        for proxy in proxies:
            for method in proxy.methods:
                if method.source:
                    ensure_source_reference(method.source, method_index, f"facade method {proxy.name}.{method.name}")
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


def optional_bool(payload: dict[str, Any], name: str, *, default: bool) -> bool:
    value = payload.get(name, default)
    if not isinstance(value, bool):
        raise IrValidationError(f"optional boolean field must be bool: {name}")
    return value


def optional_string(payload: dict[str, Any], name: str) -> str | None:
    value = payload.get(name)
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise IrValidationError(f"optional string field must be non-empty string: {name}")
    return value


def ensure_member_name(name: str, context: str) -> None:
    if not MEMBER_RE.match(name) or keyword.iskeyword(name):
        raise IrValidationError(f"invalid {context}")


def ensure_pythonic_property_name(name: str, context: str) -> None:
    ensure_member_name(name, context)
    if snake_case(name) != name:
        raise IrValidationError(f"{context} must be snake_case; camelCase aliases are generated")


def ensure_unique_names(items: tuple[Any, ...], context: str) -> None:
    seen: set[str] = set()
    for item in items:
        name = getattr(item, "name", None)
        if name in seen:
            raise IrValidationError(f"duplicate {context} {name}")
        seen.add(name)


def public_names_for_item(item: Any) -> tuple[str, ...]:
    name = getattr(item, "name", None)
    if not isinstance(name, str):
        return ()
    if isinstance(item, (PropertyIr, FacadePropertyIr)):
        aliases = [name]
        camel = camel_case(name)
        if camel != name:
            aliases.append(camel)
        return tuple(aliases)
    if isinstance(item, (MethodIr, FacadeMethodIr)):
        aliases = [snake_case(name)]
        if aliases[0] != name:
            aliases.append(name)
        return tuple(aliases)
    return (name,)


def ensure_unique_public_names(items: tuple[Any, ...], context: str) -> None:
    seen: dict[str, str] = {}
    for item in items:
        owner = getattr(item, "name", "<unknown>")
        for public_name in public_names_for_item(item):
            prior = seen.get(public_name)
            if prior is not None:
                raise IrValidationError(
                    f"duplicate generated public member {context}.{public_name} from {prior} and {owner}"
                )
            seen[public_name] = owner


def ensure_source_reference(source: str, method_index: set[tuple[str, str]], context: str) -> None:
    parts = source.split(".")
    if len(parts) != 2:
        raise IrValidationError(f"{context} source must be namespace.method")
    if (parts[0], parts[1]) not in method_index:
        raise IrValidationError(f"{context} source does not reference a declared method")


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
    return re.sub(
        r"\b(Artboard|Channel|CharacterStyle|Clip|CompoundPathItem|Composition|Document|Effect|ExportResult|FolderItem|FootageItem|Layer|Link|Marker|Mask|OutputModule|Page|PageItem|ParagraphStyle|PathItem|PlacedItem|Project|ProjectItem|RasterItem|RenderQueue|RenderQueueItem|Selection|Sequence|SourceText|Spread|Story|Swatch|TextFrame|TextItem|TextSelection|Track)\b",
        r"\1Proxy",
        value,
    )


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


def method_metadata(contract: HostIr, source: str | None) -> dict[str, Any]:
    if not source:
        return {}
    namespace, method_name = source.split(".")
    method = contract.method(namespace, method_name)
    if not method:
        return {}
    return {
        "source": source,
        "mutatesState": method.mutates_state,
        "requiresModalWhenMutating": method.requires_modal_when_mutating,
        "raw": method.raw,
    }


def facade_manifest_from_ir(contract: HostIr) -> dict[str, Any]:
    class_name = pascal_case(contract.host)
    app_class_name = f"{class_name}App"
    classes: dict[str, dict[str, dict[str, dict[str, Any]]]] = {}

    def class_payload(name: str) -> dict[str, dict[str, dict[str, Any]]]:
        return classes.setdefault(name, {"properties": {}, "methods": {}})

    def add_property(class_key: str, name: str, type_name: str, *, source: str | None = None) -> None:
        for public_name in public_names_for_item(FacadePropertyIr(name=name, type=type_name)):
            payload: dict[str, Any] = {"canonical": name, "type": py_type(type_name)}
            payload.update(method_metadata(contract, source))
            class_payload(class_key)["properties"][public_name] = payload

    def add_method(class_key: str, method: FacadeMethodIr) -> None:
        for public_name in public_names_for_item(method):
            payload: dict[str, Any] = {"canonical": method.name, "returns": py_type(method.returns)}
            payload.update(method_metadata(contract, method.source))
            class_payload(class_key)["methods"][public_name] = payload

    app = contract.namespace("app")
    if app and app_has_get_version(app):
        add_property(class_name, "version", "str", source="app.getVersion")
        add_property(app_class_name, "version", "str", source="app.getVersion")
    app_property_names = {prop.name for prop in app.properties} if app else set()
    documents_type = app_method_return(app, "getDocuments")
    if documents_type and "documents" not in app_property_names:
        add_property(class_name, "documents", documents_type, source="app.getDocuments")
        add_property(app_class_name, "documents", documents_type, source="app.getDocuments")
    if app:
        for prop in app.properties:
            add_property(class_name, prop.name, prop.type, source=prop.source)
            add_property(app_class_name, prop.name, prop.type, source=prop.source)
    if contract.method("action", "batchPlay"):
        action_method = FacadeMethodIr(name="batchPlay", returns="Any", source="action.batchPlay")
        add_method(class_name, action_method)
        add_method(f"{class_name}Action", action_method)

    for proxy in contract.proxies:
        class_payload(proxy.name)
        for prop in proxy.properties:
            add_property(proxy.name, prop.name, prop.type)
        for method in proxy.methods:
            add_method(proxy.name, method)

    return {
        "host": contract.host,
        "version": contract.version,
        "capabilities": capabilities_from_ir(contract),
        "classes": dict(sorted(classes.items())),
    }


def render_facade_contract(contract: HostIr) -> str:
    body = pprint.pformat(facade_manifest_from_ir(contract), sort_dicts=True, width=120)
    return (
        "# Generated from generators/ir by generators/ir_to_python.py.\n"
        "# Do not edit by hand; run `npm run facades:write`.\n"
        "from __future__ import annotations\n\n"
        f"FACADE_CONTRACT = {body}\n"
    )


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


def write_facade_contract(contract: HostIr, out_dir: pathlib.Path) -> pathlib.Path:
    target_dir = out_dir / snake_case(contract.host)
    target_dir.mkdir(parents=True, exist_ok=True)
    output = target_dir / "_facade_contract.py"
    output.write_text(render_facade_contract(contract), encoding="utf-8")
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
    manifest = sub.add_parser("facade-contract")
    manifest.add_argument("paths", nargs="+")
    manifest.add_argument("--out-dir", type=pathlib.Path, required=True)
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
    if args.command == "facade-contract":
        for contract in contracts:
            print(write_facade_contract(contract, args.out_dir))
        return 0
    return 1  # pragma: no cover


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
