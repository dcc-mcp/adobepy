from __future__ import annotations

import re
import unicodedata
import uuid
from dataclasses import dataclass
from typing import Any, Mapping


_BRIDGE_KINDS = {"uxp", "cep", "extendscript", "lua", "native", "acrobat-js", "rest"}


def _exact_mapping(value: Any, keys: set[str], label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != keys:
        raise ValueError(f"{label} must contain the exact runtime identity fields")
    return value


def _bounded_text(value: Any, label: str, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or value != value.strip()
        or len(value.encode("utf-8")) > limit
        or any(unicodedata.category(character).startswith("C") for character in value)
    ):
        raise ValueError(f"{label} is invalid")
    return value


def _positive_int(value: Any, label: str, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= maximum:
        raise ValueError(f"{label} is invalid")
    return value


def _start_identity(value: Any, label: str) -> str:
    value = _bounded_text(value, label, 256)
    if not re.fullmatch(r"[A-Za-z0-9:_.-]+", value):
        raise ValueError(f"{label} is invalid")
    return value


def _absolute_path(value: Any, label: str) -> str:
    value = _bounded_text(value, label, 32768)
    normalized = value.replace("\\", "/").rstrip("/")
    absolute = normalized.startswith("/") or bool(re.match(r"^[A-Za-z]:/", normalized))
    if not absolute or any(component in {".", ".."} for component in normalized.split("/")):
        raise ValueError(f"{label} is invalid")
    return value


def _uuid(value: Any, label: str) -> str:
    value = _bounded_text(value, label, 36)
    try:
        parsed = uuid.UUID(value)
    except (ValueError, AttributeError) as exc:
        raise ValueError(f"{label} is invalid") from exc
    if parsed.int == 0 or str(parsed) != value.lower():
        raise ValueError(f"{label} is invalid")
    return value


@dataclass(frozen=True)
class BrokerRuntimeIdentity:
    pid: int
    process_start_identity: str
    executable_path: str
    runtime_version: str
    instance_id: str

    @classmethod
    def from_mapping(cls, value: Any) -> "BrokerRuntimeIdentity":
        value = _exact_mapping(
            value,
            {"pid", "processStartIdentity", "executablePath", "runtimeVersion", "instanceId"},
            "broker identity",
        )
        return cls(
            pid=_positive_int(value["pid"], "broker.pid", 0xFFFFFFFF),
            process_start_identity=_start_identity(value["processStartIdentity"], "broker.processStartIdentity"),
            executable_path=_absolute_path(value["executablePath"], "broker.executablePath"),
            runtime_version=_bounded_text(value["runtimeVersion"], "broker.runtimeVersion", 64),
            instance_id=_uuid(value["instanceId"], "broker.instanceId"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "processStartIdentity": self.process_start_identity,
            "executablePath": self.executable_path,
            "runtimeVersion": self.runtime_version,
            "instanceId": self.instance_id,
        }


@dataclass(frozen=True)
class HostRuntimeIdentity:
    pid: int
    process_start_identity: str
    executable_path: str
    host_version: str
    profile_id: str

    @classmethod
    def from_mapping(cls, value: Any) -> "HostRuntimeIdentity":
        value = _exact_mapping(
            value,
            {"pid", "processStartIdentity", "executablePath", "hostVersion", "profileId"},
            "host identity",
        )
        return cls(
            pid=_positive_int(value["pid"], "host.pid", 0xFFFFFFFF),
            process_start_identity=_start_identity(value["processStartIdentity"], "host.processStartIdentity"),
            executable_path=_absolute_path(value["executablePath"], "host.executablePath"),
            host_version=_bounded_text(value["hostVersion"], "host.hostVersion", 64),
            profile_id=_bounded_text(value["profileId"], "host.profileId", 256),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "processStartIdentity": self.process_start_identity,
            "executablePath": self.executable_path,
            "hostVersion": self.host_version,
            "profileId": self.profile_id,
        }


@dataclass(frozen=True)
class BridgeRuntimeIdentity:
    target: str
    bridge_kind: str
    bridge_version: str
    connected_at_epoch_ms: int
    instance_id: str
    installed_plugin_root: str
    module_origin: str

    @classmethod
    def from_mapping(cls, value: Any) -> "BridgeRuntimeIdentity":
        value = _exact_mapping(
            value,
            {
                "target",
                "bridgeKind",
                "bridgeVersion",
                "connectedAtEpochMs",
                "instanceId",
                "installedPluginRoot",
                "moduleOrigin",
            },
            "bridge identity",
        )
        target = _bounded_text(value["target"], "bridge.target", 128)
        if not re.fullmatch(r"[A-Za-z0-9_.-]+", target):
            raise ValueError("bridge.target is invalid")
        bridge_kind = _bounded_text(value["bridgeKind"], "bridge.bridgeKind", 32)
        if bridge_kind not in _BRIDGE_KINDS:
            raise ValueError("bridge.bridgeKind is invalid")
        plugin_root = _absolute_path(value["installedPluginRoot"], "bridge.installedPluginRoot")
        module_origin = _absolute_path(value["moduleOrigin"], "bridge.moduleOrigin")
        normalized_root = plugin_root.replace("\\", "/").rstrip("/")
        normalized_module = module_origin.replace("\\", "/").rstrip("/")
        if re.match(r"^[A-Za-z]:/", normalized_root):
            normalized_root = normalized_root.lower()
            normalized_module = normalized_module.lower()
        if not normalized_module.startswith(f"{normalized_root}/"):
            raise ValueError("bridge.moduleOrigin is outside bridge.installedPluginRoot")
        return cls(
            target=target,
            bridge_kind=bridge_kind,
            bridge_version=_bounded_text(value["bridgeVersion"], "bridge.bridgeVersion", 64),
            connected_at_epoch_ms=_positive_int(
                value["connectedAtEpochMs"], "bridge.connectedAtEpochMs", (1 << 64) - 1
            ),
            instance_id=_uuid(value["instanceId"], "bridge.instanceId"),
            installed_plugin_root=plugin_root,
            module_origin=module_origin,
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "bridgeKind": self.bridge_kind,
            "bridgeVersion": self.bridge_version,
            "connectedAtEpochMs": self.connected_at_epoch_ms,
            "instanceId": self.instance_id,
            "installedPluginRoot": self.installed_plugin_root,
            "moduleOrigin": self.module_origin,
        }


@dataclass(frozen=True)
class RuntimeIdentityAttestation:
    identity_version: int
    broker: BrokerRuntimeIdentity
    host: HostRuntimeIdentity
    bridge: BridgeRuntimeIdentity

    @classmethod
    def from_broker(cls, value: Any) -> "RuntimeIdentityAttestation":
        value = _exact_mapping(value, {"identityVersion", "broker", "host", "bridge"}, "runtime identity")
        version = _positive_int(value["identityVersion"], "identityVersion", 255)
        if version != 1:
            raise ValueError("unsupported runtime identity version")
        return cls(
            identity_version=version,
            broker=BrokerRuntimeIdentity.from_mapping(value["broker"]),
            host=HostRuntimeIdentity.from_mapping(value["host"]),
            bridge=BridgeRuntimeIdentity.from_mapping(value["bridge"]),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "identityVersion": self.identity_version,
            "broker": self.broker.to_wire(),
            "host": self.host.to_wire(),
            "bridge": self.bridge.to_wire(),
        }
