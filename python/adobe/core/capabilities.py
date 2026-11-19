from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping


@dataclass(frozen=True)
class HostCapabilities:
    target: str
    host: str
    bridge_kind: str
    bridge_version: str
    host_version: str | None
    namespaces: tuple[str, ...]
    features: tuple[str, ...]
    methods: Mapping[str, tuple[str, ...]]
    connection_id: int | None = None
    connected_at_epoch_ms: int | None = None

    @classmethod
    def from_broker_session(cls, payload: Mapping[str, Any]) -> "HostCapabilities":
        capabilities = payload.get("capabilities", {})
        methods = capabilities.get("methods", {})
        return cls(
            target=str(payload.get("target", "default")),
            host=str(capabilities.get("host", "")),
            bridge_kind=str(capabilities.get("bridgeKind", "")),
            bridge_version=str(capabilities.get("bridgeVersion", "")),
            host_version=capabilities.get("hostVersion"),
            namespaces=tuple(str(namespace) for namespace in capabilities.get("namespaces", ())),
            features=tuple(str(feature) for feature in capabilities.get("features", ())),
            methods={
                str(namespace): tuple(str(method) for method in namespace_methods)
                for namespace, namespace_methods in methods.items()
            },
            connection_id=payload.get("connectionId"),
            connected_at_epoch_ms=payload.get("connectedAtEpochMs"),
        )

    def supports_namespace(self, namespace: str) -> bool:
        return namespace in self.namespaces

    def supports_method(self, namespace: str, method: str) -> bool:
        return method in self.methods.get(namespace, ())

    def supports_feature(self, feature: str) -> bool:
        return feature in self.features


def normalize_capability_sessions(payloads: list[Mapping[str, Any]]) -> list[HostCapabilities]:
    return [HostCapabilities.from_broker_session(payload) for payload in payloads]
