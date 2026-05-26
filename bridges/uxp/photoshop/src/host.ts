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

const FILTER_METHOD_PREFIX = "apply";

const EXPORT_PRESETS = [
  {
    name: "png",
    format: "png",
    asCopy: true,
    options: { compression: 6 },
    description: "PNG copy with balanced compression."
  },
  {
    name: "png_small",
    format: "png",
    asCopy: true,
    options: { compression: 9 },
    description: "PNG copy with maximum compression."
  },
  {
    name: "jpg_high",
    format: "jpg",
    asCopy: true,
    options: { quality: 12 },
    description: "High quality JPEG copy."
  },
  {
    name: "jpg_medium",
    format: "jpg",
    asCopy: true,
    options: { quality: 8 },
    description: "Medium quality JPEG copy."
  },
  {
    name: "psd_copy",
    format: "psd",
    asCopy: true,
    options: { embedColorProfile: true },
    description: "Layer-preserving Photoshop copy."
  }
];

export const photoshopAdapter: HostAdapter = {
  capabilities() {
    return {
      host: "photoshop",
      bridgeKind: "uxp",
      bridgeVersion: "0.1.0",
      hostVersion: photoshopVersion(),
      namespaces: ["app", "document", "layer", "selection", "channel", "text", "filter", "smartObject", "export", "action", "raw"],
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
        text: [
          "getActive",
          "getByLayerId",
          "setContents",
          "setCharacterStyle",
          "setParagraphStyle",
          "setTextClickPoint",
          "setOrientation",
          "resetCharacterStyle",
          "convertToParagraphText",
          "convertToPointText",
          "convertToShape",
          "createWorkPath"
        ],
        filter: ["apply", "applyGaussianBlur", "applyHighPass", "applySharpen", "applySmartBlur"],
        smartObject: ["convertToSmartObject", "newSmartObjectViaCopy", "editContents", "replaceContents"],
        export: ["getPresets", "exportWithPreset"],
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
    if (request.namespace === "text" && request.method === "getActive") return serializeTextItem(textItemForLayer(undefined));
    if (request.namespace === "text" && request.method === "getByLayerId") return serializeTextItem(textItemForLayer(request.args?.[0]));
    if (request.namespace === "text" && request.method === "setContents") return textSetProperty(request, "contents", request.args?.[1], "Set text contents");
    if (request.namespace === "text" && request.method === "setTextClickPoint") {
      return textSetProperty(request, "textClickPoint", request.args?.[1], "Set text click point");
    }
    if (request.namespace === "text" && request.method === "setOrientation") return textSetProperty(request, "orientation", request.args?.[1], "Set text orientation");
    if (request.namespace === "text" && request.method === "setCharacterStyle") return textSetNestedProperties(request, "characterStyle", request.args?.[1], "Set character style");
    if (request.namespace === "text" && request.method === "setParagraphStyle") return textSetNestedProperties(request, "paragraphStyle", request.args?.[1], "Set paragraph style");
    if (request.namespace === "text" && request.method === "resetCharacterStyle") return textCallNested(request, "characterStyle", "reset", "Reset character style");
    if (request.namespace === "text" && request.method === "convertToParagraphText") return textCall(request, "convertToParagraphText", "Convert to paragraph text");
    if (request.namespace === "text" && request.method === "convertToPointText") return textCall(request, "convertToPointText", "Convert to point text");
    if (request.namespace === "text" && request.method === "convertToShape") return textCall(request, "convertToShape", "Convert text to shape");
    if (request.namespace === "text" && request.method === "createWorkPath") return textCall(request, "createWorkPath", "Create text work path");
    if (request.namespace === "filter" && request.method === "apply") return layerFilterCall(request, filterMethodName(request.args?.[1]), request.args?.slice(2) ?? []);
    if (request.namespace === "filter" && request.method === "applyGaussianBlur") {
      return layerFilterCall(request, "applyGaussianBlur", request.args?.slice(1) ?? [], "Apply Gaussian blur");
    }
    if (request.namespace === "filter" && request.method === "applyHighPass") {
      return layerFilterCall(request, "applyHighPass", request.args?.slice(1) ?? [], "Apply high pass");
    }
    if (request.namespace === "filter" && request.method === "applySharpen") return layerFilterCall(request, "applySharpen", request.args?.slice(1) ?? [], "Apply sharpen");
    if (request.namespace === "filter" && request.method === "applySmartBlur") {
      return layerFilterCall(request, "applySmartBlur", request.args?.slice(1) ?? [], "Apply smart blur");
    }
    if (request.namespace === "smartObject" && request.method === "convertToSmartObject") return smartObjectConvert(request);
    if (request.namespace === "smartObject" && request.method === "newSmartObjectViaCopy") return smartObjectBatchPlay(request, [{ _obj: "placedLayerMakeCopy" }], "New smart object via copy");
    if (request.namespace === "smartObject" && request.method === "editContents") return smartObjectBatchPlay(request, [{ _obj: "placedLayerEditContents" }], "Edit smart object contents");
    if (request.namespace === "smartObject" && request.method === "replaceContents") return smartObjectReplaceContents(request);
    if (request.namespace === "export" && request.method === "getPresets") return EXPORT_PRESETS.map(serializeExportPreset);
    if (request.namespace === "export" && request.method === "exportWithPreset") return exportWithPreset(request);
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
    hasChildren: asArray(property(layer, "layers")).length > 0,
    isSmartObject: isSmartObjectLayer(layer)
  };
}

function serializeExportPreset(preset: (typeof EXPORT_PRESETS)[number]) {
  return {
    name: preset.name,
    format: preset.format,
    asCopy: preset.asCopy,
    options: { ...preset.options },
    description: preset.description
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

function serializeTextItem(textItem: unknown, layer?: unknown) {
  if (!isObject(textItem)) return null;
  return {
    layerId: property(layer, "id") ?? property(property(textItem, "parent"), "id"),
    contents: asString(property(textItem, "contents")),
    isParagraphText: property(textItem, "isParagraphText"),
    isPointText: property(textItem, "isPointText"),
    orientation: asString(property(textItem, "orientation")) ?? property(textItem, "orientation"),
    textClickPoint: serializePoint(property(textItem, "textClickPoint")),
    typename: asString(property(textItem, "typename")),
    characterStyle: serializeStyle(property(textItem, "characterStyle"), CHARACTER_STYLE_KEYS),
    paragraphStyle: serializeStyle(property(textItem, "paragraphStyle"), PARAGRAPH_STYLE_KEYS)
  };
}

function serializePoint(point: unknown) {
  if (!isObject(point)) return null;
  return {
    x: scalarValue(property(point, "x")),
    y: scalarValue(property(point, "y"))
  };
}

const CHARACTER_STYLE_KEYS = [
  "font",
  "size",
  "leading",
  "tracking",
  "baselineShift",
  "horizontalScale",
  "verticalScale",
  "autoKerning",
  "antiAliasMethod",
  "capitalization",
  "underline",
  "strikeThrough",
  "fauxBold",
  "fauxItalic",
  "allCaps",
  "smallCaps",
  "noBreak",
  "color"
];

const PARAGRAPH_STYLE_KEYS = [
  "justification",
  "firstLineIndent",
  "startIndent",
  "endIndent",
  "spaceBefore",
  "spaceAfter",
  "hyphenation",
  "kashidaWidth",
  "kinsoku",
  "mojikumi"
];

function serializeStyle(style: unknown, keys: string[]) {
  if (!isObject(style)) return null;
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    try {
      const value = property(style, key);
      if (value !== undefined && typeof value !== "function") output[key] = serializeDomValue(value, 1);
    } catch {
      // Some style getters can throw depending on text engine support; skip unavailable fields.
    }
  }
  return output;
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

async function textSetProperty(request: RpcRequest, key: string, value: unknown, defaultCommandName: string) {
  const textItem = requiredTextItem(request.args?.[0]);
  return withModal(request, defaultCommandName, async () => {
    (textItem as Record<string, unknown>)[key] = value;
    return serializeTextItem(textItem, findLayer(request.args?.[0]));
  });
}

async function textSetNestedProperties(request: RpcRequest, styleName: string, properties: unknown, defaultCommandName: string) {
  const textItem = requiredTextItem(request.args?.[0]);
  const style = property(textItem, styleName);
  if (!isObject(style)) unavailable(`Photoshop textItem.${styleName}`);
  return withModal(request, defaultCommandName, async () => {
    for (const [key, value] of Object.entries(isObject(properties) ? properties : {})) {
      (style as Record<string, unknown>)[key] = value;
    }
    return serializeTextItem(textItem, findLayer(request.args?.[0]));
  });
}

async function textCall(request: RpcRequest, method: string, defaultCommandName: string) {
  const textItem = requiredTextItem(request.args?.[0]);
  const fn = property<Callable>(textItem, method);
  if (!fn) unavailable(`Photoshop textItem.${method}`);
  return withModal(request, defaultCommandName, async () => {
    const result = await maybePromise(fn.call(textItem));
    return serializeTextItem(isObject(result) ? result : textItem, findLayer(request.args?.[0]));
  });
}

async function textCallNested(request: RpcRequest, styleName: string, method: string, defaultCommandName: string) {
  const textItem = requiredTextItem(request.args?.[0]);
  const style = property(textItem, styleName);
  const fn = property<Callable>(style, method);
  if (!fn) unavailable(`Photoshop textItem.${styleName}.${method}`);
  return withModal(request, defaultCommandName, async () => {
    const result = await maybePromise(fn.call(style));
    return serializeTextItem(isObject(result) ? result : textItem, findLayer(request.args?.[0]));
  });
}

async function layerFilterCall(request: RpcRequest, method: string, args: unknown[], defaultCommandName?: string) {
  const layer = findLayer(request.args?.[0]);
  if (!layer) unavailable("Photoshop layer");
  const fn = property<Callable>(layer, method);
  if (!fn) unavailable(`Photoshop layer.${method}`);
  return withModal(request, defaultCommandName ?? `Apply ${method}`, async () => {
    const result = await maybePromise(fn.apply(layer, args));
    return serializeLayer(isObject(result) ? result : layer);
  });
}

function filterMethodName(value: unknown): string {
  const method = asString(value);
  if (!method || !method.startsWith(FILTER_METHOD_PREFIX)) unavailable("Photoshop layer filter method");
  return method;
}

async function smartObjectConvert(request: RpcRequest) {
  return smartObjectBatchPlay(request, [{ _obj: "newPlacedLayer" }], "Convert to smart object");
}

async function smartObjectReplaceContents(request: RpcRequest) {
  const path = asString(request.args?.[1]);
  if (!path) unavailable("Photoshop smart object replacement path");
  const layerId = request.args?.[0];
  const descriptor: Record<string, unknown> = {
    _obj: "placedLayerReplaceContents",
    null: await actionFileReference(path)
  };
  const numericLayerId = asNumber(layerId);
  if (numericLayerId !== undefined) descriptor.layerID = numericLayerId;
  return smartObjectBatchPlay(request, [descriptor], "Replace smart object contents");
}

async function smartObjectBatchPlay(request: RpcRequest, descriptors: Record<string, unknown>[], defaultCommandName: string) {
  const layer = findLayer(request.args?.[0]);
  if (!layer) unavailable("Photoshop layer");
  const layerId = property(layer, "id") ?? request.args?.[0];
  const commands = [selectLayerDescriptor(layerId), ...descriptors];
  await runBatchPlay(request, commands, {}, defaultCommandName);
  return serializeLayer(activeLayer() ?? layer);
}

async function exportWithPreset(request: RpcRequest) {
  const payload = requestPayload(request);
  const presetName = asString(payload.preset) ?? asString(request.args?.[1]) ?? "png";
  const preset = exportPreset(presetName);
  const options = { ...preset.options, ...(isObject(payload.options) ? payload.options : {}) };
  const saveRequest: RpcRequest = {
    ...request,
    args: [
      {
        ...payload,
        preset: preset.name,
        format: asString(payload.format) ?? preset.format,
        asCopy: typeof payload.asCopy === "boolean" ? payload.asCopy : preset.asCopy,
        options
      }
    ]
  };
  return saveDocument(saveRequest, true);
}

function exportPreset(name: string) {
  const normalized = name.toLowerCase().replace(/-/g, "_");
  const preset = EXPORT_PRESETS.find((item) => item.name === normalized || item.format === normalized);
  if (!preset) unavailable(`Photoshop export preset ${name}`);
  return preset;
}

function findLayer(id: unknown) {
  if (id === undefined || id === null) return activeLayer();
  for (const document of openDocuments()) {
    const match = findLayerInTree(property(document, "layers"), id) ?? findLayerInTree(property(document, "activeLayers"), id);
    if (match) return match;
  }
  return undefined;
}

function isSmartObjectLayer(layer: unknown): boolean {
  const kind = asString(property(layer, "kind")) ?? "";
  if (kind.toLowerCase().includes("smart")) return true;
  try {
    return property(layer, "smartObject") !== undefined;
  } catch {
    return false;
  }
}

function textItemForLayer(layerId: unknown) {
  const layer = findLayer(layerId);
  if (!layer) return undefined;
  try {
    return property(layer, "textItem");
  } catch {
    return undefined;
  }
}

function requiredTextItem(layerId: unknown) {
  const textItem = textItemForLayer(layerId);
  if (!textItem) unavailable("Photoshop layer.textItem");
  return textItem;
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
  const descriptors = request.args?.[0] ?? [];
  const actionOptions = isObject(request.args?.[1]) ? request.args?.[1] : {};
  return runBatchPlay(request, asArray(descriptors), actionOptions, "Run batchPlay");
}

async function runBatchPlay(request: RpcRequest, descriptors: unknown[], actionOptions: Record<string, unknown>, defaultCommandName: string) {
  const action = property(photoshopModule(), "action");
  const runBatchPlay = property<Callable>(action, "batchPlay");
  if (!runBatchPlay) unavailable("Photoshop action.batchPlay");
  return withModal(request, defaultCommandName, () => maybePromise(runBatchPlay.call(action, descriptors, actionOptions)));
}

function selectLayerDescriptor(layerId: unknown): Record<string, unknown> {
  return {
    _obj: "select",
    _target: [layerReference(layerId)],
    makeVisible: false
  };
}

function layerReference(layerId: unknown): Record<string, unknown> {
  const id = asNumber(layerId);
  if (id !== undefined) return { _ref: "layer", _id: id };
  const name = asString(layerId);
  if (name) return { _ref: "layer", _name: name };
  return { _ref: "layer", _enum: "ordinal", _value: "targetEnum" };
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
  const saveOptions = isObject(payload.options) ? payload.options : {};
  const saveAsCopy = typeof payload.asCopy === "boolean" ? payload.asCopy : asCopy;
  return withModal(request, saveAsCopy ? "Export document" : "Save document", async () => {
    const entry = await fileEntry(path);
    const saveAs = property(document, "saveAs");
    const saveFormat = property<Callable>(saveAs, format);
    if (saveFormat) {
      await maybePromise(saveFormat.call(saveAs, entry, saveOptions, saveAsCopy));
      return serializeDocument(document);
    }
    const directSaveAs = property<Callable>(document, "saveAs");
    if (directSaveAs) {
      await maybePromise(directSaveAs.call(document, entry, { ...saveOptions, format }, saveAsCopy));
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

async function actionFileReference(path: string) {
  const entry = await fileEntryForOpening(path);
  const localFileSystem = property(property(uxpModule(), "storage"), "localFileSystem");
  const createSessionToken = property<Callable>(localFileSystem, "createSessionToken");
  const token = createSessionToken ? await maybePromise(createSessionToken.call(localFileSystem, entry)) : path;
  return { _path: token, _kind: "local" };
}

async function fileEntryForOpening(path: string) {
  const localFileSystem = property(property(uxpModule(), "storage"), "localFileSystem");
  const getEntryWithUrl = property<Callable>(localFileSystem, "getEntryWithUrl");
  if (getEntryWithUrl) {
    try {
      return await maybePromise(getEntryWithUrl.call(localFileSystem, toFileUrl(path)));
    } catch {
      // If direct URL access is unavailable, fall through to Photoshop's picker-backed opening API.
    }
  }
  const getFileForOpening = property<Callable>(localFileSystem, "getFileForOpening");
  if (getFileForOpening) return await maybePromise(getFileForOpening.call(localFileSystem));
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
