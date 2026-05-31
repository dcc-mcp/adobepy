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
  aeComp.numLayers = aeLayers.length;
  aeComp.selectedLayers = [aeTextLayer];
  aeComp.layer = (index) => aeLayers[index - 1];
  const aeProject = {
    file: { name: "demo.aep", fsName: "C:/demo.aep" },
    numItems: aeItems.length,
    activeItem: aeComp,
    item(index) {
      return aeItems[index - 1];
    },
  };
  const ae = loadDispatcher(afterEffectsDispatcherPath, {
    app: { version: "24.4.1", project: aeProject },
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
  assert.strictEqual(dispatch(ae, "ae_raw", "raw", "evalExtendScript", ["app.version"]).result, "24.4.1");
  assert.strictEqual(dispatch(ae, "ae_missing", "layer", "getActive").error.code, -32601);

  const ai = loadDispatcher(illustratorDispatcherPath, {
    app: {
      version: "28.2.0",
      documents: { length: 1 },
      activeDocument: { name: "poster.ai", fullName: { fsName: "C:/poster.ai" }, width: 800, height: 600 },
    },
  });
  assert.deepStrictEqual(dispatch(ai, "ai_app", "app", "getVersion").result, "28.2.0");
  assert.deepStrictEqual(dispatch(ai, "ai_doc", "document", "getActive").result, { name: "poster.ai", path: "C:/poster.ai", width: 800, height: 600 });
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
