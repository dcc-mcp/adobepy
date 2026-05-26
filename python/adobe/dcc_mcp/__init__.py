from __future__ import annotations

import functools
from collections.abc import Mapping as MappingABC
from typing import Any, Callable, Dict, Optional, TypeVar

from adobe.core.errors import (
    AdobePythonError,
    BridgeNotInstalledError,
    BrokerConnectionError,
    CapabilityError,
    HostNotRunningError,
    HostScriptError,
    MethodNotFoundError,
    ModalRequiredError,
    PermissionError as AdobePermissionError,
    SerializationError,
    TimeoutError,
    UnauthorizedError,
)

ResultDict = Dict[str, Any]
_T = TypeVar("_T")
_F = TypeVar("_F", bound=Callable[..., ResultDict])


_RECOVERY_PROMPTS = {
    BrokerConnectionError: "Start the adobepy broker and verify ADOBEPY_BROKER_URL.",
    HostNotRunningError: "Start the Adobe host and reconnect the bridge plugin.",
    BridgeNotInstalledError: "Install or enable the matching adobepy UXP/CEP bridge.",
    TimeoutError: "Retry with a longer timeout or reduce the Adobe operation size.",
    UnauthorizedError: "Verify ADOBEPY_TOKEN matches the running broker session.",
    CapabilityError: "Check bridge capabilities before calling this Adobe API.",
    MethodNotFoundError: "Update the bridge or use a supported Adobe API method.",
    ModalRequiredError: "Run the mutating Adobe operation inside the host modal or command context.",
    AdobePermissionError: "Check host permissions and file-system access.",
    SerializationError: "Return JSON-serializable values from the bridge call.",
    HostScriptError: "Inspect the host script error and bridge diagnostics.",
}

_RETRYABLE_ERRORS = (
    BrokerConnectionError,
    HostNotRunningError,
    BridgeNotInstalledError,
    TimeoutError,
)


def adobe_success(message: str, *, prompt: Optional[str] = None, **context: Any) -> ResultDict:
    """Return a DCC MCP skill success result for an Adobe operation."""
    return _skill_success(message, prompt=prompt, **context)


def adobe_error(
    message: str,
    error: str | BaseException = "",
    *,
    prompt: Optional[str] = None,
    possible_solutions: Optional[list[str]] = None,
    **context: Any,
) -> ResultDict:
    """Return a DCC MCP skill error result with adobepy diagnostics."""
    if isinstance(error, BaseException):
        return adobe_exception(
            error,
            message=message,
            prompt=prompt,
            possible_solutions=possible_solutions,
            include_traceback=False,
            **context,
        )
    return _skill_error(
        message,
        error,
        prompt=prompt,
        possible_solutions=possible_solutions,
        **context,
    )


def adobe_exception(
    exc: BaseException,
    *,
    message: str = "Adobe operation failed",
    prompt: Optional[str] = None,
    possible_solutions: Optional[list[str]] = None,
    include_traceback: bool = True,
    **context: Any,
) -> ResultDict:
    """Return a DCC MCP skill error result from an adobepy exception."""
    diagnostics = adobe_error_context(exc)
    merged = dict(context)
    merged.setdefault("adobepy", diagnostics)
    return _skill_exception(
        exc,
        message=message,
        prompt=prompt,
        include_traceback=include_traceback,
        possible_solutions=possible_solutions or recovery_suggestions(exc),
        **merged,
    )


def adobe_error_context(exc: BaseException) -> dict[str, Any]:
    """Return stable metadata for mapping adobepy errors into DCC MCP results."""
    context: dict[str, Any] = {
        "error_type": type(exc).__name__,
        "retryable": isinstance(exc, _RETRYABLE_ERRORS),
    }
    if isinstance(exc, AdobePythonError):
        context["error_code"] = exc.code
        if exc.data is not None:
            context["data"] = exc.data
        if exc.diagnostics:
            context["diagnostics"] = exc.diagnostics
    return context


def recovery_suggestions(exc: BaseException) -> list[str]:
    """Return actionable recovery hints for known adobepy error classes."""
    for error_type, suggestion in _RECOVERY_PROMPTS.items():
        if isinstance(exc, error_type):
            return [suggestion]
    if isinstance(exc, AdobePythonError):
        return ["Check the adobepy broker and bridge diagnostics."]
    return ["Check the exception details and retry if the host state changed."]


def action_result(
    message: str,
    operation: Callable[[], _T],
    *,
    prompt: Optional[str] = None,
    failure_message: str = "Adobe operation failed",
    result_key: Optional[str] = "result",
    **context: Any,
) -> ResultDict:
    """Run an Adobe operation and convert the outcome to a DCC MCP result."""
    try:
        payload = operation()
    except AdobePythonError as exc:
        return adobe_exception(exc, message=failure_message, prompt=prompt, **context)

    result_context = dict(context)
    if isinstance(payload, MappingABC):
        result_context.update(payload)
    elif result_key is not None:
        result_context[result_key] = payload
    return adobe_success(message, prompt=prompt, **result_context)


def with_adobe(message: str = "Adobe operation failed") -> Callable[[_F], _F]:
    """Decorate a DCC MCP skill function and map adobepy errors consistently."""

    def decorator(func: _F) -> _F:
        @functools.wraps(func)
        def wrapper(*args: Any, **kwargs: Any) -> ResultDict:
            try:
                return func(*args, **kwargs)
            except AdobePythonError as exc:
                return adobe_exception(exc, message=message)

        return wrapper  # type: ignore[return-value]

    return decorator


def _skill_success(message: str, *, prompt: Optional[str] = None, **context: Any) -> ResultDict:
    try:
        from dcc_mcp_core.skill import skill_success  # type: ignore[import-not-found]  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        return {
            "success": True,
            "message": message,
            "prompt": prompt,
            "error": None,
            "context": context,
        }
    return skill_success(message, prompt=prompt, **context)


def _skill_error(
    message: str,
    error: str,
    *,
    prompt: Optional[str] = None,
    possible_solutions: Optional[list[str]] = None,
    **context: Any,
) -> ResultDict:
    try:
        from dcc_mcp_core.skill import skill_error  # type: ignore[import-not-found]  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        if possible_solutions:
            context.setdefault("possible_solutions", possible_solutions)
        return {
            "success": False,
            "message": message,
            "prompt": prompt or "Check the error details and try again.",
            "error": error,
            "context": context,
        }
    return skill_error(
        message,
        error,
        prompt=prompt,
        possible_solutions=possible_solutions,
        **context,
    )


def _skill_exception(
    exc: BaseException,
    *,
    message: Optional[str] = None,
    prompt: Optional[str] = None,
    include_traceback: bool = True,
    possible_solutions: Optional[list[str]] = None,
    **context: Any,
) -> ResultDict:
    try:
        from dcc_mcp_core.skill import skill_exception  # type: ignore[import-not-found]  # noqa: PLC0415
    except Exception:  # noqa: BLE001
        context["error_type"] = type(exc).__name__
        if possible_solutions:
            context.setdefault("possible_solutions", possible_solutions)
        return {
            "success": False,
            "message": message or f"Error: {exc}",
            "prompt": prompt or "Check the error details and try again.",
            "error": repr(exc),
            "context": context,
        }
    return skill_exception(
        exc,
        message=message,
        prompt=prompt,
        include_traceback=include_traceback,
        possible_solutions=possible_solutions,
        **context,
    )


__all__ = [
    "action_result",
    "adobe_error",
    "adobe_error_context",
    "adobe_exception",
    "adobe_success",
    "recovery_suggestions",
    "with_adobe",
]
