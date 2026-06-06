from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from adobe.core import BrokerClient
from adobe.core.session import HostSession


class InDesignSession(HostSession):
    def __init__(self, client: BrokerClient | None = None) -> None:
        super().__init__("indesign", client)
        self.app = InDesignApp(self)

    def modal_options(
        self,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        default_command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        active_command = command_name or default_command_name
        should_modal = modal if modal is not None else active_command is not None
        options: dict[str, Any] = {"modal": should_modal}
        if active_command:
            options["commandName"] = active_command
        if timeout_ms is not None:
            options["timeoutMs"] = timeout_ms
        return options


class InDesign(InDesignSession):
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
    def activeDocument(self) -> "DocumentProxy | None":
        return self.app.activeDocument

    @property
    def active_document(self) -> "DocumentProxy | None":
        return self.app.active_document

    @property
    def active_page(self) -> "PageProxy | None":
        return self.app.active_page

    @property
    def activePage(self) -> "PageProxy | None":
        return self.active_page

    @property
    def active_spread(self) -> "SpreadProxy | None":
        return self.app.active_spread

    @property
    def activeSpread(self) -> "SpreadProxy | None":
        return self.active_spread

    @property
    def selected_text(self) -> "TextSelectionProxy | None":
        return self.app.selected_text

    @property
    def selectedText(self) -> "TextSelectionProxy | None":
        return self.selected_text


class InDesignApp:
    def __init__(self, session: InDesignSession) -> None:
        self._session = session

    @property
    def version(self) -> str:
        return str(self._session.invoke("app", "getVersion"))

    @property
    def active_document(self) -> "DocumentProxy | None":
        payload = self._session.invoke("document", "getActive")
        return DocumentProxy(self._session, payload) if payload else None

    @property
    def activeDocument(self) -> "DocumentProxy | None":
        return self.active_document

    @property
    def active_page(self) -> "PageProxy | None":
        document = self.active_document
        if document is None:
            return None
        return document.active_page

    @property
    def activePage(self) -> "PageProxy | None":
        return self.active_page

    @property
    def active_spread(self) -> "SpreadProxy | None":
        document = self.active_document
        if document is None:
            return None
        return document.active_spread

    @property
    def activeSpread(self) -> "SpreadProxy | None":
        return self.active_spread

    @property
    def selected_text(self) -> "TextSelectionProxy | None":
        payload = self._session.invoke("text", "getSelectedText")
        return TextSelectionProxy(payload) if payload else None

    @property
    def selectedText(self) -> "TextSelectionProxy | None":
        return self.selected_text


@dataclass
class DocumentProxy:
    _session: InDesignSession
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
    def page_count(self) -> int:
        return int(self._payload.get("pageCount") or 0)

    @property
    def pageCount(self) -> int:
        return self.page_count

    @property
    def spread_count(self) -> int:
        return int(self._payload.get("spreadCount") or 0)

    @property
    def spreadCount(self) -> int:
        return self.spread_count

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    @property
    def pages(self) -> list["PageProxy"]:
        payload = self._session.invoke("page", "getPages", self.id)
        return [PageProxy(self._session, self.id, page) for page in payload or []]

    @property
    def spreads(self) -> list["SpreadProxy"]:
        payload = self._session.invoke("spread", "getSpreads", self.id)
        return [SpreadProxy(self._session, self.id, spread) for spread in payload or []]

    @property
    def text_frames(self) -> list["TextFrameProxy"]:
        payload = self._session.invoke("text", "getTextFrames", self.id)
        return [TextFrameProxy(self._session, self.id, text_frame) for text_frame in payload or []]

    @property
    def textFrames(self) -> list["TextFrameProxy"]:
        return self.text_frames

    @property
    def stories(self) -> list["StoryProxy"]:
        payload = self._session.invoke("story", "getStories", self.id)
        return [StoryProxy(self._session, self.id, story) for story in payload or []]

    @property
    def paragraph_styles(self) -> list["ParagraphStyleProxy"]:
        payload = self._session.invoke("style", "getParagraphStyles", self.id)
        return [ParagraphStyleProxy(self._session, self.id, style) for style in payload or []]

    @property
    def paragraphStyles(self) -> list["ParagraphStyleProxy"]:
        return self.paragraph_styles

    @property
    def character_styles(self) -> list["CharacterStyleProxy"]:
        payload = self._session.invoke("style", "getCharacterStyles", self.id)
        return [CharacterStyleProxy(self._session, self.id, style) for style in payload or []]

    @property
    def characterStyles(self) -> list["CharacterStyleProxy"]:
        return self.character_styles

    @property
    def swatches(self) -> list["SwatchProxy"]:
        payload = self._session.invoke("swatch", "getSwatches", self.id)
        return [SwatchProxy(swatch) for swatch in payload or []]

    @property
    def links(self) -> list["LinkProxy"]:
        payload = self._session.invoke("link", "getLinks", self.id)
        return [LinkProxy(self._session, self.id, link) for link in payload or []]

    @property
    def exports(self) -> "DocumentExportProxy":
        return DocumentExportProxy(self)

    @property
    def package(self) -> "DocumentPackageProxy":
        return DocumentPackageProxy(self)

    @property
    def active_page(self) -> "PageProxy | None":
        payload = self._session.invoke("page", "getActive", self.id)
        return PageProxy(self._session, self.id, payload) if payload else None

    @property
    def activePage(self) -> "PageProxy | None":
        return self.active_page

    @property
    def active_spread(self) -> "SpreadProxy | None":
        payload = self._session.invoke("spread", "getActive", self.id)
        return SpreadProxy(self._session, self.id, payload) if payload else None

    @property
    def activeSpread(self) -> "SpreadProxy | None":
        return self.active_spread

    def get_page(self, name: str) -> "PageProxy | None":
        payload = self._session.invoke("page", "getByName", self.id, name)
        return PageProxy(self._session, self.id, payload) if payload else None

    def getPage(self, name: str) -> "PageProxy | None":
        return self.get_page(name)

    def get_spread(self, name: str) -> "SpreadProxy | None":
        payload = self._session.invoke("spread", "getByName", self.id, name)
        return SpreadProxy(self._session, self.id, payload) if payload else None

    def getSpread(self, name: str) -> "SpreadProxy | None":
        return self.get_spread(name)

    def get_text_frame(self, name: str) -> "TextFrameProxy | None":
        payload = self._session.invoke("text", "getTextFrameByName", self.id, name)
        return TextFrameProxy(self._session, self.id, payload) if payload else None

    def getTextFrame(self, name: str) -> "TextFrameProxy | None":
        return self.get_text_frame(name)

    def get_story(self, name: str) -> "StoryProxy | None":
        payload = self._session.invoke("story", "getByName", self.id, name)
        return StoryProxy(self._session, self.id, payload) if payload else None

    def getStory(self, name: str) -> "StoryProxy | None":
        return self.get_story(name)

    def get_paragraph_style(self, name: str) -> "ParagraphStyleProxy | None":
        payload = self._session.invoke("style", "getParagraphStyleByName", self.id, name)
        return ParagraphStyleProxy(self._session, self.id, payload) if payload else None

    def getParagraphStyle(self, name: str) -> "ParagraphStyleProxy | None":
        return self.get_paragraph_style(name)

    def get_character_style(self, name: str) -> "CharacterStyleProxy | None":
        payload = self._session.invoke("style", "getCharacterStyleByName", self.id, name)
        return CharacterStyleProxy(self._session, self.id, payload) if payload else None

    def getCharacterStyle(self, name: str) -> "CharacterStyleProxy | None":
        return self.get_character_style(name)

    def get_swatch(self, name: str) -> "SwatchProxy | None":
        payload = self._session.invoke("swatch", "getByName", self.id, name)
        return SwatchProxy(payload) if payload else None

    def getSwatch(self, name: str) -> "SwatchProxy | None":
        return self.get_swatch(name)

    def add_color_swatch(
        self,
        name: str,
        color_value: list[Any],
        *,
        model: Any = None,
        space: Any = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> "SwatchProxy":
        payload = self._session.invoke(
            "swatch",
            "addColor",
            self.id,
            {"name": name, "colorValue": color_value, "model": model, "space": space},
            options=self._session.modal_options(
                command_name=command_name,
                default_command_name="Add color swatch",
                timeout_ms=timeout_ms,
            ),
        )
        return SwatchProxy(payload or {})

    def addColorSwatch(
        self,
        name: str,
        colorValue: list[Any],
        *,
        model: Any = None,
        space: Any = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> "SwatchProxy":
        return self.add_color_swatch(name, colorValue, model=model, space=space, command_name=commandName, timeout_ms=timeoutMs)

    def get_link(self, name: str) -> "LinkProxy | None":
        payload = self._session.invoke("link", "getByName", self.id, name)
        return LinkProxy(self._session, self.id, payload) if payload else None

    def getLink(self, name: str) -> "LinkProxy | None":
        return self.get_link(name)

    def export_file(
        self,
        format: Any,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._session.invoke(
            "export",
            "exportFile",
            {"id": self.id, "format": format, "path": path, "options": options or {}},
            options=self._session.modal_options(
                command_name=command_name,
                default_command_name="Export document",
                timeout_ms=timeout_ms,
            ),
        )

    def exportFile(
        self,
        format: Any,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> Any:
        return self.export_file(format, path, options=options, command_name=commandName, timeout_ms=timeoutMs)

    def package_for_print(
        self,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        payload = self._session.invoke(
            "package",
            "packageForPrint",
            {"id": self.id, "path": path, "options": options or {}},
            options=self._session.modal_options(
                command_name=command_name,
                default_command_name="Package document",
                timeout_ms=timeout_ms,
            ),
        )
        return payload if isinstance(payload, dict) else {"ok": bool(payload), "path": path}

    def packageForPrint(
        self,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> dict[str, Any]:
        return self.package_for_print(path, options=options, command_name=commandName, timeout_ms=timeoutMs)


@dataclass
class SwatchProxy:
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def model(self) -> Any:
        return self._payload.get("model")

    @property
    def space(self) -> Any:
        return self._payload.get("space")

    @property
    def color_value(self) -> list[Any]:
        value = self._payload.get("colorValue")
        return list(value) if isinstance(value, list) else []

    @property
    def colorValue(self) -> list[Any]:
        return self.color_value

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")


@dataclass
class LinkProxy:
    _session: InDesignSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def file_path(self) -> str | None:
        return self._payload.get("filePath")

    @property
    def filePath(self) -> str | None:
        return self.file_path

    @property
    def status(self) -> Any:
        return self._payload.get("status")

    @property
    def link_type(self) -> str | None:
        return self._payload.get("linkType")

    @property
    def linkType(self) -> str | None:
        return self.link_type

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    def update(self, *, command_name: str | None = None, timeout_ms: int | None = None) -> "LinkProxy":
        payload = self._session.invoke(
            "link",
            "update",
            self._document_id,
            self.id or self.name,
            options=self._session.modal_options(
                command_name=command_name,
                default_command_name="Update link",
                timeout_ms=timeout_ms,
            ),
        )
        self._payload = payload or {}
        return self

    def relink(self, path: str, *, command_name: str | None = None, timeout_ms: int | None = None) -> "LinkProxy":
        payload = self._session.invoke(
            "link",
            "relink",
            self._document_id,
            self.id or self.name,
            path,
            options=self._session.modal_options(
                command_name=command_name,
                default_command_name="Relink asset",
                timeout_ms=timeout_ms,
            ),
        )
        self._payload = payload or {}
        return self


class DocumentExportProxy:
    def __init__(self, document: DocumentProxy) -> None:
        self._document = document

    def file(
        self,
        format: Any,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> Any:
        return self._document.export_file(format, path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def pdf(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.file("PDF_TYPE", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def interactive_pdf(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.file("INTERACTIVE_PDF", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def interactivePdf(self, path: str, *, options: dict[str, Any] | None = None, commandName: str | None = None, timeoutMs: int | None = None) -> Any:
        return self.interactive_pdf(path, options=options, command_name=commandName, timeout_ms=timeoutMs)

    def idml(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.file("INDESIGN_MARKUP", path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def epub(self, path: str, *, options: dict[str, Any] | None = None, command_name: str | None = None, timeout_ms: int | None = None) -> Any:
        return self.file("EPUB", path, options=options, command_name=command_name, timeout_ms=timeout_ms)


class DocumentPackageProxy:
    def __init__(self, document: DocumentProxy) -> None:
        self._document = document

    def for_print(
        self,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> dict[str, Any]:
        return self._document.package_for_print(path, options=options, command_name=command_name, timeout_ms=timeout_ms)

    def forPrint(
        self,
        path: str,
        *,
        options: dict[str, Any] | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> dict[str, Any]:
        return self.for_print(path, options=options, command_name=commandName, timeout_ms=timeoutMs)


@dataclass
class TextSelectionProxy:
    _payload: dict[str, Any]

    @property
    def contents(self) -> str | None:
        return self._payload.get("contents")

    @property
    def parent_story_id(self) -> int | str | None:
        return self._payload.get("parentStoryId")

    @property
    def parentStoryId(self) -> int | str | None:
        return self.parent_story_id

    @property
    def parent_story_name(self) -> str | None:
        return self._payload.get("parentStoryName")

    @property
    def parentStoryName(self) -> str | None:
        return self.parent_story_name

    @property
    def index(self) -> Any:
        return self._payload.get("index")

    @property
    def length(self) -> Any:
        return self._payload.get("length")

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")


@dataclass
class TextFrameProxy:
    _session: InDesignSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def index(self) -> Any:
        return self._payload.get("index")

    @property
    def contents(self) -> str | None:
        return self._payload.get("contents")

    @property
    def overflows(self) -> bool | None:
        value = self._payload.get("overflows")
        return bool(value) if value is not None else None

    @property
    def geometric_bounds(self) -> list[Any]:
        value = self._payload.get("geometricBounds")
        return list(value) if isinstance(value, list) else []

    @property
    def geometricBounds(self) -> list[Any]:
        return self.geometric_bounds

    @property
    def parent_story_id(self) -> int | str | None:
        return self._payload.get("parentStoryId")

    @property
    def parentStoryId(self) -> int | str | None:
        return self.parent_story_id

    @property
    def parent_story_name(self) -> str | None:
        return self._payload.get("parentStoryName")

    @property
    def parentStoryName(self) -> str | None:
        return self.parent_story_name

    @property
    def parent_page_id(self) -> int | str | None:
        return self._payload.get("parentPageId")

    @property
    def parentPageId(self) -> int | str | None:
        return self.parent_page_id

    @property
    def parent_page_name(self) -> str | None:
        return self._payload.get("parentPageName")

    @property
    def parentPageName(self) -> str | None:
        return self.parent_page_name

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    @property
    def story(self) -> "StoryProxy | None":
        payload = self._session.invoke("story", "getByTextFrameId", self._document_id, self.id or self.name)
        return StoryProxy(self._session, self._document_id, payload) if payload else None

    def set_contents(
        self,
        contents: str,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> "TextFrameProxy":
        payload = self._session.invoke(
            "text",
            "setFrameContents",
            self._document_id,
            self.id or self.name,
            contents,
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name="Set text frame contents",
                timeout_ms=timeout_ms,
            ),
        )
        self._payload = payload or {}
        return self

    def setContents(
        self,
        contents: str,
        *,
        modal: bool | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> "TextFrameProxy":
        return self.set_contents(contents, modal=modal, command_name=commandName, timeout_ms=timeoutMs)


@dataclass
class StoryProxy:
    _session: InDesignSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def index(self) -> Any:
        return self._payload.get("index")

    @property
    def contents(self) -> str | None:
        return self._payload.get("contents")

    @property
    def length(self) -> Any:
        return self._payload.get("length")

    @property
    def text_container_count(self) -> int:
        return int(self._payload.get("textContainerCount") or 0)

    @property
    def textContainerCount(self) -> int:
        return self.text_container_count

    @property
    def paragraph_count(self) -> int:
        return int(self._payload.get("paragraphCount") or 0)

    @property
    def paragraphCount(self) -> int:
        return self.paragraph_count

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    def set_contents(
        self,
        contents: str,
        *,
        modal: bool | None = None,
        command_name: str | None = None,
        timeout_ms: int | None = None,
    ) -> "StoryProxy":
        payload = self._session.invoke(
            "story",
            "setContents",
            self._document_id,
            self.id or self.name,
            contents,
            options=self._session.modal_options(
                modal=modal,
                command_name=command_name,
                default_command_name="Set story contents",
                timeout_ms=timeout_ms,
            ),
        )
        self._payload = payload or {}
        return self

    def setContents(
        self,
        contents: str,
        *,
        modal: bool | None = None,
        commandName: str | None = None,
        timeoutMs: int | None = None,
    ) -> "StoryProxy":
        return self.set_contents(contents, modal=modal, command_name=commandName, timeout_ms=timeoutMs)


class _InDesignStyleProxy:
    _set_method = ""
    _default_command_name = "Update style"

    def __init__(self, session: InDesignSession, document_id: int | str | None, payload: dict[str, Any]) -> None:
        self._session = session
        self._document_id = document_id
        self._payload = payload

    def _value(self, name: str) -> Any:
        return self._payload.get(name)

    def _update(
        self,
        properties: dict[str, Any] | None = None,
        *,
        command_name: str | None = None,
        **kwargs: Any,
    ) -> "_InDesignStyleProxy":
        merged = dict(properties or {})
        merged.update(kwargs)
        payload = self._session.invoke(
            "style",
            self._set_method,
            self._document_id,
            self._value("name") or self._value("id"),
            merged,
            options=self._session.modal_options(command_name=command_name, default_command_name=self._default_command_name),
        )
        self._payload = payload or {}
        return self

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        if name in self._payload:
            return self._payload[name]
        raise AttributeError(name)


class ParagraphStyleProxy(_InDesignStyleProxy):
    _set_method = "setParagraphStyleProperties"
    _default_command_name = "Update paragraph style"

    @property
    def id(self) -> int | str | None:
        return self._value("id")

    @property
    def name(self) -> str | None:
        return self._value("name")

    @property
    def index(self) -> Any:
        return self._value("index")

    @property
    def is_valid(self) -> bool | None:
        value = self._value("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._value("typename")

    @property
    def applied_font(self) -> Any:
        return self._value("appliedFont")

    @property
    def appliedFont(self) -> Any:
        return self.applied_font

    @property
    def font_style(self) -> Any:
        return self._value("fontStyle")

    @property
    def fontStyle(self) -> Any:
        return self.font_style

    @property
    def point_size(self) -> Any:
        return self._value("pointSize")

    @property
    def pointSize(self) -> Any:
        return self.point_size

    @property
    def leading(self) -> Any:
        return self._value("leading")

    @property
    def tracking(self) -> Any:
        return self._value("tracking")

    @property
    def justification(self) -> Any:
        return self._value("justification")

    def update(self, properties: dict[str, Any] | None = None, *, command_name: str | None = None, **kwargs: Any) -> "ParagraphStyleProxy":
        return self._update(properties, command_name=command_name, **kwargs)  # type: ignore[return-value]


class CharacterStyleProxy(_InDesignStyleProxy):
    _set_method = "setCharacterStyleProperties"
    _default_command_name = "Update character style"

    @property
    def id(self) -> int | str | None:
        return self._value("id")

    @property
    def name(self) -> str | None:
        return self._value("name")

    @property
    def index(self) -> Any:
        return self._value("index")

    @property
    def is_valid(self) -> bool | None:
        value = self._value("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._value("typename")

    @property
    def applied_font(self) -> Any:
        return self._value("appliedFont")

    @property
    def appliedFont(self) -> Any:
        return self.applied_font

    @property
    def font_style(self) -> Any:
        return self._value("fontStyle")

    @property
    def fontStyle(self) -> Any:
        return self.font_style

    @property
    def point_size(self) -> Any:
        return self._value("pointSize")

    @property
    def pointSize(self) -> Any:
        return self.point_size

    @property
    def leading(self) -> Any:
        return self._value("leading")

    @property
    def tracking(self) -> Any:
        return self._value("tracking")

    def update(self, properties: dict[str, Any] | None = None, *, command_name: str | None = None, **kwargs: Any) -> "CharacterStyleProxy":
        return self._update(properties, command_name=command_name, **kwargs)  # type: ignore[return-value]


@dataclass
class PageProxy:
    _session: InDesignSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def index(self) -> Any:
        return self._payload.get("index")

    @property
    def document_offset(self) -> Any:
        return self._payload.get("documentOffset")

    @property
    def documentOffset(self) -> Any:
        return self.document_offset

    @property
    def side(self) -> Any:
        return self._payload.get("side")

    @property
    def bounds(self) -> list[Any]:
        value = self._payload.get("bounds")
        return list(value) if isinstance(value, list) else []

    @property
    def parent_id(self) -> int | str | None:
        return self._payload.get("parentId")

    @property
    def parentId(self) -> int | str | None:
        return self.parent_id

    @property
    def parent_name(self) -> str | None:
        return self._payload.get("parentName")

    @property
    def parentName(self) -> str | None:
        return self.parent_name

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")

    def select(self, existing_selection: Any | None = None) -> "PageProxy":
        payload = self._session.invoke("page", "select", self._document_id, self.id or self.name, existing_selection)
        self._payload = payload or {}
        return self


@dataclass
class SpreadProxy:
    _session: InDesignSession
    _document_id: int | str | None
    _payload: dict[str, Any]

    @property
    def id(self) -> int | str | None:
        return self._payload.get("id")

    @property
    def name(self) -> str | None:
        return self._payload.get("name")

    @property
    def label(self) -> str | None:
        return self._payload.get("label")

    @property
    def index(self) -> Any:
        return self._payload.get("index")

    @property
    def page_count(self) -> int:
        return int(self._payload.get("pageCount") or 0)

    @property
    def pageCount(self) -> int:
        return self.page_count

    @property
    def page_names(self) -> list[str]:
        value = self._payload.get("pageNames")
        return [str(name) for name in value] if isinstance(value, list) else []

    @property
    def pageNames(self) -> list[str]:
        return self.page_names

    @property
    def parent_id(self) -> int | str | None:
        return self._payload.get("parentId")

    @property
    def parentId(self) -> int | str | None:
        return self.parent_id

    @property
    def parent_name(self) -> str | None:
        return self._payload.get("parentName")

    @property
    def parentName(self) -> str | None:
        return self.parent_name

    @property
    def is_valid(self) -> bool | None:
        value = self._payload.get("isValid")
        return bool(value) if value is not None else None

    @property
    def isValid(self) -> bool | None:
        return self.is_valid

    @property
    def typename(self) -> str | None:
        return self._payload.get("typename")


def connect(
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> InDesignSession:
    return InDesign(broker_url=broker_url, token=token, target=target, timeout=timeout)


async def connect_async(
    *,
    broker_url: str | None = None,
    token: str | None = None,
    target: str | None = None,
    timeout: float = 30.0,
) -> InDesignSession:
    return connect(broker_url=broker_url, token=token, target=target, timeout=timeout)
