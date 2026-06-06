from __future__ import annotations

from typing import Any

from .capabilities import HostCapabilities, normalize_capability_sessions
from .client import BrokerClient
from .errors import CapabilityError


class HostSession:
    def __init__(self, host: str, client: BrokerClient | None = None) -> None:
        self.host = host
        self.client = client or BrokerClient()
        self.raw = RawNamespace(self)

    def capabilities(self) -> HostCapabilities | None:
        target = getattr(self.client, "target", "default")
        for capabilities in normalize_capability_sessions(self.client.capabilities()):
            if capabilities.host == self.host and capabilities.target == target:
                return capabilities
        return None

    def require_method(self, namespace: str, method: str) -> HostCapabilities:
        capabilities = self.capabilities()
        if capabilities is None:
            raise CapabilityError(
                f"no bridge capabilities are available for host '{self.host}' "
                f"target '{getattr(self.client, 'target', 'default')}'"
            )
        if not capabilities.supports_namespace(namespace):
            raise CapabilityError(
                f"host '{self.host}' bridge does not support namespace '{namespace}'",
                data={"host": self.host, "namespace": namespace, "target": capabilities.target},
            )
        if not capabilities.supports_method(namespace, method):
            raise CapabilityError(
                f"host '{self.host}' bridge does not support method '{namespace}.{method}'",
                data={"host": self.host, "namespace": namespace, "method": method, "target": capabilities.target},
            )
        return capabilities

    def invoke(
        self,
        namespace: str,
        method: str,
        *args: Any,
        options: dict[str, Any] | None = None,
        target: str | None = None,
    ) -> Any:
        return self.client.call(self.host, namespace, method, args=args, options=options, target=target)

    async def invoke_async(
        self,
        namespace: str,
        method: str,
        *args: Any,
        options: dict[str, Any] | None = None,
        target: str | None = None,
    ) -> Any:
        return await self.client.call_async(self.host, namespace, method, args=args, options=options, target=target)


class RawNamespace:
    def __init__(self, session: HostSession) -> None:
        self._session = session

    def eval_js(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self._session.invoke("raw", "evalJs", source, *args, options=_timeout_options(timeout_ms))

    def eval_extendscript(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self._session.invoke("raw", "evalExtendScript", source, *args, options=_timeout_options(timeout_ms))

    def eval_extend_script(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self.eval_extendscript(source, *args, timeout_ms=timeout_ms)

    def send_sdk_message(self, message: dict[str, Any], timeout_ms: int | None = None) -> Any:
        return self._session.invoke("raw", "sendSdkMessage", message, options=_timeout_options(timeout_ms))

    def batch_play(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._session.invoke("action", "batchPlay", descriptors, options or {}, options=_timeout_options(timeout_ms))


def connect(
    host: str,
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> HostSession:
    return HostSession(host, BrokerClient(broker_url=broker_url, token=token, target=target, timeout=timeout))


def _timeout_options(timeout_ms: int | None) -> dict[str, Any]:
    return {"timeoutMs": timeout_ms} if timeout_ms is not None else {}
