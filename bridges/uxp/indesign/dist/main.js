"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // bridges/uxp/core/src/protocol.ts
  var ERROR_CODES = Object.freeze({
    ERROR_PARSE: -32700,
    ERROR_INVALID_REQUEST: -32600,
    ERROR_METHOD_NOT_FOUND: -32601,
    ERROR_HOST_NOT_RUNNING: -32001,
    ERROR_BRIDGE_NOT_INSTALLED: -32002,
    ERROR_CAPABILITY: -32003,
    ERROR_HOST_SCRIPT: -32004,
    ERROR_PERMISSION: -32005,
    ERROR_MODAL_REQUIRED: -32006,
    ERROR_TIMEOUT: -32007,
    ERROR_SERIALIZATION: -32008,
    ERROR_UNAUTHORIZED: -32009
  });

  // bridges/uxp/core/src/errors.ts
  var ERROR_METHOD_NOT_FOUND = ERROR_CODES.ERROR_METHOD_NOT_FOUND;
  var ERROR_HOST_SCRIPT = ERROR_CODES.ERROR_HOST_SCRIPT;
  var BridgeRpcError = class extends Error {
    constructor(code, message, data) {
      super(message);
      this.name = "BridgeRpcError";
      this.code = code;
      this.data = data;
    }
  };
  function methodNotFound(namespace, method) {
    throw new BridgeRpcError(ERROR_METHOD_NOT_FOUND, `unsupported method ${namespace}.${method}`);
  }
  function unavailable(feature) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `${feature} is unavailable in this host runtime`);
  }

  // bridges/uxp/core/src/rpc.ts
  function connectBridge(adapter) {
    const url = globalThis.__ADOBEPY_BROKER_URL || `ws://127.0.0.1:47391/v1/bridge/${adapter.capabilities().host}/ws`;
    const token = globalThis.__ADOBEPY_TOKEN || "dev-token";
    const target = globalThis.__ADOBEPY_TARGET || "default";
    const socket = new WebSocket(url);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", token, target, capabilities: adapter.capabilities() }));
    });
    socket.addEventListener("message", async (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "request") return;
      const request = message.request;
      try {
        const result = await adapter.dispatch(request);
        socket.send(JSON.stringify({ type: "response", response: { jsonrpc: "2.0", id: request.id, result: result ?? null } }));
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", error: hostError(request.id, error) }));
      }
    });
  }
  function hostError(id, error) {
    const code = error instanceof BridgeRpcError ? error.code : ERROR_HOST_SCRIPT;
    const message = error instanceof Error ? error.message : String(error);
    const data = error instanceof BridgeRpcError ? error.data : void 0;
    return { jsonrpc: "2.0", id, error: { code, message, ...data === void 0 ? {} : { data } } };
  }

  // bridges/uxp/core/src/runtime.ts
  function optionalRequire(moduleName) {
    const loader = globalThis.require ?? __require;
    if (typeof loader !== "function") return void 0;
    try {
      const loaded = loader(moduleName);
      return isObject(loaded) ? loaded : void 0;
    } catch {
      return void 0;
    }
  }
  function isObject(value) {
    return typeof value === "object" && value !== null;
  }
  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (!isObject(value)) return [];
    const iterable = value;
    if (typeof iterable[Symbol.iterator] === "function") return Array.from(iterable);
    const length = value.length;
    if (typeof length === "number") {
      return Array.from({ length }, (_, index) => value[index]).filter((item) => item !== void 0);
    }
    return [];
  }
  function asString(value) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return void 0;
  }
  function asNumber(value) {
    if (typeof value === "number") return value;
    if (isObject(value) && typeof value.valueOf === "function") {
      const converted = value.valueOf();
      if (typeof converted === "number") return converted;
    }
    return void 0;
  }
  function property(value, name) {
    if (!isObject(value)) return void 0;
    return value[name];
  }
  async function maybePromise(value) {
    return await value;
  }
  function toFileUrl(path) {
    if (/^file:\/\//i.test(path)) return path;
    const normalized = path.replace(/\\/g, "/");
    if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
    if (normalized.startsWith("/")) return `file://${normalized}`;
    return normalized;
  }
  async function evalJavaScript(source, args) {
    try {
      return await (0, eval)(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const fn = new Function("args", source);
      return await fn(args);
    }
  }

  // bridges/uxp/indesign/src/host.ts
  var indesignAdapter = {
    capabilities() {
      return {
        host: "indesign",
        bridgeKind: "uxp",
        bridgeVersion: "0.1.0",
        hostVersion: indesignVersion(),
        namespaces: ["app", "document", "page", "spread", "text", "story", "style", "swatch", "link", "export", "package", "raw"],
        features: ["dom"],
        methods: {
          app: ["getVersion"],
          document: ["getActive"],
          page: ["getPages", "getActive", "getByName", "select"],
          spread: ["getSpreads", "getActive", "getByName"],
          text: ["getTextFrames", "getTextFrameByName", "getSelectedText", "setFrameContents"],
          story: ["getStories", "getByName", "getByTextFrameId", "setContents"],
          style: [
            "getParagraphStyles",
            "getCharacterStyles",
            "getParagraphStyleByName",
            "getCharacterStyleByName",
            "setParagraphStyleProperties",
            "setCharacterStyleProperties"
          ],
          swatch: ["getSwatches", "getByName", "addColor"],
          link: ["getLinks", "getByName", "update", "relink"],
          export: ["exportFile"],
          package: ["packageForPrint"],
          raw: ["evalJs"]
        }
      };
    },
    async dispatch(request) {
      if (request.namespace === "app" && request.method === "getVersion") return indesignVersion();
      if (request.namespace === "document" && request.method === "getActive") return serializeDocument(activeDocument());
      if (request.namespace === "page" && request.method === "getPages") return documentPages(request);
      if (request.namespace === "page" && request.method === "getActive") return serializePage(activePage(request.args?.[0]));
      if (request.namespace === "page" && request.method === "getByName") return serializePage(findPage(request.args?.[0], request.args?.[1]));
      if (request.namespace === "page" && request.method === "select") return pageSelect(request);
      if (request.namespace === "spread" && request.method === "getSpreads") return documentSpreads(request);
      if (request.namespace === "spread" && request.method === "getActive") return serializeSpread(activeSpread(request.args?.[0]));
      if (request.namespace === "spread" && request.method === "getByName") return serializeSpread(findSpread(request.args?.[0], request.args?.[1]));
      if (request.namespace === "text" && request.method === "getTextFrames") return documentTextFrames(request);
      if (request.namespace === "text" && request.method === "getTextFrameByName") return serializeTextFrame(findTextFrame(request.args?.[0], request.args?.[1]));
      if (request.namespace === "text" && request.method === "getSelectedText") return serializeTextSelection(selectedText());
      if (request.namespace === "text" && request.method === "setFrameContents") return textFrameSetContents(request);
      if (request.namespace === "story" && request.method === "getStories") return documentStories(request);
      if (request.namespace === "story" && request.method === "getByName") return serializeStory(findStory(request.args?.[0], request.args?.[1]));
      if (request.namespace === "story" && request.method === "getByTextFrameId") return serializeStory(storyForTextFrame(request.args?.[0], request.args?.[1]));
      if (request.namespace === "story" && request.method === "setContents") return storySetContents(request);
      if (request.namespace === "style" && request.method === "getParagraphStyles") return documentStyles(request, "paragraphStyles", serializeParagraphStyle);
      if (request.namespace === "style" && request.method === "getCharacterStyles") return documentStyles(request, "characterStyles", serializeCharacterStyle);
      if (request.namespace === "style" && request.method === "getParagraphStyleByName") return serializeParagraphStyle(findStyle(request.args?.[0], "paragraphStyles", request.args?.[1]));
      if (request.namespace === "style" && request.method === "getCharacterStyleByName") return serializeCharacterStyle(findStyle(request.args?.[0], "characterStyles", request.args?.[1]));
      if (request.namespace === "style" && request.method === "setParagraphStyleProperties") {
        return styleSetProperties(request, "paragraphStyles", serializeParagraphStyle, "Update paragraph style");
      }
      if (request.namespace === "style" && request.method === "setCharacterStyleProperties") {
        return styleSetProperties(request, "characterStyles", serializeCharacterStyle, "Update character style");
      }
      if (request.namespace === "swatch" && request.method === "getSwatches") return documentSwatches(request);
      if (request.namespace === "swatch" && request.method === "getByName") return serializeSwatch(findSwatch(request.args?.[0], request.args?.[1]));
      if (request.namespace === "swatch" && request.method === "addColor") return swatchAddColor(request);
      if (request.namespace === "link" && request.method === "getLinks") return documentLinks(request);
      if (request.namespace === "link" && request.method === "getByName") return serializeLink(findLink(request.args?.[0], request.args?.[1]));
      if (request.namespace === "link" && request.method === "update") return linkUpdate(request);
      if (request.namespace === "link" && request.method === "relink") return linkRelink(request);
      if (request.namespace === "export" && request.method === "exportFile") return documentExportFile(request);
      if (request.namespace === "package" && request.method === "packageForPrint") return documentPackageForPrint(request);
      if (request.namespace === "raw" && request.method === "evalJs") return evalJavaScript(asString(request.args?.[0]) ?? "", request.args?.slice(1) ?? []);
      methodNotFound(request.namespace, request.method);
    }
  };
  function indesignModule() {
    return optionalRequire("indesign") ?? globalThis.indesign ?? {};
  }
  function indesignApp() {
    return property(indesignModule(), "app") ?? globalThis.app ?? {};
  }
  function indesignVersion() {
    const app = indesignApp();
    return asString(property(app, "version")) ?? asString(property(property(app, "scriptPreferences"), "version")) ?? "unknown";
  }
  function activeDocument() {
    return property(indesignApp(), "activeDocument");
  }
  function openDocuments() {
    return asArray(property(indesignApp(), "documents"));
  }
  function findDocument(id) {
    const active = activeDocument();
    if (id === void 0 || id === null) return active;
    const match = openDocuments().find((document) => String(property(document, "id")) === String(id));
    return match ?? (String(property(active, "id")) === String(id) ? active : void 0);
  }
  function serializeDocument(document) {
    if (!isObject(document)) return null;
    const pages = asArray(property(document, "pages"));
    const spreads = asArray(property(document, "spreads"));
    return {
      id: property(document, "id"),
      name: asString(property(document, "name")),
      path: asString(property(property(document, "fullName"), "fsName")) ?? asString(property(document, "path")),
      width: asNumber(property(document, "width")) ?? property(document, "width"),
      height: asNumber(property(document, "height")) ?? property(document, "height"),
      pageCount: pages.length,
      spreadCount: spreads.length,
      typename: asString(property(document, "typename"))
    };
  }
  function serializePage(page) {
    if (!isObject(page)) return null;
    const parent = property(page, "parent");
    return {
      id: property(page, "id"),
      name: asString(property(page, "name")),
      index: asNumber(property(page, "index")) ?? property(page, "index"),
      documentOffset: asNumber(property(page, "documentOffset")) ?? property(page, "documentOffset"),
      side: asString(property(page, "side")) ?? property(page, "side"),
      bounds: serializeBounds(property(page, "bounds")),
      parentId: property(parent, "id"),
      parentName: asString(property(parent, "name")),
      isValid: property(page, "isValid"),
      typename: asString(property(page, "typename"))
    };
  }
  function serializeSpread(spread) {
    if (!isObject(spread)) return null;
    const parent = property(spread, "parent");
    const pages = asArray(property(spread, "pages"));
    return {
      id: property(spread, "id"),
      name: asString(property(spread, "name")),
      label: asString(property(spread, "label")),
      index: asNumber(property(spread, "index")) ?? property(spread, "index"),
      pageCount: pages.length,
      pageNames: pages.map((page) => asString(property(page, "name"))).filter((name) => name !== void 0),
      parentId: property(parent, "id"),
      parentName: asString(property(parent, "name")),
      isValid: property(spread, "isValid"),
      typename: asString(property(spread, "typename"))
    };
  }
  function serializeTextFrame(textFrame) {
    if (!isObject(textFrame)) return null;
    const parentStory = property(textFrame, "parentStory");
    const parentPage = property(textFrame, "parentPage");
    return {
      id: property(textFrame, "id"),
      name: asString(property(textFrame, "name")),
      index: asNumber(property(textFrame, "index")) ?? property(textFrame, "index"),
      contents: asString(property(textFrame, "contents")),
      overflows: property(textFrame, "overflows"),
      geometricBounds: serializeBounds(property(textFrame, "geometricBounds")),
      parentStoryId: property(parentStory, "id"),
      parentStoryName: asString(property(parentStory, "name")),
      parentPageId: property(parentPage, "id"),
      parentPageName: asString(property(parentPage, "name")),
      isValid: property(textFrame, "isValid"),
      typename: asString(property(textFrame, "typename"))
    };
  }
  function serializeStory(story) {
    if (!isObject(story)) return null;
    const contents = asString(property(story, "contents"));
    return {
      id: property(story, "id"),
      name: asString(property(story, "name")),
      index: asNumber(property(story, "index")) ?? property(story, "index"),
      contents,
      length: contents?.length ?? asNumber(property(story, "length")) ?? property(story, "length"),
      textContainerCount: asArray(property(story, "textContainers")).length,
      paragraphCount: asArray(property(story, "paragraphs")).length,
      isValid: property(story, "isValid"),
      typename: asString(property(story, "typename"))
    };
  }
  function serializeTextSelection(text) {
    if (!isObject(text)) return null;
    const parentStory = property(text, "parentStory");
    return {
      contents: asString(property(text, "contents")),
      parentStoryId: property(parentStory, "id"),
      parentStoryName: asString(property(parentStory, "name")),
      index: asNumber(property(text, "index")) ?? property(text, "index"),
      length: asNumber(property(text, "length")) ?? property(text, "length"),
      isValid: property(text, "isValid"),
      typename: asString(property(text, "typename"))
    };
  }
  function serializeParagraphStyle(style) {
    return serializeStyle(style, ["appliedFont", "fontStyle", "pointSize", "leading", "tracking", "justification"]);
  }
  function serializeCharacterStyle(style) {
    return serializeStyle(style, ["appliedFont", "fontStyle", "pointSize", "leading", "tracking"]);
  }
  function serializeStyle(style, keys) {
    if (!isObject(style)) return null;
    const output = {
      id: property(style, "id"),
      name: asString(property(style, "name")),
      index: asNumber(property(style, "index")) ?? property(style, "index"),
      isValid: property(style, "isValid"),
      typename: asString(property(style, "typename"))
    };
    for (const key of keys) {
      try {
        const value = property(style, key);
        if (value !== void 0 && typeof value !== "function") output[key] = scalarValue(value);
      } catch {
      }
    }
    return output;
  }
  function serializeSwatch(swatch) {
    if (!isObject(swatch)) return null;
    return {
      id: property(swatch, "id"),
      name: asString(property(swatch, "name")),
      model: scalarValue(property(swatch, "model")),
      space: scalarValue(property(swatch, "space")),
      colorValue: asArray(property(swatch, "colorValue")),
      isValid: property(swatch, "isValid"),
      typename: asString(property(swatch, "typename"))
    };
  }
  function serializeLink(link) {
    if (!isObject(link)) return null;
    const filePath = asString(property(link, "filePath")) ?? asString(property(property(link, "filePath"), "fsName")) ?? asString(property(property(link, "file"), "fsName")) ?? asString(property(link, "path"));
    return {
      id: property(link, "id"),
      name: asString(property(link, "name")),
      filePath,
      status: scalarValue(property(link, "status")),
      linkType: asString(property(link, "linkType")),
      isValid: property(link, "isValid"),
      typename: asString(property(link, "typename"))
    };
  }
  function serializeBounds(bounds) {
    return asArray(bounds).map((value) => asNumber(value) ?? value);
  }
  function documentPages(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "pages")).map(serializePage).filter((page) => page !== null);
  }
  function documentSpreads(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "spreads")).map(serializeSpread).filter((spread) => spread !== null);
  }
  function activePage(documentId) {
    const activeWindow = property(indesignApp(), "activeWindow");
    const page = property(activeWindow, "activePage");
    if (page) return page;
    const document = findDocument(documentId);
    return asArray(property(document, "pages"))[0];
  }
  function activeSpread(documentId) {
    const activeWindow = property(indesignApp(), "activeWindow");
    const spread = property(activeWindow, "activeSpread");
    if (spread) return spread;
    const pageParent = property(activePage(documentId), "parent");
    if (pageParent) return pageParent;
    const document = findDocument(documentId);
    return asArray(property(document, "spreads"))[0];
  }
  function findPage(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return activePage(documentId);
    const document = findDocument(documentId);
    const pages = property(document, "pages");
    const byName = property(pages, "itemByName");
    if (byName && typeof idOrName === "string") {
      try {
        const page = byName.call(pages, idOrName);
        if (page) return page;
      } catch {
      }
    }
    return asArray(pages).find((page) => String(property(page, "id")) === String(idOrName) || asString(property(page, "name")) === String(idOrName));
  }
  function findSpread(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return activeSpread(documentId);
    const document = findDocument(documentId);
    const spreads = property(document, "spreads");
    const byName = property(spreads, "itemByName");
    if (byName && typeof idOrName === "string") {
      try {
        const spread = byName.call(spreads, idOrName);
        if (spread) return spread;
      } catch {
      }
    }
    return asArray(spreads).find((spread) => String(property(spread, "id")) === String(idOrName) || asString(property(spread, "name")) === String(idOrName));
  }
  async function pageSelect(request) {
    const page = findPage(request.args?.[0], request.args?.[1]);
    if (!page) unavailable("InDesign page");
    const select = property(page, "select");
    if (!select) unavailable("InDesign page.select");
    await maybePromise(select.call(page, request.args?.[2]));
    return serializePage(page);
  }
  function documentTextFrames(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "textFrames")).map(serializeTextFrame).filter((textFrame) => textFrame !== null);
  }
  function documentStories(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "stories")).map(serializeStory).filter((story) => story !== null);
  }
  function documentStyles(request, collectionName, serializer) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, collectionName)).map(serializer).filter((style) => style !== null);
  }
  function documentSwatches(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "swatches")).map(serializeSwatch).filter((swatch) => swatch !== null);
  }
  function documentLinks(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) return [];
    return asArray(property(document, "links")).map(serializeLink).filter((link) => link !== null);
  }
  function selectedText() {
    return asArray(property(indesignApp(), "selection")).find((item) => property(item, "contents") !== void 0);
  }
  function findTextFrame(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return void 0;
    const document = findDocument(documentId);
    const frames = property(document, "textFrames");
    const byName = property(frames, "itemByName");
    if (byName && typeof idOrName === "string") {
      try {
        const frame = byName.call(frames, idOrName);
        if (frame) return frame;
      } catch {
      }
    }
    return asArray(frames).find((frame) => String(property(frame, "id")) === String(idOrName) || asString(property(frame, "name")) === String(idOrName));
  }
  function storyForTextFrame(documentId, textFrameId) {
    return property(findTextFrame(documentId, textFrameId), "parentStory");
  }
  async function textFrameSetContents(request) {
    const textFrame = findTextFrame(request.args?.[0], request.args?.[1]);
    if (!textFrame) unavailable("InDesign text frame");
    return withInDesignCommand(request, "Set text frame contents", async () => {
      textFrame.contents = asString(request.args?.[2]) ?? "";
      return serializeTextFrame(textFrame);
    });
  }
  async function storySetContents(request) {
    const story = storyForTextFrame(request.args?.[0], request.args?.[1]) ?? findStory(request.args?.[0], request.args?.[1]);
    if (!story) unavailable("InDesign story");
    return withInDesignCommand(request, "Set story contents", async () => {
      story.contents = asString(request.args?.[2]) ?? "";
      return serializeStory(story);
    });
  }
  function findStory(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return void 0;
    const document = findDocument(documentId);
    const stories = property(document, "stories");
    return asArray(stories).find((story) => String(property(story, "id")) === String(idOrName) || asString(property(story, "name")) === String(idOrName));
  }
  function findStyle(documentId, collectionName, name) {
    if (name === void 0 || name === null) return void 0;
    const document = findDocument(documentId);
    const collection = property(document, collectionName);
    const byName = property(collection, "itemByName");
    if (byName && typeof name === "string") {
      try {
        const style = byName.call(collection, name);
        if (style) return style;
      } catch {
      }
    }
    return asArray(collection).find((style) => String(property(style, "id")) === String(name) || asString(property(style, "name")) === String(name));
  }
  function findSwatch(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return void 0;
    const document = findDocument(documentId);
    const swatches = property(document, "swatches");
    const byName = property(swatches, "itemByName");
    if (byName && typeof idOrName === "string") {
      try {
        const swatch = byName.call(swatches, idOrName);
        if (swatch) return swatch;
      } catch {
      }
    }
    return asArray(swatches).find((swatch) => String(property(swatch, "id")) === String(idOrName) || asString(property(swatch, "name")) === String(idOrName));
  }
  function findLink(documentId, idOrName) {
    if (idOrName === void 0 || idOrName === null) return void 0;
    const document = findDocument(documentId);
    const links = property(document, "links");
    const byName = property(links, "itemByName");
    if (byName && typeof idOrName === "string") {
      try {
        const link = byName.call(links, idOrName);
        if (link) return link;
      } catch {
      }
    }
    return asArray(links).find((link) => String(property(link, "id")) === String(idOrName) || asString(property(link, "name")) === String(idOrName));
  }
  async function swatchAddColor(request) {
    const document = findDocument(request.args?.[0]);
    if (!document) unavailable("InDesign document");
    const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
    const name = asString(property(payload, "name")) ?? "Color";
    const colorValue = asArray(property(payload, "colorValue"));
    const properties = {
      name,
      model: property(payload, "model"),
      space: property(payload, "space"),
      colorValue
    };
    return withInDesignCommand(request, "Add color swatch", async () => {
      const colors = property(document, "colors") ?? property(document, "swatches");
      const add = property(colors, "add");
      if (add) return serializeSwatch(await maybePromise(add.call(colors, properties)));
      const swatches = asArray(property(document, "swatches"));
      const swatch = { ...properties, id: name, isValid: true, typename: "Color" };
      swatches.push(swatch);
      return serializeSwatch(swatch);
    });
  }
  async function linkUpdate(request) {
    const link = findLink(request.args?.[0], request.args?.[1]);
    if (!link) unavailable("InDesign link");
    return withInDesignCommand(request, "Update link", async () => {
      const update = property(link, "update");
      if (update) await maybePromise(update.call(link));
      return serializeLink(link);
    });
  }
  async function linkRelink(request) {
    const link = findLink(request.args?.[0], request.args?.[1]);
    if (!link) unavailable("InDesign link");
    const path = asString(request.args?.[2]);
    if (!path) unavailable("InDesign relink path");
    return withInDesignCommand(request, "Relink asset", async () => {
      const relink = property(link, "relink");
      if (!relink) unavailable("InDesign link.relink");
      await maybePromise(relink.call(link, fileReference(path)));
      return serializeLink(link);
    });
  }
  async function documentExportFile(request) {
    const payload = requestPayload(request);
    const document = findDocument(property(payload, "id") ?? request.args?.[0]);
    if (!document) unavailable("InDesign document");
    const format = property(payload, "format") ?? request.args?.[1];
    const path = asString(property(payload, "path") ?? request.args?.[2]);
    if (!path) unavailable("InDesign export path");
    const rawExportOptions = property(payload, "options");
    const exportOptions = isObject(rawExportOptions) ? rawExportOptions : {};
    return withInDesignCommand(request, "Export document", async () => {
      const exportFile = property(document, "exportFile");
      if (!exportFile) unavailable("InDesign document.exportFile");
      const showingOptions = property(payload, "showingOptions") === true || property(exportOptions, "showingOptions") === true;
      const using = property(payload, "preset") ?? property(exportOptions, "preset") ?? (Object.keys(exportOptions).length ? exportOptions : void 0);
      await maybePromise(exportFile.call(document, format, fileReference(path), showingOptions, using));
      return serializeDocument(document);
    });
  }
  async function documentPackageForPrint(request) {
    const payload = requestPayload(request);
    const document = findDocument(property(payload, "id") ?? request.args?.[0]);
    if (!document) unavailable("InDesign document");
    const path = asString(property(payload, "path") ?? request.args?.[1]);
    if (!path) unavailable("InDesign package path");
    const options = isObject(property(payload, "options")) ? property(payload, "options") : {};
    return withInDesignCommand(request, "Package document", async () => {
      const packageForPrint = property(document, "packageForPrint");
      if (!packageForPrint) unavailable("InDesign document.packageForPrint");
      const result = await maybePromise(
        packageForPrint.call(
          document,
          fileReference(path),
          optionBool(options, "copyingFonts", true),
          optionBool(options, "copyingLinkedGraphics", true),
          optionBool(options, "copyingProfiles", true),
          optionBool(options, "updatingGraphics", true),
          optionBool(options, "includingHiddenLayers", true),
          optionBool(options, "ignorePreflightErrors", false),
          optionBool(options, "creatingReport", true),
          optionBool(options, "includeIdml", false),
          optionBool(options, "includePdf", false),
          asString(property(options, "pdfStyle")) ?? "",
          optionBool(options, "useDocumentHyphenationExceptionsOnly", false),
          asString(property(options, "versionComments")) ?? "",
          optionBool(options, "forceSave", false)
        )
      );
      return { ok: result !== false, path, document: serializeDocument(document) };
    });
  }
  function requestPayload(request) {
    const payload = request.args?.[0];
    return isObject(payload) ? payload : {};
  }
  function optionBool(options, key, fallback) {
    const value = property(options, key);
    return typeof value === "boolean" ? value : fallback;
  }
  function fileReference(path) {
    const fileCtor = globalThis.File;
    if (fileCtor) return new fileCtor(path);
    return toFileUrl(path);
  }
  async function styleSetProperties(request, collectionName, serializer, defaultCommandName) {
    const style = findStyle(request.args?.[0], collectionName, request.args?.[1]);
    if (!style) unavailable(`InDesign ${collectionName}`);
    const properties = isObject(request.args?.[2]) ? request.args?.[2] : {};
    return withInDesignCommand(request, defaultCommandName, async () => {
      for (const [key, value] of Object.entries(properties)) {
        style[key] = value;
      }
      return serializer(style);
    });
  }
  async function withInDesignCommand(request, defaultCommandName, work) {
    const options = request.options ?? {};
    const shouldNameCommand = options.modal === true || typeof options.commandName === "string";
    const doScript = property(indesignApp(), "doScript");
    if (!shouldNameCommand || !doScript) return work();
    const commandName = asString(options.commandName) ?? defaultCommandName;
    return maybePromise(doScript.call(indesignApp(), () => work(), void 0, void 0, void 0, commandName));
  }
  function scalarValue(value) {
    if (isObject(value)) {
      const valueOf = property(value, "valueOf");
      if (valueOf) {
        try {
          const converted = valueOf.call(value);
          if (!isObject(converted)) return converted;
        } catch {
          return value;
        }
      }
      return asString(property(value, "name")) ?? property(value, "id") ?? value;
    }
    return value;
  }

  // bridges/uxp/indesign/src/main.ts
  connectBridge(indesignAdapter);
})();
//# sourceMappingURL=main.js.map
