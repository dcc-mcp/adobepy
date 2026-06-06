from __future__ import annotations

import asyncio
import functools
import itertools
import json
import os
import urllib.error
import urllib.request
from typing import Any, Iterable

from .errors import BrokerConnectionError, error_from_rpc

DEFAULT_BROKER_URL = "http://127.0.0.1:47391"


class BrokerClient:
    _ids = itertools.count(1)

    def __init__(
        self,
        broker_url: str | None = None,
        token: str | None = None,
        target: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.broker_url = (broker_url or os.getenv("ADOBEPY_BROKER_URL") or DEFAULT_BROKER_URL).rstrip("/")
        self.token = token if token is not None else os.getenv("ADOBEPY_TOKEN", "dev-token")
        self.target = target if target is not None else os.getenv("ADOBEPY_TARGET", "default")
        self.timeout = timeout

    def call(
        self,
        host: str,
        namespace: str,
        method: str,
        args: Iterable[Any] | None = None,
        options: dict[str, Any] | None = None,
        target: str | None = None,
    ) -> Any:
        request_id = f"py_{next(self._ids)}"
        payload = {
            "jsonrpc": "2.0",
            "id": request_id,
            "host": host,
            "target": target or self.target,
            "namespace": namespace,
            "method": method,
            "args": list(args or []),
            "options": options or {},
        }
        data = self._post_json("/v1/rpc", payload)
        if "error" in data:
            raise error_from_rpc(data["error"], data)
        return data.get("result")

    async def call_async(
        self,
        host: str,
        namespace: str,
        method: str,
        args: Iterable[Any] | None = None,
        options: dict[str, Any] | None = None,
        target: str | None = None,
    ) -> Any:
        return await _to_thread(self.call, host, namespace, method, args, options, target)

    def capabilities(self) -> list[dict[str, Any]]:
        return self._get_json("/v1/capabilities")

    async def capabilities_async(self) -> list[dict[str, Any]]:
        return await _to_thread(self.capabilities)

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.token:
            headers["x-adobepy-token"] = self.token
        return headers

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        request = urllib.request.Request(f"{self.broker_url}{path}", data=body, headers=self._headers(), method="POST")
        return self._open_json(request)

    def _get_json(self, path: str) -> Any:
        request = urllib.request.Request(f"{self.broker_url}{path}", headers=self._headers(), method="GET")
        return self._open_json(request)

    def _open_json(self, request: urllib.request.Request) -> Any:
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")
            raise BrokerConnectionError(f"broker returned HTTP {error.code}: {detail}") from error
        except urllib.error.URLError as error:
            raise BrokerConnectionError(f"could not connect to broker at {self.broker_url}: {error}") from error
        except json.JSONDecodeError as error:
            raise BrokerConnectionError(f"broker returned invalid JSON: {error}") from error


async def _to_thread(func: Any, /, *args: Any, **kwargs: Any) -> Any:
    if hasattr(asyncio, "to_thread"):
        return await asyncio.to_thread(func, *args, **kwargs)
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(None, functools.partial(func, *args, **kwargs))
