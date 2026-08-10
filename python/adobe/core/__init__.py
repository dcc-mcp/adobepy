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
    MethodNotFoundError,
    ModalRequiredError,
    PermissionError,
    SerializationError,
    TimeoutError,
    UnauthorizedError,
)
from .session import HostSession, connect

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
    "HostSession",
    "MethodNotFoundError",
    "ModalRequiredError",
    "PermissionError",
    "SerializationError",
    "TimeoutError",
    "UnauthorizedError",
    "connect",
    "normalize_capability_sessions",
]
