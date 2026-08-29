"""Bounded After Effects CEP bootstrap contract."""

from dataclasses import dataclass
from typing import Any

from .illustrator_bootstrap import (
    IllustratorAdapterContinuation,
    IllustratorBootstrapContinuation,
    IllustratorBootstrapRequest,
    IllustratorBootstrapResult,
    IllustratorBrokerBinding as AfterEffectsBrokerBinding,
    IllustratorHostBinding as AfterEffectsHostBinding,
    IllustratorHostTarget as AfterEffectsHostTarget,
    IllustratorPluginBinding as AfterEffectsPluginBinding,
    IllustratorPluginTarget as AfterEffectsPluginTarget,
)

AFTER_EFFECTS_BOOTSTRAP_VERSION = 1
AFTER_EFFECTS_VERIFY_PATH = "/v1/after-effects/bootstrap/verify"


@dataclass(frozen=True)
class AfterEffectsBootstrapContinuation(IllustratorBootstrapContinuation):
    @classmethod
    def from_mapping(cls, value: Any) -> "AfterEffectsBootstrapContinuation":
        if not isinstance(value, dict) or value.get("path") != AFTER_EFFECTS_VERIFY_PATH:
            raise ValueError("bootstrap continuation is not the fixed After Effects verification operation")
        normalized = dict(value)
        normalized["path"] = "/v1/illustrator/bootstrap/verify"
        parsed = IllustratorBootstrapContinuation.from_mapping(normalized)
        return cls(parsed.method, AFTER_EFFECTS_VERIFY_PATH, parsed.receipt_id, parsed.timeout_ms)

    def to_wire(self) -> dict[str, Any]:
        return {"method": "POST", "path": AFTER_EFFECTS_VERIFY_PATH, "receiptId": self.receipt_id, "timeoutMs": self.timeout_ms}


@dataclass(frozen=True)
class AfterEffectsAdapterContinuation(IllustratorAdapterContinuation):
    @classmethod
    def from_mapping(cls, value: Any) -> "AfterEffectsAdapterContinuation":
        if not isinstance(value, dict) or value.get("kind") != "command" or value.get("argv") != ["dcc-mcp-after-effects", "verify", "--json"]:
            raise ValueError("adapter continuation is not the fixed After Effects verify command")
        return cls("command", ("dcc-mcp-after-effects", "verify", "--json"))


@dataclass(frozen=True)
class AfterEffectsBootstrapResult(IllustratorBootstrapResult):
    @classmethod
    def from_broker(cls, value: Any) -> "AfterEffectsBootstrapResult":
        if not isinstance(value, dict):
            raise ValueError("After Effects bootstrap result is invalid")
        normalized = dict(value)
        continuation = dict(normalized.get("continuation") or {})
        continuation["path"] = "/v1/illustrator/bootstrap/verify"
        normalized["continuation"] = continuation
        adapter = dict(normalized.get("adapterContinuation") or {})
        adapter["argv"] = ["dcc-mcp-illustrator", "verify", "--json"]
        normalized["adapterContinuation"] = adapter
        parsed = IllustratorBootstrapResult.from_broker(normalized)
        return cls(parsed.bootstrap_version, parsed.status, parsed.identity_fingerprint, parsed.broker, parsed.host, parsed.plugin, AfterEffectsBootstrapContinuation.from_mapping({**continuation, "path": AFTER_EFFECTS_VERIFY_PATH}), AfterEffectsAdapterContinuation.from_mapping({"kind": "command", "argv": ["dcc-mcp-after-effects", "verify", "--json"]}))


# Request and target structures are identical, but host-specific aliases keep
# adapter type signatures explicit.
AfterEffectsBootstrapRequest = IllustratorBootstrapRequest
