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
  const loadedScripts = [];
  let socketInstance = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.listeners = {};
      socketInstance = this;
      setImmediate(() => { this.readyState = 1; this.emit("open", {}); });
    }
    addEventListener(name, listener) {
      this.listeners[name] = this.listeners[name] || [];
      this.listeners[name].push(listener);
    }
    send(payload) {
      sent.push(JSON.parse(payload));
    }
    emit(name, event) {
      if (this[`on${name}`]) this[`on${name}`](event);
      for (const listener of this.listeners[name] || []) listener(event);
    }
  }

  const fakeCep = {
    getSystemPath() { return "C:/extension"; },
    evalScript(script, callback) {
      if (script.startsWith("$.evalFile(")) { loadedScripts.push(script); callback("true"); return; }
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
  };

  const context = {
    console,
    setTimeout,
    setImmediate,
    WebSocket: FakeWebSocket,
    __adobe_cep__: fakeCep,
    document: { getElementById() { return { textContent: "", addEventListener() {} }; } },
    __ADOBEPY_TOKEN: "test-token",
    __ADOBEPY_BROKER_URL: "ws://127.0.0.1:47391/v1/bridge/after-effects/ws",
  };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(bundlePath, "utf8"), context, { filename: bundlePath });
  await waitForMicrotasks();

  assert.ok(socketInstance);
  assert.ok(loadedScripts[0].includes("/dist/dom.jsx"));
  assert.ok(loadedScripts[1].includes("/host/dispatcher.jsx"));
  assert.strictEqual(sent[0].type, "hello");
  assert.strictEqual(sent[0].capabilities.host, "after-effects");
  assert.ok(sent[0].capabilities.methods.dom.includes("snapshot"));
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
  const aeTransformValues = {};
  const aeTransformKeyframes = {};
  const aeLayerMoves = [];
  const aeTransformGroup = {
    property(name) {
      return {
        setValue(value) {
          aeTransformValues[name] = value;
        },
        setValueAtTime(time, value) {
          (aeTransformKeyframes[name] ||= []).push({ time, value });
        },
      };
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
    moveToBeginning() { aeLayerMoves.push(["moveToBeginning", this.id]); },
    moveToEnd() { aeLayerMoves.push(["moveToEnd", this.id]); },
    moveBefore(target) { aeLayerMoves.push(["moveBefore", this.id, target.id]); },
    moveAfter(target) { aeLayerMoves.push(["moveAfter", this.id, target.id]); },
    property(name) {
      return {
        "ADBE Text Properties": aeTextGroup,
        "ADBE Mask Parade": aeMaskGroup,
        "ADBE Effect Parade": aeEffectGroup,
        "ADBE Transform Group": aeTransformGroup,
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
  function addAeLayer(layer) {
    layer.id ||= 10 + aeLayers.length + 1;
    layer.index = aeLayers.length + 1;
    layer.selected = false;
    layer.enabled = true;
    layer.solo = false;
    layer.locked = false;
    layer.shy = false;
    layer.startTime = 0;
    layer.inPoint = 0;
    layer.outPoint ||= aeComp.duration;
    layer.stretch = 100;
    layer.property ||= aeTextLayer.property;
    aeLayers.push(layer);
    aeComp.numLayers = aeLayers.length;
    return layer;
  }
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
  aeComp.layers = {
    addText(text) {
      return addAeLayer({ name: text, typeName: "TextLayer", width: 1920, height: 1080, hasVideo: true, hasAudio: false });
    },
    addSolid(color, name, width, height, pixelAspect, duration) {
      return addAeLayer({ name, typeName: "AVLayer", width, height, pixelAspect, duration, color, hasVideo: true, hasAudio: false });
    },
    add(item, duration) {
      return addAeLayer({ name: item.name, typeName: "AVLayer", source: item, duration, width: item.width, height: item.height, hasVideo: item.hasVideo, hasAudio: item.hasAudio });
    },
  };
  const aeProject = {
    file: { name: "demo.aep", fsName: "C:/demo.aep" },
    numItems: aeItems.length,
    activeItem: aeComp,
    renderQueue: aeRenderQueue,
    item(index) {
      return aeItems[index - 1];
    },
    importFile(importOptions) {
      const item = { ...aeFootage, id: aeItems.length + 1, name: importOptions.file.name, mainSource: { file: importOptions.file, missingFootage: false } };
      aeItems.push(item);
      this.numItems = aeItems.length;
      return item;
    },
    items: {
      addComp(name, width, height, pixelAspect, duration, frameRate) {
        const comp = { ...aeComp, id: aeItems.length + 1, name, width, height, pixelAspect, duration, frameRate, selected: false };
        aeItems.push(comp);
        aeProject.numItems = aeItems.length;
        return comp;
      },
    },
  };
  const aeApp = {
    version: "24.4.1",
    project: aeProject,
    open(file) {
      aeProject.file = file;
      return aeProject;
    },
    beginUndoGroup(name) {
      aeUndoGroups.push(["begin", name]);
    },
    endUndoGroup() {
      aeUndoGroups.push(["end"]);
    },
  };
  const aeUndoGroups = [];
  const ae = loadDispatcher(afterEffectsDispatcherPath, {
    app: aeApp,
    File: function File(filePath) {
      return { fsName: filePath, fullName: filePath, name: String(filePath).split(/[\\/]/).pop() };
    },
    ImportOptions: function ImportOptions(file) {
      this.file = file;
    },
    GetSettingsFormat: { STRING: "STRING", STRING_SETTABLE: "STRING_SETTABLE", NUMBER: "NUMBER", NUMBER_SETTABLE: "NUMBER_SETTABLE" },
  });
  assert.deepStrictEqual(dispatch(ae, "ae_app", "app", "getVersion").result, "24.4.1");
  assert.strictEqual(dispatch(ae, "ae_open", "app", "openProject", ["C:/templates/intro.aep"]).result.path, "C:/templates/intro.aep");
  assert.deepStrictEqual(dispatch(ae, "ae_project", "project", "getActive").result, { name: "intro.aep", path: "C:/templates/intro.aep", itemCount: 3 });
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
  assert.strictEqual(dispatch(ae, "ae_import", "project", "importFile", [{ path: "C:/media/logo.png" }]).result.name, "logo.png");
  assert.strictEqual(dispatch(ae, "ae_create_comp", "project", "createComposition", [{ name: "Intro", width: 1280, height: 720, duration: 5, frameRate: 30 }]).result.name, "Intro");
  assert.strictEqual(dispatch(ae, "ae_create_text", "layer", "createText", [1, { text: "DCC-MCP", name: "Headline" }]).result.name, "Headline");
  assert.strictEqual(dispatch(ae, "ae_create_solid", "layer", "createSolid", [1, { name: "Background", color: [0.1, 0.2, 0.3] }]).result.name, "Background");
  assert.strictEqual(dispatch(ae, "ae_create_footage", "layer", "createFootage", [1, { item: 2 }]).result.sourceId, 2);
  assert.strictEqual(dispatch(ae, "ae_transform", "layer", "setTransform", [1, 11, { position: [960, 540], opacity: 80 }]).result.name, "Title");
  assert.deepStrictEqual(aeTransformValues["ADBE Position"], [960, 540]);
  assert.strictEqual(dispatch(ae, "ae_keyframes", "layer", "setKeyframes", [1, 11, { property: "scale", keyframes: [{ time: 0, value: [0, 0] }, { time: 1, value: [100, 100] }] }]).result.name, "Title");
  assert.strictEqual(dispatch(ae, "ae_move_beginning", "layer", "moveToBeginning", [1, 11]).result.name, "Title");
  assert.strictEqual(dispatch(ae, "ae_move_end", "layer", "moveToEnd", [1, 11]).result.name, "Title");
  assert.strictEqual(dispatch(ae, "ae_move_before", "layer", "moveBefore", [1, 11, 12]).result.name, "Title");
  assert.strictEqual(dispatch(ae, "ae_move_after", "layer", "moveAfter", [1, 11, 12]).result.name, "Title");
  assert.deepStrictEqual(aeLayerMoves, [["moveToBeginning", 11], ["moveToEnd", 11], ["moveBefore", 11, 12], ["moveAfter", 11, 12]]);
  assert.deepStrictEqual(aeTransformKeyframes["ADBE Scale"], [{ time: 0, value: [0, 0] }, { time: 1, value: [100, 100] }]);
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

  const aeAppRef = dispatch(ae, "ae_dom_app", "dom", "root", ["app"]).result;
  const aeProjectRef = dispatch(ae, "ae_dom_project", "dom", "root", ["project"]).result;
  assert.strictEqual(dispatch(ae, "ae_dom_get_project", "dom", "get", [aeAppRef, "project"]).result.$adobepyRef, aeProjectRef.$adobepyRef);
  assert.ok(dispatch(ae, "ae_dom_project_keys", "dom", "keys", [aeProjectRef]).result.includes("importFile"));
  assert.strictEqual(dispatch(ae, "ae_dom_snapshot", "dom", "snapshot", [aeProjectRef, ["numItems"]]).result.numItems, aeProject.numItems);
  assert.strictEqual(dispatch(ae, "ae_dom_set", "dom", "set", [aeProjectRef, "label", "Automated"], { commandName: "Label project", modal: true }).result, "Automated");

  const aeGlobalRef = dispatch(ae, "ae_dom_global", "dom", "root", ["global"]).result;
  const aeFileRef = dispatch(ae, "ae_dom_file", "dom", "construct", [aeGlobalRef, "File", ["C:/media/dom.png"]]).result;
  const aeImportOptionsRef = dispatch(ae, "ae_dom_import_options", "dom", "construct", [aeGlobalRef, "ImportOptions", [aeFileRef]]).result;
  const aeImportedRef = dispatch(ae, "ae_dom_import", "dom", "call", [aeProjectRef, "importFile", [aeImportOptionsRef]], { commandName: "Import via DOM", modal: true }).result;
  assert.strictEqual(dispatch(ae, "ae_dom_imported", "dom", "snapshot", [aeImportedRef, ["name"]]).result.name, "dom.png");
  assert.ok(aeUndoGroups.some((entry) => entry[0] === "begin" && entry[1] === "Import via DOM"));
  assert.strictEqual(dispatch(ae, "ae_dom_blocked", "dom", "get", [aeGlobalRef, "Function"]).error.code, -32004);
  assert.strictEqual(dispatch(ae, "ae_dom_release", "dom", "release", [aeFileRef]).result, true);
  assert.strictEqual(dispatch(ae, "ae_dom_stale", "dom", "get", [aeFileRef, "fullName"]).error.code, -32004);
  assert.strictEqual(dispatch(ae, "ae_dom_missing", "dom", "missing", []).error.code, -32601);

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
  const aiPathMutations = [];
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
    setEntirePath(points) {
      aiPathMutations.push(["setEntirePath", points]);
      this.pathPoints = points.map(() => ({}));
    },
    translate() {
      aiPathMutations.push(["translate", Array.prototype.slice.call(arguments)]);
    },
    resize() {
      aiPathMutations.push(["resize", Array.prototype.slice.call(arguments)]);
    },
    rotate() {
      aiPathMutations.push(["rotate", Array.prototype.slice.call(arguments)]);
    },
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
  const aiTextFrame = {
    ...aiPageItem,
    uuid: "text-1",
    name: "Headline",
    typename: "TextFrame",
    selected: true,
    contents: "Hello Illustrator",
    kind: "PointText",
    orientation: "Horizontal",
    position: [120, 480],
    geometricBounds: [120, 480, 320, 430],
    visibleBounds: [118, 482, 322, 428],
    width: 200,
    height: 50,
    characters: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}],
    words: [{}, {}],
    paragraphs: [{}],
  };
  const aiStory = {
    id: "story-1",
    name: "Story 1",
    length: 17,
    textRange: { contents: "Hello Illustrator" },
    textFrames: [aiTextFrame],
    words: [{}, {}],
    paragraphs: [{}],
    typename: "Story",
  };
  const aiSwatch = {
    name: "Brand Red",
    color: { typename: "RGBColor", red: 255, green: 12, blue: 24 },
    typename: "Swatch",
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
    textFrames: [aiTextFrame],
    stories: [aiStory],
    swatches: [aiSwatch],
    selection: [aiPathItem, aiCompoundPathItem, aiRasterItem, aiTextFrame],
    typename: "Document",
    save() {
      aiExports.push({ kind: "save" });
    },
    saveAs(file, options) {
      aiExports.push({ kind: "saveAs", path: file.fsName, options });
    },
    exportFile(file, exportType, options) {
      aiExports.push({ kind: "exportFile", path: file.fsName, exportType, options });
    },
  };
  aiDocument.swatches.getByName = (name) => (name === "Brand Red" ? aiSwatch : null);
  const aiExports = [];
  const ai = loadDispatcher(illustratorDispatcherPath, {
    app: {
      version: "28.2.0",
      documents: { length: 1 },
      activeDocument: aiDocument,
    },
    File: function File(filePath) {
      return { fsName: filePath, fullName: filePath, name: String(filePath).split(/[\\/]/).pop() };
    },
    ExportType: { PNG24: "PNG24", JPEG: "JPEG", SVG: "SVG" },
    ExportOptionsPNG24: function ExportOptionsPNG24() {},
    ExportOptionsJPEG: function ExportOptionsJPEG() {},
    ExportOptionsSVG: function ExportOptionsSVG() {},
    PDFSaveOptions: function PDFSaveOptions() {},
    IllustratorSaveOptions: function IllustratorSaveOptions() {},
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
    textFrameCount: 1,
    storyCount: 1,
    swatchCount: 1,
    selectionCount: 4,
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
  assert.strictEqual(dispatch(ai, "ai_text_frames", "textFrame", "getTextFrames").result[0].contents, "Hello Illustrator");
  assert.strictEqual(dispatch(ai, "ai_selected_text_frames", "textFrame", "getSelected").result[0].characterCount, 17);
  assert.strictEqual(dispatch(ai, "ai_text_frame_by_name", "textFrame", "getByName", ["Headline"]).result.kind, "PointText");
  assert.strictEqual(dispatch(ai, "ai_set_text_frame", "textFrame", "setContents", ["Headline", "Updated"]).result.contents, "Updated");
  assert.strictEqual(aiTextFrame.contents, "Updated");
  assert.strictEqual(dispatch(ai, "ai_stories", "story", "getStories").result[0].textFrameCount, 1);
  assert.strictEqual(dispatch(ai, "ai_story_by_name", "story", "getByName", ["Story 1"]).result.contents, "Hello Illustrator");
  assert.strictEqual(dispatch(ai, "ai_swatches", "swatch", "getSwatches").result[0].color.red, 255);
  assert.strictEqual(dispatch(ai, "ai_swatch_by_name", "swatch", "getByName", ["Brand Red"]).result.colorTypename, "RGBColor");
  assert.strictEqual(dispatch(ai, "ai_save", "export", "save").result.preset, "save");
  assert.strictEqual(aiExports[0].kind, "save");
  assert.strictEqual(dispatch(ai, "ai_save_as", "export", "saveAs", [{ path: "C:/out/poster.pdf", format: "pdf", options: { preserveEditability: false } }]).result.format, "pdf");
  assert.strictEqual(aiExports[1].options.preserveEditability, false);
  assert.strictEqual(dispatch(ai, "ai_export_png", "export", "exportFile", [{ path: "C:/out/poster", format: "png24", options: { artBoardClipping: true } }]).result.options.artBoardClipping, true);
  assert.strictEqual(aiExports[2].exportType, "PNG24");
  assert.strictEqual(dispatch(ai, "ai_export_svg", "export", "exportFile", [{ path: "C:/out/poster-svg", format: "svg", options: { coordinatePrecision: 2 } }]).result.format, "svg");
  assert.strictEqual(aiExports[3].exportType, "SVG");
  assert.strictEqual(dispatch(ai, "ai_missing_export_path", "export", "exportFile", [{ format: "png24" }]).error.code, -32004);
  assert.strictEqual(dispatch(ai, "ai_set_entire_path", "pathItem", "setEntirePath", ["path-1", [[0, 0], [10, 10]]]).result.pathPointCount, 2);
  assert.deepStrictEqual(aiPathMutations[0], ["setEntirePath", [[0, 0], [10, 10]]]);
  assert.strictEqual(dispatch(ai, "ai_translate_path", "pathItem", "translate", ["path-1", { deltaX: 10, deltaY: 20, transformFillPatterns: false }]).result.name, "Logo Path");
  assert.deepStrictEqual(aiPathMutations[1], ["translate", [10, 20, undefined, false]]);
  assert.strictEqual(dispatch(ai, "ai_resize_path", "pathItem", "resize", ["path-1", { scaleX: 150, scaleY: 125, changePositions: true, changeLineWidths: 50 }]).result.name, "Logo Path");
  assert.deepStrictEqual(aiPathMutations[2], ["resize", [150, 125, true, undefined, undefined, undefined, 50]]);
  assert.strictEqual(dispatch(ai, "ai_rotate_path", "pathItem", "rotate", ["path-1", { angle: 45, changePositions: true, rotateAbout: "Transformation.CENTER" }]).result.name, "Logo Path");
  assert.deepStrictEqual(aiPathMutations[3], ["rotate", [45, true, undefined, undefined, undefined, "Transformation.CENTER"]]);
  assert.strictEqual(dispatch(ai, "ai_missing_path", "pathItem", "translate", ["missing", { deltaX: 1 }]).error.code, -32004);
  assert.strictEqual(dispatch(ai, "ai_raw", "raw", "evalExtendScript", ["app.version"]).result, "28.2.0");

  const aiDocumentRef = dispatch(ai, "ai_dom_document", "dom", "root", ["document"]).result;
  assert.strictEqual(aiDocumentRef.$adobepyType, "Document");
  const aiPaths = dispatch(ai, "ai_dom_paths", "dom", "get", [aiDocumentRef, "pathItems"]).result;
  assert.strictEqual(dispatch(ai, "ai_dom_path", "dom", "snapshot", [aiPaths[0], ["name", "strokeWidth"]]).result.name, "Logo Path");
  assert.strictEqual(dispatch(ai, "ai_dom_set", "dom", "set", [aiDocumentRef, "label", "Automated"]).result, "Automated");
  assert.strictEqual(dispatch(ai, "ai_dom_save", "dom", "call", [aiDocumentRef, "save", []], { modal: true, commandName: "Save document" }).result, null);
  const aiGlobalRef = dispatch(ai, "ai_dom_global", "dom", "root", ["global"]).result;
  const aiOptionsRef = dispatch(ai, "ai_dom_options", "dom", "construct", [aiGlobalRef, "PDFSaveOptions", []]).result;
  assert.ok(aiOptionsRef.$adobepyRef);
  assert.strictEqual(dispatch(ai, "ai_dom_blocked", "dom", "get", [aiGlobalRef, "eval"]).error.code, -32004);
  assert.strictEqual(dispatch(ai, "ai_dom_release", "dom", "release", [aiDocumentRef]).result, true);
  assert.strictEqual(dispatch(ai, "ai_dom_stale", "dom", "keys", [aiDocumentRef]).error.code, -32004);

  const aiNoDocument = loadDispatcher(illustratorDispatcherPath, { app: { version: "28.2.0", documents: { length: 0 } } });
  assert.strictEqual(dispatch(aiNoDocument, "ai_none", "document", "getActive").result, null);
  assert.strictEqual(dispatch(aiNoDocument, "ai_dom_none", "dom", "root", ["document"]).error.code, -32004);
}

function loadDispatcher(file, globals) {
  const context = { ...globals, JSON, String, Number };
  const domRuntime = path.join(path.dirname(file), "..", "dist", "dom.jsx");
  assert.ok(fs.existsSync(domRuntime), `missing CEP DOM runtime: ${domRuntime}`);
  vm.runInNewContext(fs.readFileSync(domRuntime, "utf8"), context, { filename: domRuntime });
  vm.runInNewContext(fs.readFileSync(file, "utf8"), context, { filename: file });
  assert.strictEqual(typeof context.adobepyDispatch, "function");
  return context;
}

function dispatch(context, id, namespace, method, args = [], options = undefined) {
  return JSON.parse(context.adobepyDispatch(JSON.stringify({ jsonrpc: "2.0", id, namespace, method, args, options })));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
