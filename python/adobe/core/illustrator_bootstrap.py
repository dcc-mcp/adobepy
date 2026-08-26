from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from .photoshop_bootstrap import (
    _sha256,
    _version,
)
from .runtime_identity import (
    _absolute_path,
    _bounded_text,
    _exact_mapping,
    _positive_int,
    _uuid,
)

_TARGET = re.compile(r"[A-Za-z0-9_.-]{1,128}")
_VERIFY_PATH = "/v1/illustrator/bootstrap/verify"


@dataclass(frozen=True)
class IllustratorHostTarget:
    executable_path: str
    executable_bytes: int
    executable_sha256: str
    host_version: str
    profile_id: str

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorHostTarget:
        value = _exact_mapping(
            value,
            {
                "executablePath",
                "executableBytes",
                "executableSha256",
                "hostVersion",
                "profileId",
            },
            "Illustrator host target",
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
class IllustratorPluginTarget:
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
    def from_mapping(cls, value: Any) -> IllustratorPluginTarget:
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
            "Illustrator plugin target",
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
                "plugin.moduleOrigin must identify the fixed Illustrator bridge module"
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
class IllustratorBootstrapRequest:
    bootstrap_version: int
    target: str
    timeout_ms: int
    host: IllustratorHostTarget
    plugin: IllustratorPluginTarget

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorBootstrapRequest:
        value = _exact_mapping(
            value,
            {"bootstrapVersion", "target", "timeoutMs", "host", "plugin"},
            "Illustrator bootstrap request",
        )
        version = _positive_int(value["bootstrapVersion"], "bootstrapVersion", 255)
        if version != 1:
            raise ValueError("unsupported Illustrator bootstrap version")
        target = _bounded_text(value["target"], "target", 128)
        if _TARGET.fullmatch(target) is None:
            raise ValueError("target is invalid")
        timeout_ms = _positive_int(value["timeoutMs"], "timeoutMs", 30_000)
        if timeout_ms < 50:
            raise ValueError("timeoutMs must be at least 50")
        return cls(
            bootstrap_version=version,
            target=target,
            timeout_ms=timeout_ms,
            host=IllustratorHostTarget.from_mapping(value["host"]),
            plugin=IllustratorPluginTarget.from_mapping(value["plugin"]),
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
class IllustratorBootstrapContinuation:
    method: str
    path: str
    receipt_id: str
    timeout_ms: int

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorBootstrapContinuation:
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
class IllustratorAdapterContinuation:
    kind: str
    argv: tuple[str, str, str]

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorAdapterContinuation:
        value = _exact_mapping(value, {"kind", "argv"}, "adapter continuation")
        expected = ["dcc-mcp-illustrator", "verify", "--json"]
        if value["kind"] != "command" or value["argv"] != expected:
            raise ValueError(
                "adapter continuation is not the fixed Illustrator verify command"
            )
        return cls(kind="command", argv=tuple(expected))

    def to_wire(self) -> dict[str, Any]:
        return {"kind": self.kind, "argv": list(self.argv)}


@dataclass(frozen=True)
class IllustratorBrokerBinding:
    pid: int
    process_start_identity: str
    runtime_version: str
    instance_id: str
    executable_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorBrokerBinding:
        value = _exact_mapping(
            value,
            {
                "pid",
                "processStartIdentity",
                "runtimeVersion",
                "instanceId",
                "executableSha256",
            },
            "Illustrator broker binding",
        )
        return cls(
            pid=_positive_int(value["pid"], "broker.pid", (1 << 32) - 1),
            process_start_identity=_bounded_text(
                value["processStartIdentity"], "broker.processStartIdentity", 256
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
class IllustratorHostBinding:
    pid: int
    process_start_identity: str
    host_version: str
    profile_id: str
    instance_id: str
    executable_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorHostBinding:
        value = _exact_mapping(
            value,
            {
                "pid",
                "processStartIdentity",
                "hostVersion",
                "profileId",
                "instanceId",
                "executableSha256",
            },
            "Illustrator host binding",
        )
        return cls(
            pid=_positive_int(value["pid"], "host.pid", (1 << 32) - 1),
            process_start_identity=_bounded_text(
                value["processStartIdentity"], "host.processStartIdentity", 256
            ),
            host_version=_version(value["hostVersion"], "host.hostVersion"),
            profile_id=_bounded_text(value["profileId"], "host.profileId", 256),
            instance_id=_uuid(value["instanceId"], "host.instanceId"),
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
            "instanceId": self.instance_id,
            "executableSha256": self.executable_sha256,
        }


@dataclass(frozen=True)
class IllustratorPluginBinding:
    target: str
    connected_at_epoch_ms: int
    instance_id: str
    bridge_version: str
    module_sha256: str

    @classmethod
    def from_mapping(cls, value: Any) -> IllustratorPluginBinding:
        value = _exact_mapping(
            value,
            {
                "target",
                "connectedAtEpochMs",
                "instanceId",
                "bridgeVersion",
                "moduleSha256",
            },
            "Illustrator plugin binding",
        )
        target = _bounded_text(value["target"], "plugin.target", 128)
        if _TARGET.fullmatch(target) is None:
            raise ValueError("plugin.target is invalid")
        return cls(
            target=target,
            connected_at_epoch_ms=_positive_int(
                value["connectedAtEpochMs"], "plugin.connectedAtEpochMs", (1 << 64) - 1
            ),
            instance_id=_uuid(value["instanceId"], "plugin.instanceId"),
            bridge_version=_version(value["bridgeVersion"], "plugin.bridgeVersion"),
            module_sha256=_sha256(value["moduleSha256"], "plugin.moduleSha256"),
        )

    def to_wire(self) -> dict[str, Any]:
        return {
            "target": self.target,
            "connectedAtEpochMs": self.connected_at_epoch_ms,
            "instanceId": self.instance_id,
            "bridgeVersion": self.bridge_version,
            "moduleSha256": self.module_sha256,
        }


@dataclass(frozen=True)
class IllustratorBootstrapResult:
    bootstrap_version: int
    status: str
    identity_fingerprint: str
    broker: IllustratorBrokerBinding
    host: IllustratorHostBinding
    plugin: IllustratorPluginBinding
    continuation: IllustratorBootstrapContinuation
    adapter_continuation: IllustratorAdapterContinuation

    @classmethod
    def from_broker(cls, value: Any) -> IllustratorBootstrapResult:
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
                "adapterContinuation",
            },
            "Illustrator bootstrap result",
        )
        version = _positive_int(value["bootstrapVersion"], "bootstrapVersion", 255)
        if version != 1 or value["status"] not in {"ready", "already_ready"}:
            raise ValueError("Illustrator bootstrap result is invalid")
        return cls(
            bootstrap_version=version,
            status=value["status"],
            identity_fingerprint=_sha256(
                value["identityFingerprint"], "identityFingerprint"
            ),
            broker=IllustratorBrokerBinding.from_mapping(value["broker"]),
            host=IllustratorHostBinding.from_mapping(value["host"]),
            plugin=IllustratorPluginBinding.from_mapping(value["plugin"]),
            continuation=IllustratorBootstrapContinuation.from_mapping(
                value["continuation"]
            ),
            adapter_continuation=IllustratorAdapterContinuation.from_mapping(
                value["adapterContinuation"]
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
            "adapterContinuation": self.adapter_continuation.to_wire(),
        }

    def require_request(
        self, request: IllustratorBootstrapRequest
    ) -> IllustratorBootstrapResult:
        if (
            self.host.host_version != request.host.host_version
            or self.host.profile_id != request.host.profile_id
            or self.host.executable_sha256 != request.host.executable_sha256
            or self.plugin.target != request.target
            or self.plugin.bridge_version != request.plugin.bridge_version
            or self.plugin.module_sha256 != request.plugin.module_sha256
            or self.continuation.timeout_ms != request.timeout_ms
        ):
            raise ValueError(
                "Illustrator bootstrap identity does not match the exact request"
            )
        return self

    def require_continuation(
        self, continuation: IllustratorBootstrapContinuation
    ) -> IllustratorBootstrapResult:
        if self.continuation != continuation:
            raise ValueError(
                "Illustrator bootstrap continuation does not match the exact receipt"
            )
        return self
