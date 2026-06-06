from __future__ import annotations

from contextlib import contextmanager
from dataclasses import dataclass
from typing import Any, Iterator

from adobe.core import BrokerClient
from adobe.core.session import HostSession


class PhotoshopSession(HostSession):
    def __init__(self, client: BrokerClient | None = None) -> None:
        super().__init__("photoshop", client)
        self.app = PhotoshopApp(self)
        self.action = PhotoshopAction(self)
        self.dom = PhotoshopDomProxy(self, [])
        self._modal_stack: list[str] = []

    @contextmanager
    def modal(self, command_name: str) -> Iterator[None]:
        self._modal_stack.append(command_name)
        try:
            yield
        finally:
            self._modal_stack.pop()

    def modal_options(
        self,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        default_command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        active_command = command_name or (self._modal_stack[-1] if self._modal_stack else None) or default_command_name
        should_modal = modal if modal is not None else active_command is not None
        options: dict[str, Any] = {"modal": should_modal}
        if active_command:
            options["commandName"] = active_command
        if timeout_ms is not None:
            options["timeoutMs"] = timeout_ms
        return options


class Photoshop(PhotoshopSession):
    def __init__(
        self,
        *,
        broker_url: str | None = None,
        token: str | None = None,
        target: str | None = None,
        timeout: float = 30.0,
        client: BrokerClient | None = None,
    ) -> None:
        super().__init__(client or BrokerClient(broker_url=broker_url, token=token, target=target, timeout=timeout))

    @property
    def version(self) -> str:
        return self.app.version

    @property
    def documents(self) -> list["DocumentProxy"]:
        return self.app.documents

    @property
    def activeDocument(self) -> "DocumentProxy | None":
        return self.app.activeDocument

    @property
    def active_document(self) -> "DocumentProxy | None":
        return self.app.active_document

    @property
    def activeLayer(self) -> "LayerProxy | None":
        return self.app.activeLayer

    @property
    def active_layer(self) -> "LayerProxy | None":
        return self.app.active_layer

    @property
    def activeLayers(self) -> list["LayerProxy"]:
        return self.app.activeLayers

    @property
    def active_layers(self) -> list["LayerProxy"]:
        return self.app.active_layers

    @property
    def selection(self) -> "SelectionProxy | None":
        return self.app.selection

    @property
    def channels(self) -> list["ChannelProxy"]:
        return self.app.channels

    @property
    def active_text(self) -> "TextItemProxy | None":
        return self.app.active_text

    @property
    def activeText(self) -> "TextItemProxy | None":
        return self.active_text

    @property
    def export_presets(self) -> list["ExportPreset"]:
        return self.app.export_presets

    @property
    def exportPresets(self) -> list["ExportPreset"]:
        return self.export_presets

    def eval_js(self, source: str, *args: Any, timeout_ms: int | None = None) -> Any:
        return self.invoke("raw", "evalJs", source, *args, options=_timeout_options(timeout_ms))

    def evalJs(self, source: str, *args: Any, timeoutMs: int | None = None) -> Any:
        return self.eval_js(source, *args, timeout_ms=timeoutMs)

    def batchPlay(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        *,
        modal: bool | None = None,
        commandName: str | None = None,
        command_name: str | None = None,
        timeoutMs: int | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self.action.batchPlay(
            descriptors,
            options,
            modal=modal,
            commandName=commandName,
            command_name=command_name,
            timeoutMs=timeoutMs,
            timeout_ms=timeout_ms,
        )

    def batch_play(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self.action.batch_play(
            descriptors,
            options,
            modal=modal,
            command_name=command_name,
            timeout_ms=timeout_ms,
        )

    def executeAsModal(
        self,
        callback: Any | None = None,
        *,
        commandName: str | None = None,
        command_name: str | None = None,
    ) -> Any:
        command = commandName or command_name or "Adobe Python command"
        context = self.modal(command)
        if callback is None:
            return context
        with context:
            return callback()

    def execute_as_modal(
        self,
        callback: Any | None = None,
        *,
        command_name: str | None = None,
    ) -> Any:
        return self.executeAsModal(callback, command_name=command_name)


class PhotoshopApp:
    def __init__(self, session: PhotoshopSession) -> None:
        self._session = session

    @property
    def version(self) -> str:
        return str(self._session.invoke("app", "getVersion"))

    @property
    def documents(self) -> list["DocumentProxy"]:
        payload = self._session.invoke("app", "getDocuments")
        return [DocumentProxy(self._session, document) for document in payload or []]

    @property
    def active_document(self) -> "DocumentProxy | None":
        payload = self._session.invoke("document", "getActive")
        return DocumentProxy(self._session, payload) if payload else None

    @property
    def activeDocument(self) -> "DocumentProxy | None":
        return self.active_document

    @property
    def active_layer(self) -> "LayerProxy | None":
        payload = self._session.invoke("layer", "getActive")
        return LayerProxy(self._session, payload) if payload else None

    @property
    def activeLayer(self) -> "LayerProxy | None":
        return self.active_layer

    @property
    def active_layers(self) -> list["LayerProxy"]:
        document = self.active_document
        return document.active_layers if document else []

    @property
    def activeLayers(self) -> list["LayerProxy"]:
        return self.active_layers

    @property
    def selection(self) -> "SelectionProxy | None":
        document = self.active_document
        return document.selection if document else None

    @property
    def channels(self) -> list["ChannelProxy"]:
        document = self.active_document
        return document.channels if document else []

    @property
    def active_text(self) -> "TextItemProxy | None":
        payload = self._session.invoke("text", "getActive")
        return TextItemProxy(self._session, payload.get("layerId"), payload) if payload else None

    @property
    def activeText(self) -> "TextItemProxy | None":
        return self.active_text

    @property
    def export_presets(self) -> list["ExportPreset"]:
        payload = self._session.invoke("export", "getPresets")
        return [ExportPreset.from_payload(preset) for preset in payload or []]

    @property
    def exportPresets(self) -> list["ExportPreset"]:
        return self.export_presets


class PhotoshopAction:
    def __init__(self, session: PhotoshopSession) -> None:
        self._session = session

    def batch_play(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        default_command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._session.invoke(
            "action",
            "batchPlay",
            descriptors,
            options or {},
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name=default_command_name,
                timeout_ms=timeout_ms,
            ),
        )

    def batchPlay(
        self,
        descriptors: list[dict[str, Any]],
        options: dict[str, Any] | None = None,
        *,
        modal: bool | None = None,
        commandName: str | None = None,
        command_name: str | None = None,
        timeoutMs: int | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self.batch_play(
            descriptors,
            options,
            modal=modal,
            command_name=commandName or command_name,
            timeout_ms=timeoutMs if timeoutMs is not None else timeout_ms,
        )


class PhotoshopDomProxy:
    def __init__(self, session: PhotoshopSession, path: list[str | int]) -> None:
        self._session = session
        self._path = path

    def __repr__(self) -> str:
        return f"PhotoshopDomProxy({'.'.join(str(item) for item in self._path) or 'photoshop'})"

    def __getattr__(self, name: str) -> "PhotoshopDomProxy":
        if name.startswith("_"):
            raise AttributeError(name)
        return PhotoshopDomProxy(self._session, [*self._path, name])

    def __getitem__(self, key: int | str) -> "PhotoshopDomProxy":
        return PhotoshopDomProxy(self._session, [*self._path, key])

    def get(self, *, depth: int = 2, timeout_ms: int | None = None) -> Any:
        return self._session.invoke(
            "raw",
            "getPath",
            self._path,
            depth,
            options=_timeout_options(timeout_ms),
        )

    def call(
        self,
        *args: Any,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
        depth: int = 2,
    ) -> Any:
        return self._session.invoke(
            "raw",
            "callPath",
            self._path,
            list(args),
            depth,
            options=self._session.modal_options(modal=modal, command_name=command_name, timeout_ms=timeout_ms),
        )

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        return self.call(*args, **kwargs)


class ExportPreset:
    def __init__(
        self,
        name: str,
        format: str,
        *,
        as_copy: bool = True,
        options: dict[str, Any] | None = None,
        description: str | None = None,
    ) -> None:
        self._name = name
        self._format = format
        self._as_copy = as_copy
        self._options = dict(options or {})
        self._description = description

    @classmethod
    def from_payload(cls, payload: dict[str, Any]) -> "ExportPreset":
        options = payload.get("options")
        return cls(
            name=str(payload.get("name") or ""),
            format=str(payload.get("format") or payload.get("name") or ""),
            as_copy=bool(payload.get("asCopy", True)),
            options=dict(options) if isinstance(options, dict) else {},
            description=str(payload.get("description")) if payload.get("description") is not None else None,
        )

    @property
    def name(self) -> str:
        return self._name

    @property
    def format(self) -> str:
        return self._format

    @property
    def as_copy(self) -> bool:
        return self._as_copy

    @property
    def asCopy(self) -> bool:
        return self.as_copy

    @property
    def options(self) -> dict[str, Any]:
        return dict(self._options)

    @property
    def description(self) -> str | None:
        return self._description


@dataclass
class DocumentProxy:
    _session: PhotoshopSession
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def path(self) -> str | None:
        return self._payload.get("path")

    @property
    def width(self) -> Any:
        return self._payload.get("width")

    @property
    def height(self) -> Any:
        return self._payload.get("height")

    @property
    def resolution(self) -> Any:
        return self._payload.get("resolution")

    @property
    def saved(self) -> bool | None:
        return self._payload.get("saved")

    @property
    def mode(self) -> str | None:
        return self._payload.get("mode")

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    @property
    def layers(self) -> list["LayerProxy"]:
        payload = self._session.invoke("document", "getLayers", self.id)
        return [LayerProxy(self._session, layer) for layer in payload or []]

    @property
    def active_layers(self) -> list["LayerProxy"]:
        payload = self._session.invoke("document", "getActiveLayers", self.id)
        return [LayerProxy(self._session, layer) for layer in payload or []]

    @property
    def activeLayers(self) -> list["LayerProxy"]:
        return self.active_layers

    @property
    def selection(self) -> "SelectionProxy":
        return SelectionProxy(self._session, self.id)

    @property
    def channels(self) -> list["ChannelProxy"]:
        payload = self._session.invoke("channel", "getChannels", self.id)
        return [ChannelProxy(self._session, self.id, channel) for channel in payload or []]

    @property
    def active_channels(self) -> list["ChannelProxy"]:
        payload = self._session.invoke("channel", "getActiveChannels", self.id)
        return [ChannelProxy(self._session, self.id, channel) for channel in payload or []]

    @property
    def activeChannels(self) -> list["ChannelProxy"]:
        return self.active_channels

    @property
    def component_channels(self) -> list["ChannelProxy"]:
        payload = self._session.invoke("channel", "getComponentChannels", self.id)
        return [ChannelProxy(self._session, self.id, channel) for channel in payload or []]

    @property
    def componentChannels(self) -> list["ChannelProxy"]:
        return self.component_channels

    def get_channel(self, name: str) -> "ChannelProxy | None":
        payload = self._session.invoke("channel", "getByName", self.id, name)
        return ChannelProxy(self._session, self.id, payload) if payload else None

    def getChannel(self, name: str) -> "ChannelProxy | None":
        return self.get_channel(name)

    @property
    def dom(self) -> PhotoshopDomProxy:
        return PhotoshopDomProxy(self._session, ["app", "activeDocument"])

    @property
    def exports(self) -> "DocumentExportProxy":
        return DocumentExportProxy(self)

    def refresh(self) -> "DocumentProxy":
        payload = self._session.invoke("document", "getById", self.id)
        self._payload = payload or {}
        return self

    def save_as(
        self,
        path: str,
        *,
        format: str = "psd",
        options: dict[str, Any] | None = None,
        as_copy: bool = False,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._session.invoke(
            "document",
            "saveAs",
            {"id": self.id, "path": path, "format": format, "options": options or {}, "asCopy": as_copy},
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name="Save document",
                timeout_ms=timeout_ms,
            ),
        )

    def saveAs(
        self,
        path: str,
        *,
        format: str = "psd",
        options: dict[str, Any] | None = None,
        asCopy: bool = False,
        modal: bool | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> Any:
        return self.save_as(path, format=format, options=options, as_copy=asCopy, modal=modal, command_name=commandName, timeout_ms=timeoutMs)

    def export(
        self,
        path: str,
        *,
        format: str = "png",
        options: dict[str, Any] | None = None,
        as_copy: bool = True,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._session.invoke(
            "document",
            "export",
            {"id": self.id, "path": path, "format": format, "options": options or {}, "asCopy": as_copy},
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name="Export document",
                timeout_ms=timeout_ms,
            ),
        )

    def export_with_preset(
        self,
        preset: str | ExportPreset,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        preset_name = preset.name if isinstance(preset, ExportPreset) else preset
        return self._session.invoke(
            "export",
            "exportWithPreset",
            {"id": self.id, "path": path, "preset": preset_name, "options": options or {}},
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name="Export document",
                timeout_ms=timeout_ms,
            ),
        )

    def exportWithPreset(
        self,
        preset: str | ExportPreset,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        modal: bool | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> Any:
        return self.export_with_preset(preset, path, options=options, modal=modal, command_name=commandName, timeout_ms=timeoutMs)


class DocumentExportProxy:
    def __init__(self, document: DocumentProxy) -> None:
        self._document = document

    @property
    def presets(self) -> list[ExportPreset]:
        payload = self._document._session.invoke("export", "getPresets")
        return [ExportPreset.from_payload(preset) for preset in payload or []]

    def with_preset(
        self,
        preset: str | ExportPreset,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._document.export_with_preset(preset, path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def withPreset(
        self,
        preset: str | ExportPreset,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> Any:
        return self.with_preset(preset, path, options=options, command_name=commandName, timeout_ms=timeoutMs)

    def png(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.with_preset("png", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def png_small(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.with_preset("png_small", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def jpg_high(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.with_preset("jpg_high", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def jpg_medium(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.with_preset("jpg_medium", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def psd_copy(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.with_preset("psd_copy", path, options=options, command_name=command_name, timeout_ms=timeout_ms)


class SelectionProxy:
    def __init__(self, session: PhotoshopSession, document_id: int | str | None) -> None:
        self._session = session
        self._document_id = document_id
        self._payload: dict[str, Any] = {}
        self.refresh()

    @property
    def bounds(self) -> dict[str, Any] | None:
        value = self._payload.get("bounds")
        return value if isinstance(value, dict) else None

    @property
    def doc_id(self) -> int | str | None:
        return self._payload.get("docId")

    @property
    def docId(self) -> int | str | None:
        return self.doc_id

    @property
    def solid(self) -> bool | None:
        value = self._payload.get("solid")
        return bool(value) if value is not None else None

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    def refresh(self) -> "SelectionProxy":
        self._payload = self._session.invoke("selection", "get", self._document_id) or {}
        return self

    def select_all(self, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("selectAll", command_name=command_name, default_command_name="Select all")

    def selectAll(self, *, commandName: str | None = None) -> "SelectionProxy":
        return self.select_all(command_name=commandName)

    def deselect(self, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("deselect", command_name=command_name, default_command_name="Deselect")

    def inverse(self, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("inverse", command_name=command_name, default_command_name="Invert selection")

    def select_rectangle(
        self,
        bounds: dict[str, Any],
        mode: str | None = None,
        feather: float | int = 0,
        anti_alias: bool = True,
        *,
        command_name: str | None = None,
    ) -> "SelectionProxy":
        return self._invoke(
            "selectRectangle",
            bounds,
            mode,
            feather,
            anti_alias,
            command_name=command_name,
            default_command_name="Select rectangle",
        )

    def selectRectangle(
        self,
        bounds: dict[str, Any],
        mode: str | None = None,
        feather: float | int = 0,
        antiAlias: bool = True,
        *,
        commandName: str | None = None,
    ) -> "SelectionProxy":
        return self.select_rectangle(bounds, mode, feather, antiAlias, command_name=commandName)

    def select_ellipse(
        self,
        bounds: dict[str, Any],
        mode: str | None = None,
        feather: float | int = 0,
        anti_alias: bool = True,
        *,
        command_name: str | None = None,
    ) -> "SelectionProxy":
        return self._invoke(
            "selectEllipse",
            bounds,
            mode,
            feather,
            anti_alias,
            command_name=command_name,
            default_command_name="Select ellipse",
        )

    def selectEllipse(
        self,
        bounds: dict[str, Any],
        mode: str | None = None,
        feather: float | int = 0,
        antiAlias: bool = True,
        *,
        commandName: str | None = None,
    ) -> "SelectionProxy":
        return self.select_ellipse(bounds, mode, feather, antiAlias, command_name=commandName)

    def select_polygon(
        self,
        points: list[dict[str, Any]],
        mode: str | None = None,
        feather: float | int = 0,
        anti_alias: bool = True,
        *,
        command_name: str | None = None,
    ) -> "SelectionProxy":
        return self._invoke(
            "selectPolygon",
            points,
            mode,
            feather,
            anti_alias,
            command_name=command_name,
            default_command_name="Select polygon",
        )

    def selectPolygon(
        self,
        points: list[dict[str, Any]],
        mode: str | None = None,
        feather: float | int = 0,
        antiAlias: bool = True,
        *,
        commandName: str | None = None,
    ) -> "SelectionProxy":
        return self.select_polygon(points, mode, feather, antiAlias, command_name=commandName)

    def select_row(self, y: int | float, mode: str | None = None, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("selectRow", y, mode, command_name=command_name, default_command_name="Select row")

    def selectRow(self, y: int | float, mode: str | None = None, *, commandName: str | None = None) -> "SelectionProxy":
        return self.select_row(y, mode, command_name=commandName)

    def select_column(self, x: int | float, mode: str | None = None, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("selectColumn", x, mode, command_name=command_name, default_command_name="Select column")

    def selectColumn(self, x: int | float, mode: str | None = None, *, commandName: str | None = None) -> "SelectionProxy":
        return self.select_column(x, mode, command_name=commandName)

    def expand(self, by: int | float, apply_effect_at_canvas_bounds: bool = False, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("expand", by, apply_effect_at_canvas_bounds, command_name=command_name, default_command_name="Expand selection")

    def contract(self, by: int | float, apply_effect_at_canvas_bounds: bool = False, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("contract", by, apply_effect_at_canvas_bounds, command_name=command_name, default_command_name="Contract selection")

    def feather(self, by: int | float, apply_effect_at_canvas_bounds: bool = False, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("feather", by, apply_effect_at_canvas_bounds, command_name=command_name, default_command_name="Feather selection")

    def smooth(self, radius: int | float, apply_effect_at_canvas_bounds: bool = False, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("smooth", radius, apply_effect_at_canvas_bounds, command_name=command_name, default_command_name="Smooth selection")

    def grow(self, tolerance: int | float, anti_alias: bool = True, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("grow", tolerance, anti_alias, command_name=command_name, default_command_name="Grow selection")

    def translate_boundary(self, delta_x: int | float, delta_y: int | float, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("translateBoundary", delta_x, delta_y, command_name=command_name, default_command_name="Translate selection boundary")

    def translateBoundary(self, deltaX: int | float, deltaY: int | float, *, commandName: str | None = None) -> "SelectionProxy":
        return self.translate_boundary(deltaX, deltaY, command_name=commandName)

    def save(self, channel_name: str | None = None, *, command_name: str | None = None) -> "SelectionProxy":
        return self._invoke("save", channel_name, command_name=command_name, default_command_name="Save selection")

    def _invoke(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        default_command_name: str,
    ) -> "SelectionProxy":
        payload = self._session.invoke(
            "selection",
            method,
            self._document_id,
            *args,
            options=self._session.modal_options(command_name=command_name, default_command_name=default_command_name),
        )
        self._payload = payload or {}
        return self


@dataclass
class ChannelProxy:
    _session: PhotoshopSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def kind(self) -> str | None:
        return self._payload.get("kind")

    @property
    def opacity(self) -> Any:
        return self._payload.get("opacity")

    @property
    def visible(self) -> bool | None:
        value = self._payload.get("visible")
        return bool(value) if value is not None else None

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    def remove(self, *, command_name: str | None = None) -> "ChannelProxy":
        payload = self._session.invoke(
            "channel",
            "remove",
            self._document_id,
            self.id or self.name,
            options=self._session.modal_options(command_name=command_name, default_command_name="Remove channel"),
        )
        self._payload = payload or {}
        return self


@dataclass
class TextItemProxy:
    _session: PhotoshopSession
    _layer_id: int | str | None
    _payload: dict[str, Any]

    @property
    def layer_id(self) -> int | str | None:
        return self._payload.get("layerId", self._layer_id)

    @property
    def layerId(self) -> int | str | None:
        return self.layer_id

    @property
    def contents(self) -> str | None:
        return self._payload.get("contents")

    @property
    def is_paragraph_text(self) -> bool | None:
        value = self._payload.get("isParagraphText")
        return bool(value) if value is not None else None

    @property
    def isParagraphText(self) -> bool | None:
        return self.is_paragraph_text

    @property
    def is_point_text(self) -> bool | None:
        value = self._payload.get("isPointText")
        return bool(value) if value is not None else None

    @property
    def isPointText(self) -> bool | None:
        return self.is_point_text

    @property
    def orientation(self) -> str | None:
        value = self._payload.get("orientation")
        return str(value) if value is not None else None

    @property
    def text_click_point(self) -> dict[str, Any] | None:
        value = self._payload.get("textClickPoint")
        return value if isinstance(value, dict) else None

    @property
    def textClickPoint(self) -> dict[str, Any] | None:
        return self.text_click_point

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    @property
    def character_style(self) -> "CharacterStyleProxy":
        return CharacterStyleProxy(self)

    @property
    def characterStyle(self) -> "CharacterStyleProxy":
        return self.character_style

    @property
    def paragraph_style(self) -> "ParagraphStyleProxy":
        return ParagraphStyleProxy(self)

    @property
    def paragraphStyle(self) -> "ParagraphStyleProxy":
        return self.paragraph_style

    def refresh(self) -> "TextItemProxy":
        payload = self._session.invoke("text", "getByLayerId", self.layer_id)
        self._payload = payload or {}
        self._layer_id = self.layer_id
        return self

    def set_contents(self, contents: str, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("setContents", contents, command_name=command_name, default_command_name="Set text contents")

    def setContents(self, contents: str, *, commandName: str | None = None) -> "TextItemProxy":
        return self.set_contents(contents, command_name=commandName)

    def set_character_style(self, properties: dict[str, Any], *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("setCharacterStyle", properties, command_name=command_name, default_command_name="Set character style")

    def setCharacterStyle(self, properties: dict[str, Any], *, commandName: str | None = None) -> "TextItemProxy":
        return self.set_character_style(properties, command_name=commandName)

    def set_paragraph_style(self, properties: dict[str, Any], *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("setParagraphStyle", properties, command_name=command_name, default_command_name="Set paragraph style")

    def setParagraphStyle(self, properties: dict[str, Any], *, commandName: str | None = None) -> "TextItemProxy":
        return self.set_paragraph_style(properties, command_name=commandName)

    def set_text_click_point(self, point: dict[str, Any], *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("setTextClickPoint", point, command_name=command_name, default_command_name="Set text click point")

    def setTextClickPoint(self, point: dict[str, Any], *, commandName: str | None = None) -> "TextItemProxy":
        return self.set_text_click_point(point, command_name=commandName)

    def set_orientation(self, orientation: str, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("setOrientation", orientation, command_name=command_name, default_command_name="Set text orientation")

    def setOrientation(self, orientation: str, *, commandName: str | None = None) -> "TextItemProxy":
        return self.set_orientation(orientation, command_name=commandName)

    def convert_to_paragraph_text(self, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("convertToParagraphText", command_name=command_name, default_command_name="Convert to paragraph text")

    def convertToParagraphText(self, *, commandName: str | None = None) -> "TextItemProxy":
        return self.convert_to_paragraph_text(command_name=commandName)

    def convert_to_point_text(self, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("convertToPointText", command_name=command_name, default_command_name="Convert to point text")

    def convertToPointText(self, *, commandName: str | None = None) -> "TextItemProxy":
        return self.convert_to_point_text(command_name=commandName)

    def convert_to_shape(self, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("convertToShape", command_name=command_name, default_command_name="Convert text to shape")

    def convertToShape(self, *, commandName: str | None = None) -> "TextItemProxy":
        return self.convert_to_shape(command_name=commandName)

    def create_work_path(self, *, command_name: str | None = None) -> "TextItemProxy":
        return self._invoke("createWorkPath", command_name=command_name, default_command_name="Create text work path")

    def createWorkPath(self, *, commandName: str | None = None) -> "TextItemProxy":
        return self.create_work_path(command_name=commandName)

    def _invoke(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        default_command_name: str,
    ) -> "TextItemProxy":
        payload = self._session.invoke(
            "text",
            method,
            self.layer_id,
            *args,
            options=self._session.modal_options(command_name=command_name, default_command_name=default_command_name),
        )
        self._payload = payload or {}
        self._layer_id = self.layer_id
        return self


class _TextStyleProxy:
    def __init__(self, text_item: TextItemProxy, payload_key: str) -> None:
        self._text_item = text_item
        self._payload_key = payload_key

    @property
    def _payload(self) -> dict[str, Any]:
        value = self._text_item._payload.get(self._payload_key)
        return value if isinstance(value, dict) else {}

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._payload:
            return self._payload[name]
        raise AttributeError(name)


class CharacterStyleProxy(_TextStyleProxy):
    def __init__(self, text_item: TextItemProxy) -> None:
        super().__init__(text_item, "characterStyle")

    def update(self, properties: dict[str, Any] | None = None, *, command_name: str | None = None, **kwargs: Any) -> TextItemProxy:
        merged = dict(properties or {})
        merged.update(kwargs)
        return self._text_item.set_character_style(merged, command_name=command_name)

    def reset(self, *, command_name: str | None = None) -> TextItemProxy:
        return self._text_item._invoke("resetCharacterStyle", command_name=command_name, default_command_name="Reset character style")


class ParagraphStyleProxy(_TextStyleProxy):
    def __init__(self, text_item: TextItemProxy) -> None:
        super().__init__(text_item, "paragraphStyle")

    def update(self, properties: dict[str, Any] | None = None, *, command_name: str | None = None, **kwargs: Any) -> TextItemProxy:
        merged = dict(properties or {})
        merged.update(kwargs)
        return self._text_item.set_paragraph_style(merged, command_name=command_name)


@dataclass
class LayerProxy:
    _session: PhotoshopSession
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def kind(self) -> str | None:
        return self._payload.get("kind")

    @property
    def opacity(self) -> Any:
        return self._payload.get("opacity")

    @property
    def visible(self) -> bool | None:
        return self._payload.get("visible")

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    @property
    def has_children(self) -> bool:
        return bool(self._payload.get("hasChildren"))

    @property
    def hasChildren(self) -> bool:
        return self.has_children

    @property
    def is_smart_object(self) -> bool:
        return bool(self._payload.get("isSmartObject"))

    @property
    def isSmartObject(self) -> bool:
        return self.is_smart_object

    @property
    def layers(self) -> list["LayerProxy"]:
        payload = self._session.invoke("layer", "getChildren", self.id)
        return [LayerProxy(self._session, layer) for layer in payload or []]

    @property
    def filters(self) -> "LayerFilterProxy":
        return LayerFilterProxy(self)

    @property
    def smart_object(self) -> "SmartObjectProxy":
        return SmartObjectProxy(self)

    @property
    def smartObject(self) -> "SmartObjectProxy":
        return self.smart_object

    @property
    def text_item(self) -> "TextItemProxy | None":
        payload = self._session.invoke("text", "getByLayerId", self.id)
        return TextItemProxy(self._session, payload.get("layerId"), payload) if payload else None

    @property
    def textItem(self) -> "TextItemProxy | None":
        return self.text_item

    def hide(self, *, command_name: str | None = None) -> Any:
        return self._session.action.batch_play(
            [{"_obj": "hide", "_target": [{"_ref": "layer", "_id": self.id}]}],
            modal=True,
            command_name=command_name,
            default_command_name="Hide layer",
        )

    def _replace_payload(self, payload: dict[str, Any] | None) -> "LayerProxy":
        self._payload = payload or {}
        return self


class LayerFilterProxy:
    def __init__(self, layer: LayerProxy) -> None:
        self._layer = layer

    def apply(self, method: str, *args: Any, command_name: str | None = None) -> LayerProxy:
        payload = self._layer._session.invoke(
            "filter",
            "apply",
            self._layer.id,
            method,
            *args,
            options=self._layer._session.modal_options(command_name=command_name, default_command_name=f"Apply {method}"),
        )
        return self._layer._replace_payload(payload)

    def apply_gaussian_blur(self, radius: int | float, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("applyGaussianBlur", radius, command_name=command_name, default_command_name="Apply Gaussian blur")

    def applyGaussianBlur(self, radius: int | float, *, commandName: str | None = None) -> LayerProxy:
        return self.apply_gaussian_blur(radius, command_name=commandName)

    def apply_high_pass(self, radius: int | float, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("applyHighPass", radius, command_name=command_name, default_command_name="Apply high pass")

    def applyHighPass(self, radius: int | float, *, commandName: str | None = None) -> LayerProxy:
        return self.apply_high_pass(radius, command_name=commandName)

    def apply_sharpen(self, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("applySharpen", command_name=command_name, default_command_name="Apply sharpen")

    def applySharpen(self, *, commandName: str | None = None) -> LayerProxy:
        return self.apply_sharpen(command_name=commandName)

    def apply_smart_blur(
        self,
        radius: int | float,
        threshold: int | float,
        quality: str | None = None,
        mode: str | None = None,
        *,
        command_name: str | None = None,
    ) -> LayerProxy:
        args = [radius, threshold]
        if quality is not None:
            args.append(quality)
        if mode is not None:
            args.append(mode)
        return self._invoke("applySmartBlur", *args, command_name=command_name, default_command_name="Apply smart blur")

    def applySmartBlur(
        self,
        radius: int | float,
        threshold: int | float,
        quality: str | None = None,
        mode: str | None = None,
        *,
        commandName: str | None = None,
    ) -> LayerProxy:
        return self.apply_smart_blur(radius, threshold, quality, mode, command_name=commandName)

    def _invoke(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        default_command_name: str,
    ) -> LayerProxy:
        payload = self._layer._session.invoke(
            "filter",
            method,
            self._layer.id,
            *args,
            options=self._layer._session.modal_options(command_name=command_name, default_command_name=default_command_name),
        )
        return self._layer._replace_payload(payload)


class SmartObjectProxy:
    def __init__(self, layer: LayerProxy) -> None:
        self._layer = layer

    def convert_to_smart_object(self, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("convertToSmartObject", command_name=command_name, default_command_name="Convert to smart object")

    def convertToSmartObject(self, *, commandName: str | None = None) -> LayerProxy:
        return self.convert_to_smart_object(command_name=commandName)

    def new_smart_object_via_copy(self, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("newSmartObjectViaCopy", command_name=command_name, default_command_name="New smart object via copy")

    def newSmartObjectViaCopy(self, *, commandName: str | None = None) -> LayerProxy:
        return self.new_smart_object_via_copy(command_name=commandName)

    def edit_contents(self, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("editContents", command_name=command_name, default_command_name="Edit smart object contents")

    def editContents(self, *, commandName: str | None = None) -> LayerProxy:
        return self.edit_contents(command_name=commandName)

    def replace_contents(self, path: str, *, command_name: str | None = None) -> LayerProxy:
        return self._invoke("replaceContents", path, command_name=command_name, default_command_name="Replace smart object contents")

    def replaceContents(self, path: str, *, commandName: str | None = None) -> LayerProxy:
        return self.replace_contents(path, command_name=commandName)

    def _invoke(
        self,
        method: str,
        *args: Any,
        command_name: str | None = None,
        default_command_name: str,
    ) -> LayerProxy:
        payload = self._layer._session.invoke(
            "smartObject",
            method,
            self._layer.id,
            *args,
            options=self._layer._session.modal_options(command_name=command_name, default_command_name=default_command_name),
        )
        return self._layer._replace_payload(payload)


def connect(
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> PhotoshopSession:
    return Photoshop(broker_url=broker_url, token=token, target=target, timeout=timeout)


async def connect_async(
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> PhotoshopSession:
    return connect(broker_url=broker_url, token=token, target=target, timeout=timeout)


def _timeout_options(timeout_ms: int | None) -> dict[str, Any]:
    return {"timeoutMs": timeout_ms} if timeout_ms is not None else {}
