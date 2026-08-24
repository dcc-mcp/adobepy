from __future__ import annotations

from typing import Any


class AdobePythonError(RuntimeError):
    code: int | None = None

    def __init__(self, message: str, *, data: Any = None, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.data = data
        self.diagnostics = diagnostics or {}


class BrokerConnectionError(AdobePythonError):
    pass


class HostNotRunningError(AdobePythonError):
    code = -32001


class BridgeNotInstalledError(AdobePythonError):
    code = -32002


class CapabilityError(AdobePythonError):
    code = -32003


class HostScriptError(AdobePythonError):
    code = -32004


class PermissionError(AdobePythonError):
    code = -32005


class ModalRequiredError(AdobePythonError):
    code = -32006


class TimeoutError(AdobePythonError):
    code = -32007


class SerializationError(AdobePythonError):
    code = -32008


class UnauthorizedError(AdobePythonError):
    code = -32009


class IdentityUnavailableError(AdobePythonError):
    code = -32010


class IdentityStaleError(AdobePythonError):
    code = -32011


class IdentityAmbiguousError(AdobePythonError):
    code = -32012


class IdentityMismatchError(AdobePythonError):
    code = -32013


class MethodNotFoundError(AdobePythonError):
    code = -32601


ERROR_TYPES = {
    HostNotRunningError.code: HostNotRunningError,
    BridgeNotInstalledError.code: BridgeNotInstalledError,
    CapabilityError.code: CapabilityError,
    HostScriptError.code: HostScriptError,
    PermissionError.code: PermissionError,
    ModalRequiredError.code: ModalRequiredError,
    TimeoutError.code: TimeoutError,
    SerializationError.code: SerializationError,
    UnauthorizedError.code: UnauthorizedError,
    IdentityUnavailableError.code: IdentityUnavailableError,
    IdentityStaleError.code: IdentityStaleError,
    IdentityAmbiguousError.code: IdentityAmbiguousError,
    IdentityMismatchError.code: IdentityMismatchError,
    MethodNotFoundError.code: MethodNotFoundError,
}


def error_from_rpc(error: dict[str, Any], envelope: dict[str, Any] | None = None) -> AdobePythonError:
    error_type = ERROR_TYPES.get(error.get("code"), AdobePythonError)
    exc = error_type(
        error.get("message", "Adobe Python RPC error"),
        data=error.get("data"),
        diagnostics=(envelope or {}).get("diagnostics"),
    )
    exc.code = error.get("code")
    return exc
