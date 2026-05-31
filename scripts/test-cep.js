#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const bundlePath = path.join(root, "bridges", "cep", "after-effects", "dist", "main.js");
const afterEffectsDispatcherPath = path.join(root, "bridges", "cep", "after-effects", "host", "dispatcher.jsx");
const illustratorDispatcherPath = path.join(root, "bridges", "cep", "illustrator", "host", "dispatcher.jsx");

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function main() {
  assert.ok(fs.existsSync(bundlePath), `missing CEP bundle: ${bundlePath}`);
  const sent = [];
  const evalScripts = [];
  let socketInstance = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      socketInstance = this;
      setImmediate(() => this.emit("open", {}));
    }
    addEventListener(name, listener) {
      this.listeners[name] = this.listeners[name] || [];
      this.listeners[name].push(listener);
    }
    send(payload) {
      sent.push(JSON.parse(payload));
    }
    emit(name, event) {
      for (const listener of this.listeners[name] || []) listener(event);
    }
  }

  class FakeCSInterface {
    evalScript(script, callback) {
      evalScripts.push(script);
      const match = script.match(/^adobepyDispatch\(decodeURIComponent\('([^']*)'\)\)$/);
      assert.ok(match, `unexpected evalScript payload: ${script}`);
      const request = JSON.parse(decodeURIComponent(match[1]));
      if (request.namespace === "bad") {
        callback(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "unsupported" } }));
        return;
      }
      if (request.namespace === "raw") {
        callback(JSON.stringify({ jsonrpc: "2.0", id: request.id }));
      } else {
        callback(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { namespace: request.namespace } }));
      }
    }
  }

  const context = {
    console,
    setTimeout,
    setImmediate,
    WebSocket: FakeWebSocket,
    CSInterface: FakeCSInterface,
    document: { getElementById() { return { textContent: "", addEventListener() {} }; } },
    __ADOBEPY_TOKEN: "test-token",
    __ADOBEPY_BROKER_URL: "ws://127.0.0.1:47391/v1/bridge/after-effects/ws",
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(bundlePath, "utf8"), context, { filename: bundlePath });
  await waitForMicrotasks();

  assert.ok(socketInstance);
  assert.strictEqual(sent[0].type, "hello");
  assert.strictEqual(sent[0].capabilities.host, "after-effects");
  assert.deepStrictEqual(sent[0].capabilities.methods.raw, ["evalExtendScript"]);

  socketInstance.emit("message", { data: JSON.stringify({ type: "request", request: { jsonrpc: "2.0", id: "broker_1", host: "after-effects", namespace: "app", method: "getVersion", args: ["quote '"] } }) });
  await waitForMicrotasks();
  assert.strictEqual(sent[1].response.id, "broker_1");
  assert.ok(evalScripts[0].includes("%27"));

  socketInstance.emit("message", { data: JSON.stringify({ type: "request", request: { jsonrpc: "2.0", id: "broker_2", host: "after-effects", namespace: "raw", method: "evalExtendScript", args: ["undefined"] } }) });
  await waitForMicrotasks();
  assert.strictEqual(sent[2].response.result, null);

  socketInstance.emit("message", { data: JSON.stringify({ type: "request", request: { jsonrpc: "2.0", id: "broker_3", host: "after-effects", namespace: "bad", method: "missing", args: [] } }) });
  await waitForMicrotasks();
  assert.strictEqual(sent[3].type, "error");
  assert.strictEqual(sent[3].error.error.code, -32601);

  testExtendScriptDispatchers();
  console.log("CEP bridge protocol test passed");
}

function testExtendScriptDispatchers() {
  const aeFolder = { id: 3, name: "Plates", typeName: "Folder", numItems: 1, selected: false };
  const aeComp = {
    id: 1,
    name: "Main Comp",
    typeName: "Composition",
    width: 1920,
    height: 1080,
    duration: 12.5,
    frameRate: 24,
    numLayers: 3,
    workAreaStart: 0,
    workAreaDuration: 10,
    selected: true,
  };
  const aeTextDocument = {
    text: "Hello",
    font: "ArialMT",
    fontSize: 48,
    fillColor: [1, 1, 1],
    strokeColor: [0, 0, 0],
    tracking: 10,
    justification: "center",
  };
  const aeTextProperty = {
    value: aeTextDocument,
    setValue(value) {
      this.value = value;
    },
  };
  const aeTextGroup = {
    property(name) {
      return name === "ADBE Text Document" ? aeTextProperty : null;
    },
  };
  const aeMask = {
    id: "mask-1",
    name: "Mask 1",
    maskMode: "add",
    inverted: false,
    locked: false,
    rotoBezier: true,
    property(name) {
      return {
        "ADBE Mask Opacity": { value: 100 },
        "ADBE Mask Feather": { value: [2, 2] },
        "ADBE Mask Expansion": { value: 0 },
      }[name] || null;
    },
  };
  const aeMaskGroup = {
    numProperties: 1,
    property(index) {
      return index === 1 ? aeMask : null;
    },
  };
  const aeEffect = {
    id: "fx-1",
    name: "Gaussian Blur",
    matchName: "ADBE Gaussian Blur 2",
    enabled: true,
    active: true,
    selected: false,
    numProperties: 2,
  };
  const aeEffectGroup = {
    numProperties: 1,
    property(index) {
      return index === 1 ? aeEffect : null;
    },
  };
  const aeTextLayer = {
    id: 11,
    index: 1,
    name: "Title",
    typeName: "TextLayer",
    selected: true,
    enabled: true,
    solo: false,
    locked: false,
    shy: false,
    startTime: 0,
    inPoint: 0,
    outPoint: 12.5,
    stretch: 100,
    width: 1920,
    height: 1080,
    hasVideo: true,
    hasAudio: false,
    property(name) {
      return {
        "ADBE Text Properties": aeTextGroup,
        "ADBE Mask Parade": aeMaskGroup,
        "ADBE Effect Parade": aeEffectGroup,
      }[name] || null;
    },
  };
  const aePlateLayer = {
    ...aeTextLayer,
    id: 12,
    index: 2,
    name: "Plate",
    typeName: "AVLayer",
    selected: false,
    source: { id: 2, name: "plate.mov" },
    property(name) {
      return name === "ADBE Effect Parade" ? aeEffectGroup : null;
    },
  };
  const aeFootage = {
    id: 2,
    name: "plate.mov",
    typeName: "Footage",
    width: 1920,
    height: 1080,
    duration: 12.5,
    frameRate: 24,
    hasVideo: true,
    hasAudio: false,
    parentFolder: aeFolder,
    mainSource: { file: { fsName: "C:/plates/plate.mov" }, missingFootage: false },
    selected: false,
  };
  const aeItems = [aeComp, aeFootage, aeFolder];
  const aeLayers = [aeTextLayer, aePlateLayer];
  const aeOutputModule = {
    name: "Lossless",
    file: { fsName: "C:/renders/Main Comp.mov", fullName: "C:/renders/Main Comp.mov", name: "Main Comp.mov" },
    includeSourceXMP: true,
    postRenderAction: "NONE",
    templates: ["Lossless", "H.264"],
    settings: { Format: "QuickTime" },
    applyTemplate(name) {
      this.name = name;
    },
    getSettings() {
      return this.settings;
    },
    setSettings(settings) {
      this.settings = settings;
      const outputInfo = settings["Output File Info"];
      if (outputInfo && outputInfo["Full Flat Path"]) {
        this.file = { fsName: outputInfo["Full Flat Path"], fullName: outputInfo["Full Flat Path"], name: outputInfo["Full Flat Path"].split(/[\\/]/).pop() };
      }
    },
    saveAsTemplate(name) {
      this.templates.push(name);
    },
  };
  const aeRenderQueueItems = [];
  function createRenderQueueItem(comp) {
    const item = {
      id: `rq-${aeRenderQueueItems.length + 1}`,
      index: aeRenderQueueItems.length + 1,
      comp,
      elapsedSeconds: null,
      outputModules: { length: 1 },
      queueItemNotify: false,
      render: true,
      skipFrames: 0,
      status: "QUEUED",
      templates: ["Best Settings"],
      timeSpanStart: 0,
      timeSpanDuration: comp.duration,
      settings: { Quality: "Best" },
      applyTemplate(name) {
        this.settings = { template: name };
      },
      getSettings() {
        return this.settings;
      },
      setSettings(settings) {
        this.settings = settings;
      },
      outputModule(index) {
        return index === 1 ? aeOutputModule : null;
      },
    };
    aeRenderQueueItems.push(item);
    return item;
  }
  createRenderQueueItem(aeComp);
  const aeRenderQueue = {
    canQueueInAME: true,
    queueNotify: false,
    rendering: false,
    get numItems() {
      return aeRenderQueueItems.length;
    },
    item(index) {
      return aeRenderQueueItems[index - 1] || null;
    },
    items: {
      add(comp) {
        return createRenderQueueItem(comp);
      },
    },
    render() {
      this.rendering = false;
    },
    pauseRendering(pause) {
      this.rendering = Boolean(pause);
    },
    stopRendering() {
      this.rendering = false;
    },
    showWindow() {},
    queueInAME() {},
  };
  aeComp.numLayers = aeLayers.length;
  aeComp.selectedLayers = [aeTextLayer];
  aeComp.layer = (index) => aeLayers[index - 1];
  const aeProject = {
    file: { name: "demo.aep", fsName: "C:/demo.aep" },
    numItems: aeItems.length,
    activeItem: aeComp,
    renderQueue: aeRenderQueue,
    item(index) {
      return aeItems[index - 1];
    },
  };
  const ae = loadDispatcher(afterEffectsDispatcherPath, {
    app: { version: "24.4.1", project: aeProject },
    File: function File(filePath) {
      return { fsName: filePath, fullName: filePath, name: String(filePath).split(/[\\/]/).pop() };
    },
    GetSettingsFormat: { STRING: "STRING", STRING_SETTABLE: "STRING_SETTABLE", NUMBER: "NUMBER", NUMBER_SETTABLE: "NUMBER_SETTABLE" },
  });
  assert.deepStrictEqual(dispatch(ae, "ae_app", "app", "getVersion").result, "24.4.1");
  assert.deepStrictEqual(dispatch(ae, "ae_project", "project", "getActive").result, { name: "demo.aep", path: "C:/demo.aep", itemCount: 3 });
  assert.strictEqual(dispatch(ae, "ae_items", "project", "getItems").result[0].itemType, "composition");
  assert.strictEqual(dispatch(ae, "ae_comps", "project", "getCompositions").result[0].numLayers, 2);
  assert.strictEqual(dispatch(ae, "ae_footage", "project", "getFootageItems").result[0].filePath, "C:/plates/plate.mov");
  assert.strictEqual(dispatch(ae, "ae_folders", "project", "getFolders").result[0].itemCount, 1);
  assert.strictEqual(dispatch(ae, "ae_active_item", "project", "getActiveItem").result.isActive, true);
  assert.strictEqual(dispatch(ae, "ae_selected", "project", "getSelectedItems").result[0].name, "Main Comp");
  assert.strictEqual(dispatch(ae, "ae_by_id", "item", "getById", [2]).result.name, "plate.mov");
  assert.strictEqual(dispatch(ae, "ae_by_name", "item", "getByName", ["Main Comp"]).result[0].id, 1);
  assert.strictEqual(dispatch(ae, "ae_layers", "layer", "getLayers", [1]).result[0].layerType, "text");
  assert.strictEqual(dispatch(ae, "ae_selected_layers", "layer", "getSelected", [1]).result[0].name, "Title");
  assert.strictEqual(dispatch(ae, "ae_layer_by_id", "layer", "getById", [1, 11]).result.name, "Title");
  assert.strictEqual(dispatch(ae, "ae_masks", "mask", "getMasks", [1, 11]).result[0].maskMode, "add");
  assert.strictEqual(dispatch(ae, "ae_effects", "effect", "getEffects", [1, 11]).result[0].matchName, "ADBE Gaussian Blur 2");
  assert.strictEqual(dispatch(ae, "ae_effect_by_name", "effect", "getByName", [1, 11, "Gaussian Blur"]).result.id, "fx-1");
  assert.strictEqual(dispatch(ae, "ae_source_text", "text", "getSourceText", [1, 11]).result.text, "Hello");
  assert.strictEqual(dispatch(ae, "ae_set_text", "text", "setSourceText", [1, 11, { text: "World", fontSize: 36 }]).result.text, "World");
  assert.strictEqual(aeTextProperty.value.fontSize, 36);
  assert.strictEqual(dispatch(ae, "ae_missing_text", "text", "setSourceText", [1, 12, { text: "Nope" }]).error.code, -32004);
  assert.strictEqual(dispatch(ae, "ae_render_queue", "renderQueue", "get").result.numItems, 1);
  assert.strictEqual(dispatch(ae, "ae_render_items", "renderQueue", "getItems").result[0].compName, "Main Comp");
  assert.strictEqual(dispatch(ae, "ae_render_item", "renderQueue", "getItemByIndex", [1]).result.status, "QUEUED");
  assert.strictEqual(dispatch(ae, "ae_add_comp", "renderQueue", "addComposition", [{ comp: 1, outputPath: "C:/renders/added.mov", outputModuleTemplate: "H.264" }]).result.compId, 1);
  assert.strictEqual(aeOutputModule.file.fsName, "C:/renders/added.mov");
  assert.strictEqual(aeOutputModule.name, "H.264");
  assert.strictEqual(dispatch(ae, "ae_queue_selected", "renderQueue", "queueSelectedCompositions", [{ outputDirectory: "C:/renders/selected" }]).result[0].compName, "Main Comp");
  assert.strictEqual(dispatch(ae, "ae_rq_item_template", "renderQueueItem", "applyTemplate", [1, "Draft Settings"]).result.settings.template, "Draft Settings");
  assert.deepStrictEqual(dispatch(ae, "ae_rq_item_settings", "renderQueueItem", "setSettings", [1, { Quality: "Draft" }]).result.settings, { Quality: "Draft" });
  assert.strictEqual(dispatch(ae, "ae_rq_item_render", "renderQueueItem", "setRender", [1, false]).result.render, false);
  assert.strictEqual(dispatch(ae, "ae_rq_item_notify", "renderQueueItem", "setQueueItemNotify", [1, true]).result.queueItemNotify, true);
  assert.strictEqual(dispatch(ae, "ae_output_modules", "outputModule", "getModules", [1]).result[0].outputPath, "C:/renders/selected/added.mov");
  assert.strictEqual(dispatch(ae, "ae_output_module", "outputModule", "getByIndex", [1, 1]).result.name, "H.264");
  assert.strictEqual(dispatch(ae, "ae_output_template", "outputModule", "applyTemplate", [1, 1, "Lossless"]).result.name, "Lossless");
  assert.deepStrictEqual(dispatch(ae, "ae_output_settings", "outputModule", "setSettings", [1, 1, { Crop: true }]).result.settings, { Crop: true });
  assert.strictEqual(dispatch(ae, "ae_output_path", "outputModule", "setOutputPath", [1, 1, "C:/renders/final.mov"]).result.outputPath, "C:/renders/final.mov");
  assert.ok(dispatch(ae, "ae_output_save", "outputModule", "saveAsTemplate", [1, 1, "Review"]).result.templates.includes("Review"));
  assert.strictEqual(dispatch(ae, "ae_missing_output", "outputModule", "getByIndex", [1, 99]).result, null);
  assert.strictEqual(dispatch(ae, "ae_render", "renderQueue", "render").result.rendering, false);
  assert.strictEqual(dispatch(ae, "ae_pause", "renderQueue", "pauseRendering", [true]).result.rendering, true);
  assert.strictEqual(dispatch(ae, "ae_queue_notify", "renderQueue", "setQueueNotify", [true]).result.queueNotify, true);
  assert.strictEqual(dispatch(ae, "ae_raw", "raw", "evalExtendScript", ["app.version"]).result, "24.4.1");
  assert.strictEqual(dispatch(ae, "ae_missing", "layer", "getActive").error.code, -32601);

  const aiArtboards = [
    { name: "Artboard 1", artboardRect: [0, 500, 500, 0], rulerOrigin: [0, 0], rulerPAR: 1, showCenter: true, showCrossHairs: false, showSafeAreas: false },
    { name: "Artboard 2", artboardRect: [500, 500, 1000, 0], rulerOrigin: [0, 0], rulerPAR: 1, showCenter: false, showCrossHairs: true, showSafeAreas: true },
  ];
  aiArtboards.getActiveArtboardIndex = () => 1;
  const aiLayer = {
    name: "Artwork",
    visible: true,
    locked: false,
    printable: true,
    preview: true,
    opacity: 85,
    hasSelectedArtwork: true,
    typename: "Layer",
  };
  const aiChildLayer = {
    name: "Icons",
    visible: true,
    locked: false,
    printable: true,
    preview: true,
    opacity: 100,
    hasSelectedArtwork: false,
    typename: "Layer",
  };
  const aiPageItem = {
    uuid: "item-1",
    name: "Logo",
    typename: "PathItem",
    hidden: false,
    locked: false,
    selected: true,
    editable: true,
    sliced: false,
    position: [10, 490],
    geometricBounds: [10, 490, 110, 390],
    visibleBounds: [8, 492, 112, 388],
    controlBounds: [5, 495, 115, 385],
    width: 100,
    height: 100,
    opacity: 100,
    note: "brand",
    uRL: "https://example.com",
    layer: aiLayer,
    parent: aiLayer,
  };
  const aiPathItem = {
    ...aiPageItem,
    uuid: "path-1",
    name: "Logo Path",
    area: 1024.5,
    closed: true,
    clipping: false,
    evenodd: true,
    filled: true,
    fillColor: { typename: "RGBColor", red: 255, green: 0, blue: 0 },
    fillOverprint: false,
    stroked: true,
    strokeColor: { typename: "CMYKColor", cyan: 0, magenta: 0, yellow: 0, black: 100 },
    strokeWidth: 2,
    strokeCap: "RoundEndCap",
    strokeJoin: "RoundEndJoin",
    strokeDashes: [4, 2],
    strokeDashOffset: 1,
    strokeMiterLimit: 10,
    strokeOverprint: false,
    guides: false,
    length: 128.5,
    pathPoints: [{}, {}, {}, {}],
    selectedPathPoints: [{}, {}],
    pixelAligned: true,
    polarity: "Positive",
  };
  const aiCompoundChildPath = {
    ...aiPathItem,
    uuid: "path-2",
    name: "Compound Child",
    parent: null,
    selected: false,
    fillColor: { typename: "GrayColor", gray: 50 },
    stroked: false,
    pathPoints: [{}, {}, {}],
    selectedPathPoints: [],
  };
  const aiCompoundPathItem = {
    ...aiPageItem,
    uuid: "compound-1",
    name: "Compound Logo",
    typename: "CompoundPathItem",
    selected: true,
    note: "compound",
    pathItems: [aiCompoundChildPath],
  };
  aiCompoundChildPath.parent = aiCompoundPathItem;
  const aiPlacedItem = {
    ...aiPageItem,
    uuid: "placed-1",
    name: "Placed",
    typename: "PlacedItem",
    selected: false,
    file: { fsName: "C:/assets/logo.pdf", name: "logo.pdf" },
    boundingBox: [100, 400, 260, 240],
    matrix: { mValueA: 1, mValueD: 1, mValueTX: 0, mValueTY: 0 },
  };
  const aiRasterItem = {
    ...aiPageItem,
    uuid: "raster-1",
    name: "Raster",
    typename: "RasterItem",
    selected: true,
    file: { fsName: "C:/assets/photo.png", name: "photo.png" },
    boundingBox: [300, 300, 500, 100],
    matrix: { mValueA: 1, mValueD: 1 },
    embedded: false,
    bitsPerChannel: 8,
    channels: 4,
    colorants: ["Cyan", "Magenta", "Yellow", "Black"],
    colorizedGrayscale: false,
    imageColorSpace: "CMYK",
    overprint: true,
  };
  aiLayer.layers = [aiChildLayer];
  aiLayer.pageItems = [aiPathItem, aiCompoundPathItem, aiPlacedItem, aiRasterItem];
  aiLayer.pathItems = [aiPathItem];
  aiLayer.compoundPathItems = [aiCompoundPathItem];
  aiLayer.placedItems = [aiPlacedItem];
  aiLayer.rasterItems = [aiRasterItem];
  aiLayer.parent = { name: "poster.ai", typename: "Document" };
  aiChildLayer.layers = [];
  aiChildLayer.pageItems = [aiPathItem];
  aiChildLayer.pathItems = [aiPathItem];
  aiChildLayer.compoundPathItems = [];
  aiChildLayer.placedItems = [];
  aiChildLayer.rasterItems = [];
  aiChildLayer.parent = aiLayer;
  const aiDocument = {
    name: "poster.ai",
    fullName: { fsName: "C:/poster.ai" },
    width: 800,
    height: 600,
    artboards: aiArtboards,
    layers: [aiLayer],
    pageItems: [aiPathItem, aiCompoundPathItem, aiPlacedItem, aiRasterItem],
    pathItems: [aiPathItem],
    compoundPathItems: [aiCompoundPathItem],
    placedItems: [aiPlacedItem],
    rasterItems: [aiRasterItem],
    selection: [aiPathItem, aiCompoundPathItem, aiRasterItem],
    typename: "Document",
  };
  const ai = loadDispatcher(illustratorDispatcherPath, {
    app: {
      version: "28.2.0",
      documents: { length: 1 },
      activeDocument: aiDocument,
    },
  });
  assert.deepStrictEqual(dispatch(ai, "ai_app", "app", "getVersion").result, "28.2.0");
  assert.deepStrictEqual(dispatch(ai, "ai_doc", "document", "getActive").result, {
    name: "poster.ai",
    path: "C:/poster.ai",
    width: 800,
    height: 600,
    artboardCount: 2,
    layerCount: 1,
    pageItemCount: 4,
    pathItemCount: 1,
    compoundPathItemCount: 1,
    placedItemCount: 1,
    rasterItemCount: 1,
    selectionCount: 3,
    typename: "Document",
  });
  assert.strictEqual(dispatch(ai, "ai_artboards", "artboard", "getArtboards").result[0].name, "Artboard 1");
  assert.strictEqual(dispatch(ai, "ai_active_artboard", "artboard", "getActive").result.name, "Artboard 2");
  assert.strictEqual(dispatch(ai, "ai_active_artboard_index", "artboard", "getActiveIndex").result, 1);
  assert.strictEqual(dispatch(ai, "ai_layers", "layer", "getLayers").result[0].pageItemCount, 4);
  assert.strictEqual(dispatch(ai, "ai_layer_by_name", "layer", "getByName", ["Artwork"]).result.name, "Artwork");
  assert.strictEqual(dispatch(ai, "ai_layer_children", "layer", "getChildren", ["Artwork"]).result[0].name, "Icons");
  assert.strictEqual(dispatch(ai, "ai_page_items", "pageItem", "getPageItems").result[0].typename, "PathItem");
  assert.strictEqual(dispatch(ai, "ai_selected_items", "pageItem", "getSelected").result[0].selected, true);
  assert.strictEqual(dispatch(ai, "ai_page_item_by_name", "pageItem", "getByName", ["Logo Path"]).result.layerName, "Artwork");
  assert.strictEqual(dispatch(ai, "ai_layer_page_items", "pageItem", "getLayerItems", ["Artwork"]).result[0].name, "Logo Path");
  assert.strictEqual(dispatch(ai, "ai_path_items", "pathItem", "getPathItems").result[0].fillColor.red, 255);
  assert.strictEqual(dispatch(ai, "ai_selected_path_items", "pathItem", "getSelected").result[0].pathPointCount, 4);
  assert.strictEqual(dispatch(ai, "ai_path_item_by_name", "pathItem", "getByName", ["Logo Path"]).result.strokeWidth, 2);
  assert.strictEqual(dispatch(ai, "ai_layer_path_items", "pathItem", "getLayerItems", ["Artwork"]).result[0].strokeDashes[1], 2);
  assert.strictEqual(dispatch(ai, "ai_compound_items", "compoundPath", "getCompoundPathItems").result[0].pathItemCount, 1);
  assert.strictEqual(dispatch(ai, "ai_selected_compound_items", "compoundPath", "getSelected").result[0].name, "Compound Logo");
  assert.strictEqual(dispatch(ai, "ai_compound_by_name", "compoundPath", "getByName", ["Compound Logo"]).result.typename, "CompoundPathItem");
  assert.strictEqual(dispatch(ai, "ai_layer_compound_items", "compoundPath", "getLayerItems", ["Artwork"]).result[0].name, "Compound Logo");
  assert.strictEqual(dispatch(ai, "ai_compound_path_items", "compoundPath", "getPathItems", ["Compound Logo"]).result[0].fillColor.typename, "GrayColor");
  assert.strictEqual(dispatch(ai, "ai_placed_items", "placedItem", "getPlacedItems").result[0].filePath, "C:/assets/logo.pdf");
  assert.deepStrictEqual(dispatch(ai, "ai_selected_placed_items", "placedItem", "getSelected").result, []);
  assert.strictEqual(dispatch(ai, "ai_placed_by_name", "placedItem", "getByName", ["Placed"]).result.fileName, "logo.pdf");
  assert.strictEqual(dispatch(ai, "ai_layer_placed_items", "placedItem", "getLayerItems", ["Artwork"]).result[0].boundingBox[2], 260);
  assert.strictEqual(dispatch(ai, "ai_raster_items", "rasterItem", "getRasterItems").result[0].bitsPerChannel, 8);
  assert.strictEqual(dispatch(ai, "ai_selected_raster_items", "rasterItem", "getSelected").result[0].name, "Raster");
  assert.strictEqual(dispatch(ai, "ai_raster_by_name", "rasterItem", "getByName", ["Raster"]).result.filePath, "C:/assets/photo.png");
  assert.strictEqual(dispatch(ai, "ai_layer_raster_items", "rasterItem", "getLayerItems", ["Artwork"]).result[0].imageColorSpace, "CMYK");
  assert.strictEqual(dispatch(ai, "ai_unsupported_path_mutation", "pathItem", "setEntirePath", ["Logo Path", [[0, 0]]]).error.code, -32601);
  assert.strictEqual(dispatch(ai, "ai_raw", "raw", "evalExtendScript", ["app.version"]).result, "28.2.0");

  const aiNoDocument = loadDispatcher(illustratorDispatcherPath, { app: { version: "28.2.0", documents: { length: 0 } } });
  assert.strictEqual(dispatch(aiNoDocument, "ai_none", "document", "getActive").result, null);
}

function loadDispatcher(file, globals) {
  const context = { ...globals, JSON, String, Number };
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  assert.strictEqual(typeof context.adobepyDispatch, "function");
  return context;
}

function dispatch(context, id, namespace, method, args = []) {
  return JSON.parse(context.adobepyDispatch(JSON.stringify({ jsonrpc: "2.0", id, namespace, method, args })));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
