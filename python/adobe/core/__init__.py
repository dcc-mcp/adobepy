from __future__ import annotations

from .capabilities import HostCapabilities, normalize_capability_sessions
from .client import BrokerClient
from .dom import DomNamespace, DomObject
from .errors import (
    AdobePythonError,
    BridgeNotInstalledError,
    BrokerConnectionError,
    CapabilityError,
    HostNotRunningError,
    HostScriptError,
    IdentityAmbiguousError,
    IdentityMismatchError,
    IdentityStaleError,
    IdentityUnavailableError,
    MethodNotFoundError,
    ModalRequiredError,
    PermissionError,
    SerializationError,
    TimeoutError,
    UnauthorizedError,
)
from .session import HostSession, connect
from .runtime_identity import (
    BridgeRuntimeIdentity,
    BrokerRuntimeIdentity,
    HostRuntimeIdentity,
    RuntimeIdentityAttestation,
)

__all__ = [
    "AdobePythonError",
    "BridgeNotInstalledError",
    "BrokerClient",
    "BrokerConnectionError",
    "CapabilityError",
    "DomNamespace",
    "DomObject",
    "HostCapabilities",
    "HostNotRunningError",
    "HostScriptError",
    "IdentityAmbiguousError",
    "IdentityMismatchError",
    "IdentityStaleError",
    "IdentityUnavailableError",
    "HostSession",
    "MethodNotFoundError",
    "ModalRequiredError",
    "PermissionError",
    "SerializationError",
    "TimeoutError",
    "UnauthorizedError",
    "BridgeRuntimeIdentity",
    "BrokerRuntimeIdentity",
    "HostRuntimeIdentity",
    "RuntimeIdentityAttestation",
    "connect",
    "normalize_capability_sessions",
]
