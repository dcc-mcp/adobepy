import { methodNotFound, unavailable } from "../../core/src/errors";
import type { HostAdapter } from "../../core/src/host-adapter";
import type { RpcRequest } from "../../core/src/protocol";
import {
  asArray,
  asNumber,
  asString,
  evalJavaScript,
  fileName,
  isObject,
  maybePromise,
  optionalRequire,
  property,
  toFileUrl
} from "../../core/src/runtime";

type Callable = (...args: unknown[]) => unknown;

export const photoshopAdapter: HostAdapter = {
  capabilities() {
    return {
      host: "photoshop",
      bridgeKind: "uxp",
      bridgeVersion: "0.1.0",
      hostVersion: photoshopVersion(),
      namespaces: ["app", "document", "layer", "selection", "channel", "action", "raw"],
      features: ["batchPlay", "executeAsModal"],
      methods: {
        app: ["getVersion", "getDocuments"],
        document: ["getActive", "getById", "getLayers", "getActiveLayers", "saveAs", "export"],
        layer: ["getActive", "getChildren"],
        selection: [
          "get",
          "selectAll",
          "deselect",
          "inverse",
          "selectRectangle",
          "selectEllipse",
          "selectPolygon",
          "selectRow",
          "selectColumn",
          "expand",
          "contract",
          "feather",
          "smooth",
          "grow",
          "translateBoundary",
          "save"
        ],
        channel: ["getChannels", "getActiveChannels", "getComponentChannels", "getByName", "add", "remove"],
        action: ["batchPlay"],
        raw: ["evalJs", "getPath", "callPath"]
      }
    };
  },
  async dispatch(request: RpcRequest) {
    if (request.namespace === "app" && request.method === "getVersion") return photoshopVersion();
    if (request.namespace === "app" && request.method === "getDocuments") return serializeDocuments(openDocuments());
    if (request.namespace === "document" && request.method === "getActive") return serializeDocument(activeDocument());
    if (request.namespace === "document" && request.method === "getById") return serializeDocument(findDocument(request.args?.[0]));
    if (request.namespace === "document" && request.method === "getLayers") return documentLayers(request);
    if (request.namespace === "document" && request.method === "getActiveLayers") return documentActiveLayers(request);
    if (request.namespace === "document" && request.method === "saveAs") return saveDocument(request, false);
    if (request.namespace === "document" && request.method === "export") return saveDocument(request, true);
    if (request.namespace === "layer" && request.method === "getActive") return serializeLayer(activeLayer());
    if (request.namespace === "layer" && request.method === "getChildren") return layerChildren(request);
    if (request.namespace === "selection" && request.method === "get") return selectionGet(request);
    if (request.namespace === "selection" && request.method === "selectAll") return selectionCall(request, "selectAll", [], "Select all");
    if (request.namespace === "selection" && request.method === "deselect") return selectionCall(request, "deselect", [], "Deselect");
    if (request.namespace === "selection" && request.method === "inverse") return selectionCall(request, "inverse", [], "Invert selection");
    if (request.namespace === "selection" && request.method === "selectRectangle") {
      return selectionCall(request, "selectRectangle", request.args?.slice(1) ?? [], "Select rectangle");
    }
    if (request.namespace === "selection" && request.method === "selectEllipse") {
      return selectionCall(request, "selectEllipse", request.args?.slice(1) ?? [], "Select ellipse");
    }
    if (request.namespace === "selection" && request.method === "selectPolygon") {
      return selectionCall(request, "selectPolygon", request.args?.slice(1) ?? [], "Select polygon");
    }
    if (request.namespace === "selection" && request.method === "selectRow") return selectionCall(request, "selectRow", request.args?.slice(1) ?? [], "Select row");
    if (request.namespace === "selection" && request.method === "selectColumn") return selectionCall(request, "selectColumn", request.args?.slice(1) ?? [], "Select column");
    if (request.namespace === "selection" && request.method === "expand") return selectionCall(request, "expand", request.args?.slice(1) ?? [], "Expand selection");
    if (request.namespace === "selection" && request.method === "contract") return selectionCall(request, "contract", request.args?.slice(1) ?? [], "Contract selection");
    if (request.namespace === "selection" && request.method === "feather") return selectionCall(request, "feather", request.args?.slice(1) ?? [], "Feather selection");
    if (request.namespace === "selection" && request.method === "smooth") return selectionCall(request, "smooth", request.args?.slice(1) ?? [], "Smooth selection");
    if (request.namespace === "selection" && request.method === "grow") return selectionCall(request, "grow", request.args?.slice(1) ?? [], "Grow selection");
    if (request.namespace === "selection" && request.method === "translateBoundary") {
      return selectionCall(request, "translateBoundary", request.args?.slice(1) ?? [], "Translate selection boundary");
    }
    if (request.namespace === "selection" && request.method === "save") return selectionCall(request, "save", request.args?.slice(1) ?? [], "Save selection");
    if (request.namespace === "channel" && request.method === "getChannels") return documentChannels(request, "channels");
    if (request.namespace === "channel" && request.method === "getActiveChannels") return documentChannels(request, "activeChannels");
    if (request.namespace === "channel" && request.method === "getComponentChannels") return documentChannels(request, "componentChannels");
    if (request.namespace === "channel" && request.method === "getByName") return channelByName(request);
    if (request.namespace === "channel" && request.method === "add") return channelAdd(request);
    if (request.namespace === "channel" && request.method === "remove") return channelRemove(request);
    if (request.namespace === "action" && request.method === "batchPlay") return batchPlay(request);
    if (request.namespace === "raw" && request.method === "evalJs") return evalJavaScript(asString(request.args?.[0]) ?? "", request.args?.slice(1) ?? []);
    if (request.namespace === "raw" && request.method === "getPath") return getPath(request);
    if (request.namespace === "raw" && request.method === "callPath") return callPath(request);
    methodNotFound(request.namespace, request.method);
  }
};

function photoshopModule() {
  return optionalRequire("photoshop") ?? (globalThis as { photoshop?: Record<string, unknown> }).photoshop ?? {};
}

function uxpModule() {
  return optionalRequire("uxp") ?? (globalThis as { uxp?: Record<string, unknown> }).uxp ?? {};
}

function photoshopApp() {
  return property(photoshopModule(), "app") ?? (globalThis as { app?: Record<string, unknown> }).app ?? {};
}

function photoshopVersion(): string {
  const app = photoshopApp();
  const uxp = uxpModule();
  return (
    asString(property(app, "version")) ??
    asString(property(property(uxp, "host"), "version")) ??
    asString(property(photoshopModule(), "version")) ??
    "unknown"
  );
}

function activeDocument() {
  return property(photoshopApp(), "activeDocument");
}

function openDocuments() {
  return asArray(property(photoshopApp(), "documents"));
}

function findDocument(id: unknown) {
  const active = activeDocument();
  if (id === undefined || id === null) return active;
  const match = openDocuments().find((document) => String(property(document, "id")) === String(id));
  return match ?? (String(property(active, "id")) === String(id) ? active : undefined);
}

function activeLayer() {
  const document = activeDocument();
  return asArray(property(document, "activeLayers"))[0] ?? property(document, "activeLayer");
}

function serializeDocument(document: unknown) {
  if (!isObject(document)) return null;
  return {
    id: property(document, "id"),
    name: asString(property(document, "title")) ?? asString(property(document, "name")),
    path: asString(property(property(document, "fullName"), "fsName")) ?? asString(property(document, "path")),
    width: asNumber(property(document, "width")) ?? property(document, "width"),
    height: asNumber(property(document, "height")) ?? property(document, "height"),
    resolution: asNumber(property(document, "resolution")) ?? property(document, "resolution"),
    saved: property(document, "saved"),
    mode: asString(property(document, "mode")),
    typename: asString(property(document, "typename"))
  };
}

function serializeLayer(layer: unknown) {
  if (!isObject(layer)) return null;
  return {
    id: property(layer, "id"),
    name: asString(property(layer, "name")),
    kind: asString(property(layer, "kind")),
    opacity: asNumber(property(layer, "opacity")) ?? property(layer, "opacity"),
    visible: property(layer, "visible"),
    typename: asString(property(layer, "typename")),
    hasChildren: asArray(property(layer, "layers")).length > 0
  };
}

function serializeSelection(selection: unknown) {
  if (!isObject(selection)) return null;
  return {
    bounds: serializeBounds(property(selection, "bounds")),
    docId: property(selection, "docId"),
    solid: property(selection, "solid"),
    typename: asString(property(selection, "typename"))
  };
}

function serializeBounds(bounds: unknown) {
  if (!isObject(bounds)) return null;
  return {
    top: scalarValue(property(bounds, "top")),
    left: scalarValue(property(bounds, "left")),
    bottom: scalarValue(property(bounds, "bottom")),
    right: scalarValue(property(bounds, "right"))
  };
}

function serializeChannel(channel: unknown) {
  if (!isObject(channel)) return null;
  return {
    id: property(channel, "id"),
    name: asString(property(channel, "name")),
    kind: asString(property(channel, "kind")) ?? property(channel, "kind"),
    opacity: asNumber(property(channel, "opacity")) ?? property(channel, "opacity"),
    visible: property(channel, "visible"),
    typename: asString(property(channel, "typename"))
  };
}

function serializeDocuments(documents: unknown[]) {
  return documents.map(serializeDocument).filter((document) => document !== null);
}

function serializeLayers(layers: unknown) {
  return asArray(layers).map(serializeLayer).filter((layer) => layer !== null);
}

function serializeChannels(channels: unknown) {
  return asArray(channels).map(serializeChannel).filter((channel) => channel !== null);
}

function documentLayers(request: RpcRequest) {
  const document = findDocument(request.args?.[0]);
  if (!document) return [];
  return serializeLayers(property(document, "layers"));
}

function documentActiveLayers(request: RpcRequest) {
  const document = findDocument(request.args?.[0]);
  if (!document) return [];
  return serializeLayers(property(document, "activeLayers"));
}

function layerChildren(request: RpcRequest) {
  const layer = findLayer(request.args?.[0]);
  if (!layer) return [];
  return serializeLayers(property(layer, "layers"));
}

function selectionGet(request: RpcRequest) {
  const selection = selectionForDocument(request.args?.[0]);
  return serializeSelection(selection);
}

async function selectionCall(request: RpcRequest, method: string, args: unknown[], defaultCommandName: string) {
  const selection = selectionForDocument(request.args?.[0]);
  const fn = property<Callable>(selection, method);
  if (!fn) unavailable(`Photoshop selection.${method}`);
  return withModal(request, defaultCommandName, async () => {
    await maybePromise(fn.apply(selection, args));
    return serializeSelection(selection);
  });
}

function selectionForDocument(documentId: unknown) {
  const document = findDocument(documentId);
  if (!document) unavailable("Photoshop document selection");
  const selection = property(document, "selection");
  if (!selection) unavailable("Photoshop document.selection");
  return selection;
}

function documentChannels(request: RpcRequest, collectionName: string) {
  const document = findDocument(request.args?.[0]);
  if (!document) return [];
  return serializeChannels(property(document, collectionName));
}

function channelByName(request: RpcRequest) {
  const document = findDocument(request.args?.[0]);
  if (!document) return null;
  return serializeChannel(findChannel(document, request.args?.[1]));
}

async function channelAdd(request: RpcRequest) {
  const document = findDocument(request.args?.[0]);
  if (!document) unavailable("Photoshop document channels");
  const channels = property(document, "channels");
  const add = property<Callable>(channels, "add");
  if (!add) unavailable("Photoshop channels.add");
  return withModal(request, "Add channel", async () => {
    const channel = await maybePromise(add.call(channels));
    const name = asString(request.args?.[1]);
    if (name && isObject(channel)) (channel as Record<string, unknown>).name = name;
    return serializeChannel(channel);
  });
}

async function channelRemove(request: RpcRequest) {
  const document = findDocument(request.args?.[0]);
  if (!document) unavailable("Photoshop channel");
  const channel = findChannel(document, request.args?.[1]);
  if (!channel) unavailable("Photoshop channel");
  const remove = property<Callable>(channel, "remove");
  if (!remove) unavailable("Photoshop channel.remove");
  return withModal(request, "Remove channel", async () => {
    await maybePromise(remove.call(channel));
    return serializeChannel(channel);
  });
}

function findLayer(id: unknown) {
  if (id === undefined || id === null) return activeLayer();
  for (const document of openDocuments()) {
    const match = findLayerInTree(property(document, "layers"), id) ?? findLayerInTree(property(document, "activeLayers"), id);
    if (match) return match;
  }
  return undefined;
}

function findChannel(document: unknown, idOrName: unknown) {
  if (idOrName === undefined || idOrName === null) return undefined;
  const channelCollections = [property(document, "channels"), property(document, "activeChannels"), property(document, "componentChannels")];
  for (const collection of channelCollections) {
    const getByName = property<Callable>(collection, "getByName");
    if (getByName && typeof idOrName === "string") {
      try {
        const channel = getByName.call(collection, idOrName);
        if (channel) return channel;
      } catch {
        // Some Photoshop channel collections throw when a name is missing; continue with manual matching.
      }
    }
    const match = asArray(collection).find((channel) => {
      return String(property(channel, "id")) === String(idOrName) || asString(property(channel, "name")) === String(idOrName);
    });
    if (match) return match;
  }
  return undefined;
}

function findLayerInTree(layers: unknown, id: unknown): unknown {
  for (const layer of asArray(layers)) {
    if (String(property(layer, "id")) === String(id)) return layer;
    const child = findLayerInTree(property(layer, "layers"), id);
    if (child) return child;
  }
  return undefined;
}

async function batchPlay(request: RpcRequest) {
  const action = property(photoshopModule(), "action");
  const runBatchPlay = property<Callable>(action, "batchPlay");
  if (!runBatchPlay) unavailable("Photoshop action.batchPlay");
  const descriptors = request.args?.[0] ?? [];
  const actionOptions = isObject(request.args?.[1]) ? request.args?.[1] : {};
  return withModal(request, "Run batchPlay", () => maybePromise(runBatchPlay.call(action, descriptors, actionOptions)));
}

function getPath(request: RpcRequest) {
  const path = normalizePath(request.args?.[0]);
  const depth = asNumber(request.args?.[1]) ?? 2;
  return serializeDomValue(resolvePath(path), depth);
}

async function callPath(request: RpcRequest) {
  const path = normalizePath(request.args?.[0]);
  const callArgs = asArray(request.args?.[1]);
  return withModal(request, `Call ${path.join(".")}`, async () => {
    const parentPath = path.slice(0, -1);
    const member = path[path.length - 1];
    const parent = parentPath.length ? resolvePath(parentPath) : photoshopModule();
    const fn = typeof member === "number" ? asArray(parent)[member] : property<Callable>(parent, String(member));
    if (typeof fn !== "function") unavailable(`Photoshop DOM method ${path.join(".")}`);
    return serializeDomValue(await maybePromise(fn.apply(parent, callArgs)), asNumber(request.args?.[2]) ?? 2);
  });
}

function normalizePath(path: unknown): (string | number)[] {
  return asArray(path).map((segment) => {
    const number = asNumber(segment);
    return number === undefined ? String(segment) : number;
  });
}

function resolvePath(path: (string | number)[]) {
  if (!path.length) return photoshopModule();
  let index = 0;
  let value: unknown;
  const first = path[0];
  if (first === "uxp") {
    value = uxpModule();
    index = 1;
  } else if (first === "photoshop") {
    value = photoshopModule();
    index = 1;
  } else if (first === "app") {
    value = photoshopApp();
    index = 1;
  } else {
    value = photoshopModule();
  }
  for (; index < path.length; index++) {
    const segment = path[index];
    value = typeof segment === "number" ? asArray(value)[segment] : property(value, segment);
  }
  return value;
}

function serializeDomValue(value: unknown, depth: number, seen = new WeakSet<object>()): unknown {
  const scalar = scalarValue(value);
  if (!isObject(scalar)) return scalar ?? null;
  if (seen.has(scalar)) return "[Circular]";
  seen.add(scalar);
  if (Array.isArray(scalar) || typeof (scalar as { [Symbol.iterator]?: unknown })[Symbol.iterator] === "function") {
    return asArray(scalar).map((item) => serializeDomValue(item, depth - 1, seen));
  }
  if (depth <= 0) {
    return {
      id: scalarValue(property(scalar, "id")),
      name: scalarValue(property(scalar, "name") ?? property(scalar, "title")),
      typename: scalarValue(property(scalar, "typename"))
    };
  }
  const output: Record<string, unknown> = {};
  for (const key of ["id", "name", "title", "path", "width", "height", "resolution", "saved", "typename", "kind", "opacity", "visible", "mode"]) {
    try {
      const item = property(scalar, key);
      if (item !== undefined && typeof item !== "function") output[key] = serializeDomValue(item, depth - 1, seen);
    } catch {
      // Some Photoshop DOM getters throw when unavailable; skip them in generic serialization.
    }
  }
  for (const key of ["documents", "layers", "activeLayers", "linkedLayers"]) {
    try {
      const item = property(scalar, key);
      if (item !== undefined && typeof item !== "function") output[key] = serializeDomValue(item, depth - 1, seen);
    } catch {
      // Skip unavailable collections.
    }
  }
  return output;
}

function scalarValue(value: unknown) {
  if (isObject(value)) {
    const valueOf = property<Callable>(value, "valueOf");
    if (valueOf) {
      try {
        const converted = valueOf.call(value);
        if (!isObject(converted)) return converted;
      } catch {
        return value;
      }
    }
  }
  return value;
}

async function saveDocument(request: RpcRequest, asCopy: boolean) {
  const payload = requestPayload(request);
  const document = findDocument(payload.id);
  if (!document) unavailable("Photoshop document");
  const path = asString(payload.path);
  if (!path) unavailable("Photoshop save path");
  const format = normalizeFormat(asString(payload.format) ?? "psd");
  return withModal(request, asCopy ? "Export document" : "Save document", async () => {
    const entry = await fileEntry(path);
    const saveAs = property(document, "saveAs");
    const saveFormat = property<Callable>(saveAs, format);
    if (saveFormat) {
      await maybePromise(saveFormat.call(saveAs, entry, {}, asCopy));
      return serializeDocument(document);
    }
    const directSaveAs = property<Callable>(document, "saveAs");
    if (directSaveAs) {
      await maybePromise(directSaveAs.call(document, entry, { format }, asCopy));
      return serializeDocument(document);
    }
    unavailable(`Photoshop document.saveAs.${format}`);
  });
}

function requestPayload(request: RpcRequest): Record<string, unknown> {
  const payload = request.args?.[0];
  return isObject(payload) ? payload : {};
}

function normalizeFormat(format: string): string {
  const normalized = format.toLowerCase();
  return normalized === "jpeg" ? "jpg" : normalized;
}

async function fileEntry(path: string) {
  const localFileSystem = property(property(uxpModule(), "storage"), "localFileSystem");
  const createEntryWithUrl = property<Callable>(localFileSystem, "createEntryWithUrl");
  if (createEntryWithUrl) {
    try {
      return await maybePromise(createEntryWithUrl.call(localFileSystem, toFileUrl(path), { type: "file", overwrite: true }));
    } catch {
      // Some hosts only allow picker-backed entries; fall through to getFileForSaving.
    }
  }
  const getFileForSaving = property<Callable>(localFileSystem, "getFileForSaving");
  if (getFileForSaving) return await maybePromise(getFileForSaving.call(localFileSystem, fileName(path)));
  return path;
}

async function withModal(request: RpcRequest, defaultCommandName: string, work: () => Promise<unknown>) {
  const options = request.options ?? {};
  const shouldUseModal = options.modal === true || typeof options.commandName === "string";
  if (!shouldUseModal) return work();
  const core = property(photoshopModule(), "core");
  const executeAsModal = property<Callable>(core, "executeAsModal");
  if (!executeAsModal) unavailable("Photoshop core.executeAsModal");
  const commandName = asString(options.commandName) ?? defaultCommandName;
  return await maybePromise(executeAsModal.call(core, () => work(), { commandName }));
}
