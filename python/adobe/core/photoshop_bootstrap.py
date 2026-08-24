from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .runtime_identity import (
    _absolute_path,
    _bounded_text,
    _exact_mapping,
    _positive_int,
    _start_identity,
    _uuid,
)

_SHA256 = re.compile(r"[0-9a-f]{64}")
_VERSION_COMPONENT = r"(?:0|[1-9][0-9]{0,3})"
_VERSION = re.compile(rf"{_VERSION_COMPONENT}(?:\.{_VERSION_COMPONENT}){{1,3}}")
_TARGET = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_VERIFY_PATH = "/v1/photoshop/bootstrap/verify"


def _sha256(value: Any, label: str) -> str:
    value = _bounded_text(value, label, 64)
    if _SHA256.fullmatch(value) is None:
        raise ValueError(f"{label} is invalid")
    return value


def _version(value: Any, label: str) -> str:
    value = _bounded_text(value, label, 32)
    if _VERSION.fullmatch(value) is None:
        raise ValueError(f"{label} is invalid")
    return value


@dataclass(frozen=True)
class PhotoshopHostTarget:
    executable_path: str
    executable_bytes: int
    executable_sha256: str
    host_version: str
    profile_id: str

    @classmethod
    def from_mapping(cls, value: Any) -> PhotoshopHostTarget:
        value = _exact_mapping(
            value,
            {
                "executablePath",
                "executableBytes",
                "executableSha256",
                "hostVersion",
                "profileId",
            },
            "Photoshop host target",
        )
        return cls(
            executable_path=_absolute_path(
                value["executablePath"], "host.executablePath"
            ),
            executable_bytes=_positive_int(
                value["executableBytes"], "host.executableBytes", 4 << 30
            ),
            executable_sha256=_sha256(
                value["executableSha256"], "host.executableSha256"
            ),
            host_version=_version(value["hostVersion"], "host.hostVersion"),
            profile_id=_bounded_text(value["profileId"], "host.profileId", 256),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "executablePath": self.executable_path,
            "executableBytes": self.executable_bytes,
            "executableSha256": self.executable_sha256,
            "hostVersion": self.host_version,
            "profileId": self.profile_id,
        }


@dataclass(frozen=True)
class PhotoshopPluginTarget:
    installed_plugin_root: str
    module_origin: str
    bridge_version: str
    manifest_bytes: int
    manifest_sha256: str
    index_bytes: int
    index_sha256: str
    module_bytes: int
    module_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> PhotoshopPluginTarget:
        value = _exact_mapping(
            value,
            {
                "installedPluginRoot",
                "moduleOrigin",
                "bridgeVersion",
                "manifestBytes",
                "manifestSha256",
                "indexBytes",
                "indexSha256",
                "moduleBytes",
                "moduleSha256",
            },
            "Photoshop plugin target",
        )
        root = _absolute_path(
            value["installedPluginRoot"], "plugin.installedPluginRoot"
        )
        module = _absolute_path(value["moduleOrigin"], "plugin.moduleOrigin")
        normalized_root = root.replace("\\", "/").rstrip("/")
        normalized_module = module.replace("\\", "/").rstrip("/")
        if re.match(r"^[A-Za-z]:/", normalized_root):
            normalized_root = normalized_root.lower()
            normalized_module = normalized_module.lower()
        if normalized_module != f"{normalized_root}/dist/main.js":
            raise ValueError(
                "plugin.moduleOrigin must identify the fixed Photoshop bridge module"
            )
        return cls(
            installed_plugin_root=root,
            module_origin=module,
            bridge_version=_version(value["bridgeVersion"], "plugin.bridgeVersion"),
            manifest_bytes=_positive_int(
                value["manifestBytes"], "plugin.manifestBytes", 1 << 20
            ),
            manifest_sha256=_sha256(value["manifestSha256"], "plugin.manifestSha256"),
            index_bytes=_positive_int(
                value["indexBytes"], "plugin.indexBytes", 1 << 20
            ),
            index_sha256=_sha256(value["indexSha256"], "plugin.indexSha256"),
            module_bytes=_positive_int(
                value["moduleBytes"], "plugin.moduleBytes", 256 << 20
            ),
            module_sha256=_sha256(value["moduleSha256"], "plugin.moduleSha256"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "installedPluginRoot": self.installed_plugin_root,
            "moduleOrigin": self.module_origin,
            "bridgeVersion": self.bridge_version,
            "manifestBytes": self.manifest_bytes,
            "manifestSha256": self.manifest_sha256,
            "indexBytes": self.index_bytes,
            "indexSha256": self.index_sha256,
            "moduleBytes": self.module_bytes,
            "moduleSha256": self.module_sha256,
        }


@dataclass(frozen=True)
class PhotoshopBootstrapRequest:
    bootstrap_version: int
    target: str
    timeout_ms: int
    host: PhotoshopHostTarget
    plugin: PhotoshopPluginTarget

    @classmethod
    def from_mapping(cls, value: Any) -> PhotoshopBootstrapRequest:
        value = _exact_mapping(
            value,
            {"bootstrapVersion", "target", "timeoutMs", "host", "plugin"},
            "Photoshop bootstrap request",
        )
        bootstrap_version = _positive_int(
            value["bootstrapVersion"], "bootstrapVersion", 255
        )
        if bootstrap_version != 1:
            raise ValueError("unsupported Photoshop bootstrap version")
        target = _bounded_text(value["target"], "target", 128)
        if _TARGET.fullmatch(target) is None:
            raise ValueError("target is invalid")
        timeout_ms = _positive_int(value["timeoutMs"], "timeoutMs", 30_000)
        if timeout_ms < 50:
            raise ValueError("timeoutMs must be at least 50")
        return cls(
            bootstrap_version=bootstrap_version,
            target=target,
            timeout_ms=timeout_ms,
            host=PhotoshopHostTarget.from_mapping(value["host"]),
            plugin=PhotoshopPluginTarget.from_mapping(value["plugin"]),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "bootstrapVersion": self.bootstrap_version,
            "target": self.target,
            "timeoutMs": self.timeout_ms,
            "host": self.host.to_wire(),
            "plugin": self.plugin.to_wire(),
        }


@dataclass(frozen=True)
class BootstrapBrokerBinding:
    pid: int
    process_start_identity: str
    runtime_version: str
    instance_id: str
    executable_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> BootstrapBrokerBinding:
        value = _exact_mapping(
            value,
            {
                "pid",
                "processStartIdentity",
                "runtimeVersion",
                "instanceId",
                "executableSha256",
            },
            "bootstrap broker binding",
        )
        return cls(
            pid=_positive_int(value["pid"], "broker.pid", 0xFFFFFFFF),
            process_start_identity=_start_identity(
                value["processStartIdentity"], "broker.processStartIdentity"
            ),
            runtime_version=_version(value["runtimeVersion"], "broker.runtimeVersion"),
            instance_id=_uuid(value["instanceId"], "broker.instanceId"),
            executable_sha256=_sha256(
                value["executableSha256"], "broker.executableSha256"
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "processStartIdentity": self.process_start_identity,
            "runtimeVersion": self.runtime_version,
            "instanceId": self.instance_id,
            "executableSha256": self.executable_sha256,
        }


@dataclass(frozen=True)
class BootstrapHostBinding:
    pid: int
    process_start_identity: str
    host_version: str
    profile_id: str
    executable_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> BootstrapHostBinding:
        value = _exact_mapping(
            value,
            {
                "pid",
                "processStartIdentity",
                "hostVersion",
                "profileId",
                "executableSha256",
            },
            "bootstrap host binding",
        )
        return cls(
            pid=_positive_int(value["pid"], "host.pid", 0xFFFFFFFF),
            process_start_identity=_start_identity(
                value["processStartIdentity"], "host.processStartIdentity"
            ),
            host_version=_version(value["hostVersion"], "host.hostVersion"),
            profile_id=_bounded_text(value["profileId"], "host.profileId", 256),
            executable_sha256=_sha256(
                value["executableSha256"], "host.executableSha256"
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "pid": self.pid,
            "processStartIdentity": self.process_start_identity,
            "hostVersion": self.host_version,
            "profileId": self.profile_id,
            "executableSha256": self.executable_sha256,
        }


@dataclass(frozen=True)
class BootstrapPluginBinding:
    instance_id: str
    bridge_version: str
    module_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> BootstrapPluginBinding:
        value = _exact_mapping(
            value,
            {"instanceId", "bridgeVersion", "moduleSha256"},
            "bootstrap plugin binding",
        )
        return cls(
            instance_id=_uuid(value["instanceId"], "plugin.instanceId"),
            bridge_version=_version(value["bridgeVersion"], "plugin.bridgeVersion"),
            module_sha256=_sha256(value["moduleSha256"], "plugin.moduleSha256"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "instanceId": self.instance_id,
            "bridgeVersion": self.bridge_version,
            "moduleSha256": self.module_sha256,
        }


@dataclass(frozen=True)
class PhotoshopBootstrapContinuation:
    method: str
    path: str
    receipt_id: str
    timeout_ms: int

    @classmethod
    def from_mapping(cls, value: Any) -> PhotoshopBootstrapContinuation:
        value = _exact_mapping(
            value,
            {"method", "path", "receiptId", "timeoutMs"},
            "bootstrap continuation",
        )
        if value["method"] != "POST" or value["path"] != _VERIFY_PATH:
            raise ValueError(
                "bootstrap continuation is not the fixed verification operation"
            )
        return cls(
            method="POST",
            path=_VERIFY_PATH,
            receipt_id=_uuid(value["receiptId"], "continuation.receiptId"),
            timeout_ms=_positive_int(
                value["timeoutMs"], "continuation.timeoutMs", 30_000
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "method": self.method,
            "path": self.path,
            "receiptId": self.receipt_id,
            "timeoutMs": self.timeout_ms,
        }


@dataclass(frozen=True)
class PhotoshopBootstrapResult:
    bootstrap_version: int
    status: str
    identity_fingerprint: str
    broker: BootstrapBrokerBinding
    host: BootstrapHostBinding
    plugin: BootstrapPluginBinding
    continuation: PhotoshopBootstrapContinuation

    @classmethod
    def from_broker(cls, value: Any) -> PhotoshopBootstrapResult:
        value = _exact_mapping(
            value,
            {
                "bootstrapVersion",
                "status",
                "identityFingerprint",
                "broker",
                "host",
                "plugin",
                "continuation",
            },
            "Photoshop bootstrap result",
        )
        version = _positive_int(value["bootstrapVersion"], "bootstrapVersion", 255)
        if version != 1 or value["status"] not in {"ready", "already_ready"}:
            raise ValueError("Photoshop bootstrap result is invalid")
        return cls(
            bootstrap_version=version,
            status=value["status"],
            identity_fingerprint=_sha256(
                value["identityFingerprint"], "identityFingerprint"
            ),
            broker=BootstrapBrokerBinding.from_mapping(value["broker"]),
            host=BootstrapHostBinding.from_mapping(value["host"]),
            plugin=BootstrapPluginBinding.from_mapping(value["plugin"]),
            continuation=PhotoshopBootstrapContinuation.from_mapping(
                value["continuation"]
            ),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "bootstrapVersion": self.bootstrap_version,
            "status": self.status,
            "identityFingerprint": self.identity_fingerprint,
            "broker": self.broker.to_wire(),
            "host": self.host.to_wire(),
            "plugin": self.plugin.to_wire(),
            "continuation": self.continuation.to_wire(),
        }

    def require_request(
        self, request: PhotoshopBootstrapRequest
    ) -> PhotoshopBootstrapResult:
        if (
            self.host.host_version != request.host.host_version
            or self.host.profile_id != request.host.profile_id
            or self.host.executable_sha256 != request.host.executable_sha256
            or self.plugin.bridge_version != request.plugin.bridge_version
            or self.plugin.module_sha256 != request.plugin.module_sha256
            or self.continuation.timeout_ms != request.timeout_ms
        ):
            raise ValueError(
                "Photoshop bootstrap identity does not match the exact request"
            )
        return self

    def require_continuation(
        self, continuation: PhotoshopBootstrapContinuation
    ) -> PhotoshopBootstrapResult:
        if self.continuation != continuation:
            raise ValueError(
                "Photoshop bootstrap continuation does not match the exact receipt"
            )
        return self
