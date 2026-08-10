from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from .session import HostSession

_DOM_REFERENCE_KEY = "$adobepyRef"
_DOM_TYPE_KEY = "$adobepyType"


class DomObject:
    """Opaque reference to an object owned by an Adobe host bridge."""

    def __init__(self, namespace: "DomNamespace", reference: str, type_name: str | None = None) -> None:
        self._namespace = namespace
        self.reference = reference
        self.type_name = type_name

    def get(self, member: str | int, *, timeout_ms: int | None = None) -> Any:
        return self._namespace.get(self, member, timeout_ms=timeout_ms)

    async def get_async(self, member: str | int, *, timeout_ms: int | None = None) -> Any:
        return await self._namespace.get_async(self, member, timeout_ms=timeout_ms)

    def set(
        self,
        member: str | int,
        value: Any,
        *,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._namespace.set(self, member, value, command_name=command_name, timeout_ms=timeout_ms)

    async def set_async(
        self,
        member: str | int,
        value: Any,
        *,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self._namespace.set_async(
            self,
            member,
            value,
            command_name=command_name,
            timeout_ms=timeout_ms,
        )

    def call(
        self,
        member: str | int,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._namespace.call(
            self,
            member,
            *args,
            command_name=command_name,
            mutating=mutating,
            timeout_ms=timeout_ms,
        )

    async def call_async(
        self,
        member: str | int,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self._namespace.call_async(
            self,
            member,
            *args,
            command_name=command_name,
            mutating=mutating,
            timeout_ms=timeout_ms,
        )

    def construct(
        self,
        member: str,
        *args: Any,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> "DomObject":
        return self._namespace.construct(
            self,
            member,
            *args,
            command_name=command_name,
            timeout_ms=timeout_ms,
        )

    async def construct_async(
        self,
        member: str,
        *args: Any,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> "DomObject":
        return await self._namespace.construct_async(
            self,
            member,
            *args,
            command_name=command_name,
            timeout_ms=timeout_ms,
        )

    def keys(self, *, timeout_ms: int | None = None) -> list[str]:
        return self._namespace.keys(self, timeout_ms=timeout_ms)

    async def keys_async(self, *, timeout_ms: int | None = None) -> list[str]:
        return await self._namespace.keys_async(self, timeout_ms=timeout_ms)

    def snapshot(self, *members: str | int, timeout_ms: int | None = None) -> dict[str, Any]:
        return self._namespace.snapshot(self, *members, timeout_ms=timeout_ms)

    async def snapshot_async(self, *members: str | int, timeout_ms: int | None = None) -> dict[str, Any]:
        return await self._namespace.snapshot_async(self, *members, timeout_ms=timeout_ms)

    def release(self, *, timeout_ms: int | None = None) -> bool:
        return self._namespace.release(self, timeout_ms=timeout_ms)

    async def release_async(self, *, timeout_ms: int | None = None) -> bool:
        return await self._namespace.release_async(self, timeout_ms=timeout_ms)

    def _wire_value(self) -> dict[str, str]:
        value = {_DOM_REFERENCE_KEY: self.reference}
        if self.type_name:
            value[_DOM_TYPE_KEY] = self.type_name
        return value

    def __repr__(self) -> str:
        suffix = f" type={self.type_name!r}" if self.type_name else ""
        return f"DomObject(reference={self.reference!r}{suffix})"


class DomNamespace:
    """Structured, non-eval access to a host's complete official object model."""

    def __init__(self, session: "HostSession") -> None:
        self._session = session

    def root(self, name: str = "app", *, timeout_ms: int | None = None) -> DomObject:
        result = self._invoke("root", name, timeout_ms=timeout_ms)
        return _require_dom_object(result, "dom.root")

    async def root_async(self, name: str = "app", *, timeout_ms: int | None = None) -> DomObject:
        result = await self._invoke_async("root", name, timeout_ms=timeout_ms)
        return _require_dom_object(result, "dom.root")

    def get(self, receiver: DomObject, member: str | int, *, timeout_ms: int | None = None) -> Any:
        return self._invoke("get", receiver, member, timeout_ms=timeout_ms)

    async def get_async(self, receiver: DomObject, member: str | int, *, timeout_ms: int | None = None) -> Any:
        return await self._invoke_async("get", receiver, member, timeout_ms=timeout_ms)

    def set(
        self,
        receiver: DomObject,
        member: str | int,
        value: Any,
        *,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._invoke(
            "set",
            receiver,
            member,
            value,
            command_name=command_name,
            mutating=True,
            timeout_ms=timeout_ms,
        )

    async def set_async(
        self,
        receiver: DomObject,
        member: str | int,
        value: Any,
        *,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self._invoke_async(
            "set",
            receiver,
            member,
            value,
            command_name=command_name,
            mutating=True,
            timeout_ms=timeout_ms,
        )

    def call(
        self,
        receiver: DomObject,
        member: str | int,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._invoke(
            "call",
            receiver,
            member,
            list(args),
            command_name=command_name,
            mutating=mutating,
            timeout_ms=timeout_ms,
        )

    async def call_async(
        self,
        receiver: DomObject,
        member: str | int,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        return await self._invoke_async(
            "call",
            receiver,
            member,
            list(args),
            command_name=command_name,
            mutating=mutating,
            timeout_ms=timeout_ms,
        )

    def construct(
        self,
        receiver: DomObject,
        member: str,
        *args: Any,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> DomObject:
        result = self._invoke(
            "construct",
            receiver,
            member,
            list(args),
            command_name=command_name,
            mutating=True,
            timeout_ms=timeout_ms,
        )
        return _require_dom_object(result, "dom.construct")

    async def construct_async(
        self,
        receiver: DomObject,
        member: str,
        *args: Any,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> DomObject:
        result = await self._invoke_async(
            "construct",
            receiver,
            member,
            list(args),
            command_name=command_name,
            mutating=True,
            timeout_ms=timeout_ms,
        )
        return _require_dom_object(result, "dom.construct")

    def keys(self, receiver: DomObject, *, timeout_ms: int | None = None) -> list[str]:
        result = self._invoke("keys", receiver, timeout_ms=timeout_ms)
        return [str(item) for item in result]

    async def keys_async(self, receiver: DomObject, *, timeout_ms: int | None = None) -> list[str]:
        result = await self._invoke_async("keys", receiver, timeout_ms=timeout_ms)
        return [str(item) for item in result]

    def snapshot(
        self,
        receiver: DomObject,
        *members: str | int,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        result = self._invoke("snapshot", receiver, list(members) if members else None, timeout_ms=timeout_ms)
        if not isinstance(result, dict):
            raise TypeError("dom.snapshot returned a non-object result")
        return result

    async def snapshot_async(
        self,
        receiver: DomObject,
        *members: str | int,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        result = await self._invoke_async(
            "snapshot",
            receiver,
            list(members) if members else None,
            timeout_ms=timeout_ms,
        )
        if not isinstance(result, dict):
            raise TypeError("dom.snapshot returned a non-object result")
        return result

    def release(self, receiver: DomObject, *, timeout_ms: int | None = None) -> bool:
        return bool(self._invoke("release", receiver, timeout_ms=timeout_ms))

    async def release_async(self, receiver: DomObject, *, timeout_ms: int | None = None) -> bool:
        return bool(await self._invoke_async("release", receiver, timeout_ms=timeout_ms))

    def _invoke(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        result = self._session.invoke(
            "dom",
            method,
            *(_encode_dom_value(arg, self) for arg in args),
            options=_dom_options(command_name, mutating, timeout_ms),
        )
        return self._decode(result)

    async def _invoke_async(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        mutating: bool = False,
        timeout_ms: int | None = None,
    ) -> Any:
        result = await self._session.invoke_async(
            "dom",
            method,
            *(_encode_dom_value(arg, self) for arg in args),
            options=_dom_options(command_name, mutating, timeout_ms),
        )
        return self._decode(result)

    def _decode(self, value: Any) -> Any:
        if isinstance(value, list):
            return [self._decode(item) for item in value]
        if isinstance(value, dict):
            reference = value.get(_DOM_REFERENCE_KEY)
            if isinstance(reference, str):
                type_name = value.get(_DOM_TYPE_KEY)
                return DomObject(self, reference, str(type_name) if type_name is not None else None)
            return {key: self._decode(item) for key, item in value.items()}
        return value


def _encode_dom_value(value: Any, namespace: DomNamespace) -> Any:
    if isinstance(value, DomObject):
        if value._namespace is not namespace:
            raise ValueError("DomObject belongs to a different host session")
        return value._wire_value()
    if isinstance(value, list):
        return [_encode_dom_value(item, namespace) for item in value]
    if isinstance(value, tuple):
        return [_encode_dom_value(item, namespace) for item in value]
    if isinstance(value, dict):
        return {key: _encode_dom_value(item, namespace) for key, item in value.items()}
    return value


def _dom_options(command_name: str | None, mutating: bool, timeout_ms: int | None) -> dict[str, Any]:
    options: dict[str, Any] = {}
    if timeout_ms is not None:
        options["timeoutMs"] = timeout_ms
    if command_name is not None:
        options["commandName"] = command_name
    if mutating:
        options["modal"] = True
    return options


def _require_dom_object(value: Any, operation: str) -> DomObject:
    if not isinstance(value, DomObject):
        raise TypeError(f"{operation} returned a non-reference result")
    return value
