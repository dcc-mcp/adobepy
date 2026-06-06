from __future__ import annotations

from typing import Any

from adobe.core import BrokerClient
from adobe.core.session import HostSession


class RawSession(HostSession):
    def __init__(self, host: str, client: BrokerClient | None = None) -> None:
        super().__init__(host, client)

    def eval_js(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self.raw.eval_js(source, *args, timeout_ms=timeout_ms)

    def evalJs(self, source: str, *args: Any, timeoutMs: int | None = None) -> Any:
        return self.eval_js(source, *args, timeout_ms=timeoutMs)

    async def eval_js_async(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return await self.invoke_async("raw", "evalJs", source, *args, options=_timeout_options(timeout_ms))

    def eval_extendscript(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self.raw.eval_extendscript(source, *args, timeout_ms=timeout_ms)

    def eval_extend_script(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self.eval_extendscript(source, *args, timeout_ms=timeout_ms)

    def evalExtendScript(self, source: str, *args: Any, timeoutMs: int | None = None) -> Any:
        return self.eval_extend_script(source, *args, timeout_ms=timeoutMs)

    async def eval_extendscript_async(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return await self.invoke_async("raw", "evalExtendScript", source, *args, options=_timeout_options(timeout_ms))

    async def eval_extend_script_async(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return await self.eval_extendscript_async(source, *args, timeout_ms=timeout_ms)

    def send_sdk_message(self, message: dict[str, Any], timeout_ms: int | None = None) -> Any:
        return self.raw.send_sdk_message(message, timeout_ms=timeout_ms)

    def sendSdkMessage(self, message: dict[str, Any], timeoutMs: int | None = None) -> Any:
        return self.send_sdk_message(message, timeout_ms=timeoutMs)

    async def send_sdk_message_async(self, message: dict[str, Any], timeout_ms: int | None = None) -> Any:
        return await self.invoke_async("raw", "sendSdkMessage", message, options=_timeout_options(timeout_ms))

    def batch_play(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self.raw.batch_play(descriptors, options, timeout_ms=timeout_ms)

    def batchPlay(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        timeoutMs: int | None = None,
    ) -> Any:
        return self.batch_play(descriptors, options, timeout_ms=timeoutMs)

    async def batch_play_async(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self.invoke_async("action", "batchPlay", descriptors, options or {}, options=_timeout_options(timeout_ms))


def connect(
    host: str,
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> RawSession:
    return RawSession(host, BrokerClient(broker_url=broker_url, token=token, target=target, timeout=timeout))


async def connect_async(
    host: str,
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> RawSession:
    return connect(host, broker_url=broker_url, token=token, target=target, timeout=timeout)


def eval_js(host: str, source: str, *args: Any, timeout_ms: int | None = None, **connect_kwargs: Any) -> Any:
    return connect(host, **connect_kwargs).eval_js(source, *args, timeout_ms=timeout_ms)


def eval_extendscript(
    host: str,
    source: str,
    *args: Any,
    timeout_ms: int | None = None,
    **connect_kwargs: Any,
) -> Any:
    return connect(host, **connect_kwargs).eval_extendscript(source, *args, timeout_ms=timeout_ms)


def eval_extend_script(
    host: str,
    source: str,
    *args: Any,
    timeout_ms: int | None = None,
    **connect_kwargs: Any,
) -> Any:
    return connect(host, **connect_kwargs).eval_extend_script(source, *args, timeout_ms=timeout_ms)


def send_sdk_message(host: str, message: dict[str, Any], timeout_ms: int | None = None, **connect_kwargs: Any) -> Any:
    return connect(host, **connect_kwargs).send_sdk_message(message, timeout_ms=timeout_ms)


def batch_play(
    host: str,
    descriptors: list[dict[str, Any]],
    options: dict[str, Any] | None = None,
    timeout_ms: int | None = None,
    **connect_kwargs: Any,
) -> Any:
    return connect(host, **connect_kwargs).batch_play(descriptors, options, timeout_ms=timeout_ms)


def _timeout_options(timeout_ms: int | None) -> dict[str, Any]:
    return {"timeoutMs": timeout_ms} if timeout_ms is not None else {}


__all__ = [
    "RawSession",
    "batch_play",
    "connect",
    "connect_async",
    "eval_extend_script",
    "eval_extendscript",
    "eval_js",
    "send_sdk_message",
]
