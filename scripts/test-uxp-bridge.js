#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function loadBundle(relativeBundlePath, modules, globals = {}, generatedConfig) {
  const bundlePath = path.join(root, relativeBundlePath);
  assert.ok(fs.existsSync(bundlePath), `missing UXP bundle: ${bundlePath}`);
  const sent = [];
  let socketInstance = null;

  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.listeners = {};
      this.readyState = 0;
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
      for (const listener of this.listeners[name] || []) listener(event);
    }
  }

  const context = {
    console,
    setImmediate,
    setTimeout,
    WebSocket: FakeWebSocket,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
      throw new Error(`missing test module: ${name}`);
    },
    ...(generatedConfig === undefined ? { __ADOBEPY_TOKEN: "test-token" } : {}),
    crypto: {
      randomUUID: () => "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99"
    },
    ...globals
  };
  context.globalThis = context;
  if (generatedConfig !== undefined) {
    vm.runInNewContext(generatedConfig, context, { filename: "adobepy.config.js", timeout: 1_000 });
  }
  vm.runInNewContext(fs.readFileSync(bundlePath, "utf8"), context, { filename: bundlePath });
  await waitForMicrotasks();
  assert.ok(socketInstance, "bundle did not open a WebSocket");
  return { sent, socket: socketInstance };
}

async function rpc(env, host, namespace, method, args = [], options = {}) {
  const id = `${host}_${namespace}_${method}_${env.sent.length}`;
  env.socket.emit("message", {
    data: JSON.stringify({ type: "request", request: { jsonrpc: "2.0", id, host, namespace, method, args, options } })
  });
  await waitForMicrotasks();
  return env.sent[env.sent.length - 1];
}

function result(message) {
  assert.strictEqual(message.type, "response", JSON.stringify(message));
  return message.response.result;
}

function error(message) {
  assert.strictEqual(message.type, "error");
  return message.error.error;
}

async function testPhotoshopBridge() {
  const events = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "bridges/uxp/photoshop/manifest.json"), "utf8"));
  assert.strictEqual(manifest.host.data.apiVersion, 2);
  assert.strictEqual(manifest.host.data.loadEvent, "startup");
  assert.strictEqual(manifest.requiredPermissions.localFileSystem, "fullAccess");
  let fileAccessFails = false;
  let pickerCalled = false;
  const entryRequests = [];
  const localFileSystem = {
    getPluginFolder: async () => ({ nativePath: "C:/UXP/External/com.adobepy.bridge.photoshop" }),
    createEntryWithUrl: async (url, options) => {
      entryRequests.push({ url, options });
      if (fileAccessFails) throw new Error("full access denied");
      return { url };
    },
    getFileForSaving: async () => {
      pickerCalled = true;
      return { url: "picker://unexpected" };
    },
    getEntryWithUrl: async (url) => ({ url }),
    createSessionToken: async (entry) => `token:${entry.url}`
  };
  class SolidColor {
    constructor() {
      this.typename = "SolidColor";
      this.rgb = { red: 255, green: 255, blue: 255 };
    }
  }
  const componentChannel = { id: 22, name: "Red", kind: "component", visible: true, typename: "Channel" };
  Object.defineProperty(componentChannel, "opacity", {
    get() {
      throw new Error("The operation is not valid for channels of type component.");
    }
  });
  const channels = [
    {
      id: 21,
      name: "Alpha 1",
      kind: "maskedArea",
      opacity: 50,
      visible: true,
      typename: "Channel",
      remove: async () => events.push({ kind: "channel.remove" })
    },
    componentChannel
  ];
  channels.getByName = (name) => channels.find((channel) => channel.name === name);
  channels.add = async () => {
    const channel = { id: 23, name: "Alpha 2", kind: "maskedArea", visible: true, typename: "Channel" };
    channels.push(channel);
    return channel;
  };
  const selection = {
    bounds: { top: 1, left: 2, bottom: 99, right: 100 },
    docId: 9,
    solid: true,
    typename: "Selection",
    selectRectangle: async (bounds, mode, feather, antiAlias) => {
      events.push({ kind: "selection.selectRectangle", bounds, mode, feather, antiAlias });
      selection.bounds = bounds;
      selection.solid = true;
    },
    selectAll: async () => {
      events.push({ kind: "selection.selectAll" });
      selection.bounds = { top: 0, left: 0, bottom: 1080, right: 1920 };
      selection.solid = true;
    },
    deselect: async () => {
      events.push({ kind: "selection.deselect" });
      selection.bounds = null;
      selection.solid = false;
    },
    inverse: async () => events.push({ kind: "selection.inverse" })
  };
  const textItem = {
    contents: "Hello",
    isParagraphText: false,
    isPointText: true,
    orientation: "horizontal",
    textClickPoint: { x: 11, y: 22 },
    typename: "TextItem",
    characterStyle: {
      font: "ArialMT",
      size: 24,
      tracking: 10,
      reset: async () => events.push({ kind: "text.characterStyle.reset" })
    },
    paragraphStyle: {
      justification: "left",
      hyphenation: false
    },
    convertToParagraphText: async () => {
      events.push({ kind: "text.convertToParagraphText" });
      textItem.isParagraphText = true;
      textItem.isPointText = false;
    },
    convertToPointText: async () => {
      events.push({ kind: "text.convertToPointText" });
      textItem.isParagraphText = false;
      textItem.isPointText = true;
    },
    convertToShape: async () => events.push({ kind: "text.convertToShape" }),
    createWorkPath: async () => events.push({ kind: "text.createWorkPath" })
  };
  const textLayer = {
    id: 7,
    name: "Layer 1",
    kind: "text",
    opacity: 80,
    visible: true,
    textItem,
    applyGaussianBlur: async (radius) => {
      events.push({ kind: "filter.applyGaussianBlur", radius });
    },
    applyHighPass: async (radius) => {
      events.push({ kind: "filter.applyHighPass", radius });
    },
    applySharpen: async () => {
      events.push({ kind: "filter.applySharpen" });
    },
    applySmartBlur: async (radius, threshold, quality) => {
      events.push({ kind: "filter.applySmartBlur", radius, threshold, quality });
    }
  };
  textItem.parent = textLayer;
  const document = {
    id: 9,
    title: "demo.psd",
    width: { valueOf: () => 1920 },
    height: { valueOf: () => 1080 },
    resolution: 72,
    saved: true,
    activeLayers: [textLayer],
    layers: [
      textLayer,
      { id: 8, name: "Group", kind: "group", layers: [{ id: 10, name: "Child" }] }
    ],
    selection,
    channels,
    activeChannels: [channels[0]],
    componentChannels: [channels[1]],
    saveAs: {
      psd: async (entry, options, asCopy) => events.push({ kind: "saveAs", url: entry.url, options, asCopy }),
      png: async (entry, options, asCopy) => events.push({ kind: "saveAs", url: entry.url, options, asCopy }),
      jpg: async (entry, options, asCopy) => events.push({ kind: "saveAs", url: entry.url, options, asCopy })
    }
  };
  const env = await loadBundle("bridges/uxp/photoshop/dist/main.js", {
    photoshop: {
      app: { version: "26.5.1", activeDocument: document, documents: [document], SolidColor },
      constants: {
        SelectionType: { REPLACE: 1, EXTEND: 2, DIMINISH: 3, INTERSECT: 4 }
      },
      action: {
        batchPlay: async (descriptors, options) => {
          events.push({ kind: "batchPlay", descriptors, options });
          if (descriptors.some((descriptor) => descriptor._obj === "newPlacedLayer")) textLayer.kind = "smartObject";
          if (descriptors.some((descriptor) => descriptor._obj === "fail")) {
            return [{ _obj: "error", message: "Forced batchPlay failure", result: -1 }];
          }
          return descriptors;
        }
      },
      core: {
        executeAsModal: async (target, options) => {
          events.push({ kind: "modal", commandName: options.commandName });
          return await target({});
        }
      }
    },
    uxp: {
      host: { name: "Adobe Photoshop", version: "26.5.1" },
      storage: {
        localFileSystem
      }
    }
  }, {
    __ADOBEPY_TARGET: "retouch",
    __ADOBEPY_BOOTSTRAP_NONCE: "e".repeat(64),
    __ADOBEPY_HOST_IDENTITY: {
      pid: 4200,
      processStartIdentity: "windows:133700000000000100",
      executablePath: "C:/Adobe/Photoshop.exe",
      profileId: "profile-production"
    }
  });

  assert.strictEqual(env.sent[0].type, "hello");
  assert.strictEqual(env.sent[0].target, "retouch");
  assert.strictEqual(env.sent[0].bootstrapNonce, "e".repeat(64));
  assert.strictEqual(env.sent[0].capabilities.hostVersion, "26.5.1");
  assert.deepStrictEqual(JSON.parse(JSON.stringify(env.sent[0].identity)), {
    host: {
      pid: 4200,
      processStartIdentity: "windows:133700000000000100",
      executablePath: "C:/Adobe/Photoshop.exe",
      hostVersion: "26.5.1",
      profileId: "profile-production"
    },
    bridge: {
      instanceId: "9d31eb71-26cb-4c87-8b5a-4cadcc8e2f99",
      installedPluginRoot: "C:/UXP/External/com.adobepy.bridge.photoshop",
      moduleOrigin: "C:/UXP/External/com.adobepy.bridge.photoshop/dist/main.js"
    }
  });
  assert.ok(!JSON.stringify(env.sent[0].identity).includes("test-token"));
  assert.ok(!JSON.stringify(env.sent[0]).includes("C:/not-a-bootstrap-nonce"));
  assert.ok(env.sent[0].capabilities.methods.document.includes("getLayers"));
  assert.ok(env.sent[0].capabilities.methods.selection.includes("selectRectangle"));
  assert.ok(env.sent[0].capabilities.methods.channel.includes("getChannels"));
  assert.ok(env.sent[0].capabilities.methods.text.includes("setContents"));
  assert.ok(env.sent[0].capabilities.methods.filter.includes("applyGaussianBlur"));
  assert.ok(env.sent[0].capabilities.methods.smartObject.includes("convertToSmartObject"));
  assert.ok(env.sent[0].capabilities.methods.export.includes("exportWithPreset"));
  assert.ok(env.sent[0].capabilities.methods.raw.includes("getPath"));
  assert.strictEqual(result(await rpc(env, "photoshop", "app", "getVersion")), "26.5.1");
  assert.strictEqual(result(await rpc(env, "photoshop", "app", "getDocuments"))[0].resolution, 72);
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "document", "getActive")).name, "demo.psd");
  assert.strictEqual(result(await rpc(env, "photoshop", "document", "getLayers", [9]))[1].hasChildren, true);
  assert.strictEqual(result(await rpc(env, "photoshop", "document", "getActiveLayers", [9]))[0].opacity, 80);
  assert.strictEqual(result(await rpc(env, "photoshop", "layer", "getActive")).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "layer", "getChildren", [8]))[0].name, "Child");
  assert.strictEqual(result(await rpc(env, "photoshop", "selection", "get", [9])).bounds.right, 100);
  assert.strictEqual(
    result(await rpc(env, "photoshop", "selection", "selectRectangle", [9, { top: 4, left: 5, bottom: 9, right: 10 }, null, 0, true], { modal: true })).bounds.left,
    5
  );
  assert.strictEqual(events.find((event) => event.kind === "selection.selectRectangle").mode, 1);
  assert.strictEqual(result(await rpc(env, "photoshop", "selection", "selectAll", [9], { modal: true })).bounds.bottom, 1080);
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "getChannels", [9]))[0].name, "Alpha 1");
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "getActiveChannels", [9]))[0].opacity, 50);
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "getComponentChannels", [9]))[0].name, "Red");
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "getByName", [9, "Alpha 1"])).id, 21);
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "add", [9, "Mask"], { modal: true })).name, "Mask");
  assert.strictEqual(result(await rpc(env, "photoshop", "channel", "remove", [9, 21], { modal: true })).id, 21);
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "getActive")).contents, "Hello");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "getByLayerId", [7])).characterStyle.size, 24);
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "setContents", [7, "World"], { modal: true })).contents, "World");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "setCharacterStyle", [7, { size: 36, tracking: 20 }], { modal: true })).characterStyle.size, 36);
  await rpc(env, "photoshop", "text", "setCharacterStyle", [7, { color: { rgb: { red: 77, green: 232, blue: 255 } } }], { modal: true });
  assert.ok(textItem.characterStyle.color instanceof SolidColor);
  assert.deepStrictEqual(textItem.characterStyle.color.rgb, { red: 77, green: 232, blue: 255 });
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "setParagraphStyle", [7, { justification: "center" }], { modal: true })).paragraphStyle.justification, "center");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "setTextClickPoint", [7, { x: 4, y: 5 }], { modal: true })).textClickPoint.x, 4);
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "setOrientation", [7, "vertical"], { modal: true })).orientation, "vertical");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "resetCharacterStyle", [7], { modal: true })).typename, "TextItem");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "convertToParagraphText", [7], { modal: true })).isParagraphText, true);
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "convertToPointText", [7], { modal: true })).isPointText, true);
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "convertToShape", [7], { modal: true })).typename, "TextItem");
  assert.strictEqual(result(await rpc(env, "photoshop", "text", "createWorkPath", [7], { modal: true })).typename, "TextItem");
  assert.strictEqual(result(await rpc(env, "photoshop", "filter", "applyGaussianBlur", [7, 2], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "filter", "apply", [7, "applyHighPass", 4], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "filter", "applySharpen", [7], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "filter", "applySmartBlur", [7, 3, 12, "high"], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "smartObject", "convertToSmartObject", [7], { modal: true })).isSmartObject, true);
  assert.strictEqual(result(await rpc(env, "photoshop", "smartObject", "newSmartObjectViaCopy", [7], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "smartObject", "editContents", [7], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "smartObject", "replaceContents", [7, "C:/replacement.psb"], { modal: true })).id, 7);
  assert.strictEqual(result(await rpc(env, "photoshop", "export", "getPresets"))[0].name, "png");
  const exportResult = result(await rpc(env, "photoshop", "export", "exportWithPreset", [{ id: 9, path: "C:/out.jpg", preset: "jpg_high", options: { quality: 10 } }], { modal: true }));
  assert.strictEqual(exportResult.id, 9);
  assert.strictEqual(exportResult.path, "C:/out.jpg");
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "getPath", [["app", "activeDocument", "layers", 0, "name"]], {})), "Layer 1");
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "action", "batchPlay", [[{ _obj: "hide" }], { synchronousExecution: true }], { modal: true, commandName: "Hide" })), [{ _obj: "hide" }]);
  assert.deepStrictEqual(
    result(
      await rpc(
        env,
        "photoshop",
        "action",
        "batchPlay",
        [[{ _obj: "placeEvent", null: { _path: "C:/composite.png", _kind: "local" } }], {}],
        { modal: true }
      )
    ),
    [{ _obj: "placeEvent", null: { _path: "token:file:///C:/composite.png", _kind: "local" } }]
  );
  assert.match(error(await rpc(env, "photoshop", "action", "batchPlay", [[{ _obj: "fail" }], {}], { modal: true })).message, /forced batchPlay failure/i);
  const saveResult = result(await rpc(env, "photoshop", "document", "saveAs", [{ id: 9, path: "C:/out.psd", format: "psd" }], { modal: true, commandName: "Save" }));
  assert.strictEqual(saveResult.id, 9);
  assert.strictEqual(saveResult.path, "C:/out.psd");
  const unicodeSaveResult = result(await rpc(env, "photoshop", "document", "saveAs", [{ id: 9, path: "C:/输出/卡牌 模板.psd", format: "psd" }], { modal: true, commandName: "Save Unicode" }));
  assert.strictEqual(unicodeSaveResult.id, 9);
  assert.strictEqual(unicodeSaveResult.path, "C:/输出/卡牌 模板.psd");
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "evalJs", ["1 + 1"])), 2);
  assert.strictEqual(error(await rpc(env, "photoshop", "bad", "missing")).code, -32601);
  assert.ok(events.some((event) => event.kind === "modal" && event.commandName === "Hide"));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/out.psd"));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/输出/卡牌 模板.psd"));
  assert.ok(events.some((event) => event.kind === "selection.selectRectangle"));
  assert.ok(events.some((event) => event.kind === "channel.remove"));
  assert.ok(events.some((event) => event.kind === "text.convertToShape"));
  assert.ok(events.some((event) => event.kind === "filter.applyGaussianBlur" && event.radius === 2));
  assert.ok(events.some((event) => event.kind === "batchPlay" && event.descriptors.some((descriptor) => descriptor._obj === "newPlacedLayer")));
  assert.ok(events.some((event) => event.kind === "batchPlay" && event.descriptors.some((descriptor) => descriptor._obj === "placedLayerReplaceContents")));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/out.jpg" && event.options.quality === 10));
  assert.ok(entryRequests.length >= 2);
  assert.ok(entryRequests.every((request) => request.options && request.options.overwrite === true));
  assert.ok(entryRequests.every((request) => !("type" in request.options)));

  fileAccessFails = true;
  assert.match(error(await rpc(env, "photoshop", "document", "saveAs", [{ id: 9, path: "C:/blocked.psd", format: "psd" }], { modal: true })).message, /full access/i);
  assert.strictEqual(pickerCalled, false);
}

async function testInDesignBridge() {
  const events = [];
  const document = {
    id: 3,
    name: "layout.indd",
    fullName: { fsName: "C:/layout.indd" },
    width: 800,
    height: 600,
    typename: "Document"
  };
  const spread = {
    id: 41,
    name: "Spread 1",
    label: "Spread 1",
    index: 0,
    parent: document,
    isValid: true,
    typename: "Spread"
  };
  const page1 = {
    id: 31,
    name: "1",
    index: 0,
    documentOffset: 0,
    side: "rightHand",
    bounds: [0, 0, 800, 600],
    parent: spread,
    isValid: true,
    typename: "Page",
    select(existingSelection) {
      events.push({ kind: "page.select", existingSelection });
    }
  };
  const page2 = { ...page1, id: 32, name: "2", index: 1, documentOffset: 1 };
  spread.pages = [page1, page2];
  document.pages = [page1, page2];
  document.pages.itemByName = (name) => document.pages.find((page) => page.name === name);
  document.spreads = [spread];
  document.spreads.itemByName = (name) => document.spreads.find((item) => item.name === name);
  const story = {
    id: 61,
    name: "Story 1",
    index: 0,
    contents: "Hello story",
    paragraphs: [{}, {}],
    isValid: true,
    typename: "Story"
  };
  const textFrame = {
    id: 51,
    name: "Frame 1",
    index: 0,
    contents: "Hello",
    overflows: false,
    geometricBounds: [0, 0, 100, 200],
    parentStory: story,
    parentPage: page1,
    isValid: true,
    typename: "TextFrame"
  };
  story.textContainers = [textFrame];
  document.textFrames = [textFrame];
  document.textFrames.itemByName = (name) => document.textFrames.find((item) => item.name === name);
  document.stories = [story];
  const paragraphStyle = {
    id: 71,
    name: "Body",
    index: 0,
    appliedFont: "Minion Pro",
    fontStyle: "Regular",
    pointSize: 10,
    leading: 12,
    tracking: 0,
    justification: "left",
    isValid: true,
    typename: "ParagraphStyle"
  };
  const characterStyle = {
    id: 81,
    name: "Emphasis",
    index: 0,
    appliedFont: "Minion Pro",
    fontStyle: "Italic",
    pointSize: 10,
    leading: 12,
    tracking: 5,
    isValid: true,
    typename: "CharacterStyle"
  };
  document.paragraphStyles = [paragraphStyle];
  document.paragraphStyles.itemByName = (name) => document.paragraphStyles.find((style) => style.name === name);
  document.characterStyles = [characterStyle];
  document.characterStyles.itemByName = (name) => document.characterStyles.find((style) => style.name === name);
  const swatch = {
    id: 91,
    name: "Brand Blue",
    model: "process",
    space: "RGB",
    colorValue: [10, 20, 200],
    isValid: true,
    typename: "Color"
  };
  document.swatches = [swatch];
  document.swatches.itemByName = (name) => document.swatches.find((item) => item.name === name);
  document.colors = {
    add(properties) {
      const added = { id: 92, typename: "Color", isValid: true, ...properties };
      document.swatches.push(added);
      return added;
    }
  };
  const link = {
    id: 101,
    name: "hero.png",
    filePath: "C:/assets/hero.png",
    status: "normal",
    linkType: "PNG",
    isValid: true,
    typename: "Link",
    update() {
      events.push({ kind: "link.update" });
      this.status = "updated";
    },
    relink(file) {
      events.push({ kind: "link.relink", file });
      this.filePath = file;
    }
  };
  document.links = [link];
  document.links.itemByName = (name) => document.links.find((item) => item.name === name);
  document.exportFile = (format, file, showingOptions, using) => {
    events.push({ kind: "document.exportFile", format, file, showingOptions, using });
    return true;
  };
  document.packageForPrint = (folder, copyingFonts, copyingLinkedGraphics) => {
    events.push({ kind: "document.packageForPrint", folder, copyingFonts, copyingLinkedGraphics });
    return true;
  };
  const env = await loadBundle("bridges/uxp/indesign/dist/main.js", {
    indesign: {
      app: {
        version: "19.5.0",
        activeDocument: document,
        documents: [document],
        activeWindow: { activePage: page1, activeSpread: spread },
        selection: [{ contents: "selected", parentStory: story, index: 3, length: 8, isValid: true, typename: "Text" }],
        doScript: async (target, _language, _args, _undoMode, commandName) => {
          events.push({ kind: "doScript", commandName });
          return await target();
        }
      }
    }
  });
  assert.strictEqual(env.sent[0].capabilities.host, "indesign");
  assert.ok(env.sent[0].capabilities.methods.page.includes("getPages"));
  assert.ok(env.sent[0].capabilities.methods.spread.includes("getSpreads"));
  assert.ok(env.sent[0].capabilities.methods.text.includes("getTextFrames"));
  assert.ok(env.sent[0].capabilities.methods.story.includes("getStories"));
  assert.ok(env.sent[0].capabilities.methods.style.includes("getParagraphStyles"));
  assert.ok(env.sent[0].capabilities.methods.swatch.includes("addColor"));
  assert.ok(env.sent[0].capabilities.methods.link.includes("relink"));
  assert.ok(env.sent[0].capabilities.methods.export.includes("exportFile"));
  assert.ok(env.sent[0].capabilities.methods.package.includes("packageForPrint"));
  assert.ok(env.sent[0].capabilities.methods.dom.includes("construct"));
  assert.strictEqual(result(await rpc(env, "indesign", "app", "getVersion")), "19.5.0");
  assert.strictEqual(result(await rpc(env, "indesign", "document", "getActive")).pageCount, 2);
  assert.strictEqual(result(await rpc(env, "indesign", "page", "getPages", [3]))[1].documentOffset, 1);
  assert.strictEqual(result(await rpc(env, "indesign", "page", "getActive", [3])).bounds[2], 800);
  assert.strictEqual(result(await rpc(env, "indesign", "page", "getByName", [3, "1"])).parentName, "Spread 1");
  assert.strictEqual(result(await rpc(env, "indesign", "page", "select", [3, "1", "replace"])).id, 31);
  assert.strictEqual(result(await rpc(env, "indesign", "spread", "getSpreads", [3]))[0].pageNames[1], "2");
  assert.strictEqual(result(await rpc(env, "indesign", "spread", "getActive", [3])).pageCount, 2);
  assert.strictEqual(result(await rpc(env, "indesign", "spread", "getByName", [3, "Spread 1"])).id, 41);
  assert.strictEqual(result(await rpc(env, "indesign", "text", "getTextFrames", [3]))[0].parentStoryName, "Story 1");
  assert.strictEqual(result(await rpc(env, "indesign", "text", "getTextFrameByName", [3, "Frame 1"])).parentPageName, "1");
  assert.strictEqual(result(await rpc(env, "indesign", "text", "getSelectedText")).contents, "selected");
  assert.strictEqual(result(await rpc(env, "indesign", "text", "setFrameContents", [3, "Frame 1", "World"], { commandName: "Text" })).contents, "World");
  assert.strictEqual(result(await rpc(env, "indesign", "story", "getStories", [3]))[0].paragraphCount, 2);
  assert.strictEqual(result(await rpc(env, "indesign", "story", "getByName", [3, "Story 1"])).textContainerCount, 1);
  assert.strictEqual(result(await rpc(env, "indesign", "story", "getByTextFrameId", [3, 51])).contents, "Hello story");
  assert.strictEqual(result(await rpc(env, "indesign", "story", "setContents", [3, "Story 1", "Updated story"], { commandName: "Story" })).contents, "Updated story");
  assert.strictEqual(result(await rpc(env, "indesign", "style", "getParagraphStyles", [3]))[0].appliedFont, "Minion Pro");
  assert.strictEqual(result(await rpc(env, "indesign", "style", "getCharacterStyles", [3]))[0].fontStyle, "Italic");
  assert.strictEqual(result(await rpc(env, "indesign", "style", "getParagraphStyleByName", [3, "Body"])).justification, "left");
  assert.strictEqual(result(await rpc(env, "indesign", "style", "getCharacterStyleByName", [3, "Emphasis"])).tracking, 5);
  assert.strictEqual(result(await rpc(env, "indesign", "style", "setParagraphStyleProperties", [3, "Body", { pointSize: 12 }], { commandName: "Paragraph" })).pointSize, 12);
  assert.strictEqual(result(await rpc(env, "indesign", "style", "setCharacterStyleProperties", [3, "Emphasis", { tracking: 20 }], { commandName: "Character" })).tracking, 20);
  assert.strictEqual(result(await rpc(env, "indesign", "swatch", "getSwatches", [3]))[0].colorValue[2], 200);
  assert.strictEqual(result(await rpc(env, "indesign", "swatch", "getByName", [3, "Brand Blue"])).space, "RGB");
  assert.strictEqual(result(await rpc(env, "indesign", "swatch", "addColor", [3, { name: "Accent", space: "RGB", colorValue: [255, 200, 0] }], { commandName: "Color" })).name, "Accent");
  assert.strictEqual(result(await rpc(env, "indesign", "link", "getLinks", [3]))[0].filePath, "C:/assets/hero.png");
  assert.strictEqual(result(await rpc(env, "indesign", "link", "getByName", [3, "hero.png"])).linkType, "PNG");
  assert.strictEqual(result(await rpc(env, "indesign", "link", "update", [3, "hero.png"], { commandName: "Update link" })).status, "updated");
  assert.strictEqual(result(await rpc(env, "indesign", "link", "relink", [3, "hero.png", "C:/assets/hero-new.png"], { commandName: "Relink" })).filePath, "file:///C:/assets/hero-new.png");
  assert.strictEqual(
    result(await rpc(env, "indesign", "export", "exportFile", [{ id: 3, format: "PDF_TYPE", path: "C:/out/layout.pdf", options: { preset: "Press", showingOptions: true } }], { commandName: "Export" })).name,
    "layout.indd"
  );
  assert.strictEqual(result(await rpc(env, "indesign", "package", "packageForPrint", [{ id: 3, path: "C:/out/package", options: { copyingFonts: true } }], { commandName: "Package" })).ok, true);
  const packageForPrint = document.packageForPrint;
  delete document.packageForPrint;
  assert.strictEqual(error(await rpc(env, "indesign", "package", "packageForPrint", [{ id: 3, path: "C:/out/missing-package" }])).code, -32004);
  document.packageForPrint = packageForPrint;
  const indesignAppRef = result(await rpc(env, "indesign", "dom", "root", ["app"]));
  assert.match(error(await rpc(env, "indesign", "dom", "get", [indesignAppRef, "constructor"])).message, /not accessible/i);
  const indesignDocumentRef = result(await rpc(env, "indesign", "dom", "get", [indesignAppRef, "activeDocument"]));
  assert.strictEqual(result(await rpc(env, "indesign", "dom", "get", [indesignDocumentRef, "name"])), "layout.indd");
  assert.strictEqual(
    result(await rpc(env, "indesign", "dom", "set", [indesignDocumentRef, "name", "layout-renamed.indd"], { commandName: "Rename document" })),
    "layout-renamed.indd"
  );
  assert.strictEqual(result(await rpc(env, "indesign", "dom", "snapshot", [indesignDocumentRef, ["name", "typename"]])).typename, "Document");
  assert.ok(result(await rpc(env, "indesign", "dom", "keys", [indesignDocumentRef])).includes("name"));
  assert.strictEqual(result(await rpc(env, "indesign", "dom", "release", [indesignDocumentRef])), true);
  assert.match(error(await rpc(env, "indesign", "dom", "get", [indesignDocumentRef, "name"])).message, /stale or unknown/i);
  assert.strictEqual(result(await rpc(env, "indesign", "raw", "evalJs", ["40 + 2"])), 42);
  assert.ok(events.some((event) => event.kind === "page.select" && event.existingSelection === "replace"));
  assert.ok(events.some((event) => event.kind === "doScript" && event.commandName === "Text"));
  assert.ok(events.some((event) => event.kind === "doScript" && event.commandName === "Story"));
  assert.ok(events.some((event) => event.kind === "doScript" && event.commandName === "Rename document"));
  assert.ok(events.some((event) => event.kind === "link.update"));
  assert.ok(events.some((event) => event.kind === "link.relink" && event.file === "file:///C:/assets/hero-new.png"));
  assert.ok(events.some((event) => event.kind === "document.exportFile" && event.format === "PDF_TYPE" && event.using === "Press" && event.showingOptions === true));
  assert.ok(events.some((event) => event.kind === "document.packageForPrint" && event.copyingFonts === true));
}

async function testPremiereBridge() {
  const events = [];
  const videoClip = {
    id: "clip-v",
    name: "shot.mov",
    projectItem: { id: "item-1", name: "shot.mov", mediaPath: "C:/media/shot.mov" },
    start: 0,
    end: 30,
    duration: 30,
    enabled: true,
    selected: true,
    typename: "TrackItem"
  };
  const audioClip = {
    id: "clip-a",
    name: "dialog.wav",
    projectItem: { id: "item-2", name: "dialog.wav", mediaPath: "C:/media/dialog.wav" },
    start: 0,
    end: 30,
    duration: 30,
    enabled: true,
    selected: false,
    typename: "TrackItem"
  };
  const mediaItem = {
    id: "media-1",
    name: "shot.mov",
    mediaPath: "C:/media/shot.mov",
    treePath: "/Dailies/shot.mov",
    type: 1,
    typename: "ClipProjectItem",
    canProxy: () => true,
    hasProxy: () => false,
    isOffline: () => false,
    getMediaFilePath: () => "C:/media/shot.mov"
  };
  const binItem = {
    id: "bin-1",
    name: "Dailies",
    treePath: "/Dailies",
    type: 2,
    typename: "FolderItem",
    children: [mediaItem],
    createBin(name) {
      const bin = { id: `bin-${this.children.length + 1}`, name, treePath: `/Dailies/${name}`, type: 2, typename: "FolderItem", children: [] };
      this.children.push(bin);
      events.push({ kind: "bin.create", parent: this.id, name });
      return bin;
    }
  };
  mediaItem.parent = binItem;
  const rootItem = {
    id: "root",
    name: "Project Root",
    treePath: "/",
    type: 2,
    typename: "FolderItem",
    children: [binItem],
    createBin(name) {
      const bin = { id: `root-bin-${this.children.length + 1}`, name, treePath: `/${name}`, type: 2, typename: "FolderItem", children: [] };
      this.children.push(bin);
      events.push({ kind: "bin.create", parent: this.id, name });
      return bin;
    }
  };
  binItem.parent = rootItem;
  const markers = [{ id: "marker-1", name: "Beat", comments: "cut here", start: 12, duration: 1, markerType: "comment", typename: "Marker" }];
  markers.createMarker = (start) => {
    const marker = { id: "marker-2", start, typename: "Marker" };
    events.push({ kind: "marker.create", start });
    markers.push(marker);
    return marker;
  };
  const sequence = {
    id: "seq-1",
    sequenceId: "sequence-1",
    name: "Main edit",
    duration: 120,
    timebase: 25,
    typename: "Sequence",
    videoTracks: [{ id: "v1", name: "V1", index: 0, locked: false, muted: false, targeted: true, clips: [videoClip], typename: "VideoTrack" }],
    audioTracks: [{ id: "a1", name: "A1", index: 0, locked: false, muted: true, targeted: false, clips: [audioClip], typename: "AudioTrack" }],
    markers
  };
  const project = {
    guid: "project-1",
    name: "cut.prproj",
    path: "C:/cut.prproj",
    itemCount: 3,
    sequences: [sequence],
    activeSequence: sequence,
    save() {
      events.push({ kind: "project.save" });
    },
    saveAs(path) {
      events.push({ kind: "project.saveAs", path });
      this.path = path;
    },
    createSequence(name) {
      const created = { ...sequence, id: `seq-${this.sequences.length + 1}`, sequenceId: `sequence-${this.sequences.length + 1}`, name };
      this.sequences.push(created);
      events.push({ kind: "project.createSequence", name });
      return created;
    },
    executeTransaction(callback, commandName) {
      const actions = [];
      callback({ addAction(action) { actions.push(action); } });
      events.push({ kind: "project.transaction", commandName, actions });
    },
    getRootItem() {
      return rootItem;
    },
    importFiles(filePaths, suppressUI, targetBin, asNumberedStills) {
      events.push({ kind: "project.importFiles", filePaths, suppressUI, targetBin: targetBin.id, asNumberedStills });
      for (const filePath of filePaths) {
        const name = filePath.split(/[\\/]/).pop();
        const item = { id: `media-${targetBin.children.length + 1}`, name, mediaPath: filePath, treePath: `${targetBin.treePath}/${name}`, type: 1, typename: "ClipProjectItem", parent: targetBin };
        targetBin.children.push(item);
      }
      return true;
    }
  };
  const encoderPresets = [{ name: "H.264 Match Source", path: "C:/presets/h264.epr", format: "H.264", extension: "mp4", typename: "EncoderPreset" }];
  const encoderManager = {
    isAMEInstalled: true,
    typename: "EncoderManager",
    getPresets() {
      return encoderPresets;
    },
    encodeFile(sourcePath, outputPath, presetPath, inPoint, outPoint, workArea, removeUponCompletion, startQueueImmediately) {
      events.push({ kind: "encoder.encodeFile", sourcePath, outputPath, presetPath, inPoint, outPoint, workArea, removeUponCompletion, startQueueImmediately });
      return { jobId: "job-file", status: "queued" };
    },
    encodeProjectItem(projectItem, outputPath, presetPath, workArea, removeUponCompletion, startQueueImmediately) {
      events.push({ kind: "encoder.encodeProjectItem", projectItem: projectItem.id, outputPath, presetPath, workArea, removeUponCompletion, startQueueImmediately });
      return { jobId: "job-item", status: "queued" };
    },
    exportSequence(sequenceToExport, exportType, outputPath, presetPath, exportFull, removeUponCompletion, startQueueImmediately) {
      events.push({ kind: "encoder.exportSequence", sequence: sequenceToExport.id, exportType, outputPath, presetPath, exportFull, removeUponCompletion, startQueueImmediately });
      return { jobId: "job-sequence", status: "queued" };
    }
  };
  const exporter = {
    exportSequenceFrame(sequenceToExport, time, filename, filepath, width, height) {
      events.push({ kind: "export.frame", sequence: sequenceToExport.id, time, filename, filepath, width, height });
      return { jobId: "job-frame", status: "exported" };
    }
  };
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: {
      version: "25.6.0",
      AAFExportOptions: class AAFExportOptions {
        constructor() {
          this.embedAudio = false;
        }
        setEmbedAudio(value) {
          this.embedAudio = value;
          return this;
        }
      },
      constants: {
        ExportType: {
          IMMEDIATELY: "IMMEDIATELY",
          QUEUE_TO_AME: "QUEUE_TO_AME",
          QUEUE_TO_APP: "QUEUE_TO_APP"
        }
      },
      EncoderManager: {
        getManager() {
          return encoderManager;
        },
        getExportFileExtension(sequenceToExport, presetPath) {
          events.push({ kind: "encoder.extension", sequence: sequenceToExport.id, presetPath });
          return "mp4";
        }
      },
      Exporter: exporter,
      ClipProjectItem: { cast: (item) => item.typename === "ClipProjectItem" ? item : undefined },
      TickTime: {
        TIME_INVALID: { seconds: -1 },
        createWithSeconds(seconds) {
          return { seconds };
        },
        createWithTicks(ticks) {
          return { ticks };
        }
      },
      SequenceEditor: {
        getEditor(sequenceToEdit) {
          return {
            createInsertProjectItemAction(item, time, videoTrack, audioTrack, limitShift) {
              return { kind: "sequence.insert", sequence: sequenceToEdit.id, item: item.id, time, videoTrack, audioTrack, limitShift };
            },
            createOverwriteProjectItemAction(item, time, videoTrack, audioTrack) {
              return { kind: "sequence.overwrite", sequence: sequenceToEdit.id, item: item.id, time, videoTrack, audioTrack };
            },
            createOverwriteItemAction(item, time, videoTrack, audioTrack) {
              return { kind: "sequence.overwrite", sequence: sequenceToEdit.id, item: item.id, time, videoTrack, audioTrack };
            }
          };
        }
      },
      ProjectUtils: {
        getSelection(activeProject) {
          assert.strictEqual(activeProject, project);
          return [mediaItem];
        }
      },
      Project: {
        getActiveProject() {
          return project;
        }
      }
    }
  });
  assert.strictEqual(env.sent[0].capabilities.host, "premiere");
  assert.ok(env.sent[0].capabilities.methods.project.includes("getActiveSequence"));
  assert.ok(env.sent[0].capabilities.methods.project.includes("importFiles"));
  assert.ok(env.sent[0].capabilities.methods.project.includes("createSequence"));
  assert.ok(env.sent[0].capabilities.methods.sequence.includes("insertProjectItem"));
  assert.ok(env.sent[0].capabilities.methods.sequence.includes("getVideoTracks"));
  assert.ok(env.sent[0].capabilities.methods.track.includes("getClips"));
  assert.ok(env.sent[0].capabilities.methods.clip.includes("getSelected"));
  assert.ok(env.sent[0].capabilities.methods.projectItem.includes("getChildren"));
  assert.ok(env.sent[0].capabilities.methods.bin.includes("create"));
  assert.ok(env.sent[0].capabilities.methods.marker.includes("create"));
  assert.ok(env.sent[0].capabilities.methods.encoder.includes("exportSequence"));
  assert.ok(env.sent[0].capabilities.methods.export.includes("exportFrame"));
  assert.ok(env.sent[0].capabilities.methods.dom.includes("snapshot"));
  assert.strictEqual(result(await rpc(env, "premiere", "app", "getVersion")), "25.6.0");
  assert.deepStrictEqual(result(await rpc(env, "premiere", "project", "getActive")), {
    id: "project-1",
    guid: "project-1",
    name: "cut.prproj",
    path: "C:/cut.prproj",
    itemCount: 3
  });
  assert.strictEqual(result(await rpc(env, "premiere", "project", "getSequences"))[0].sequenceId, "sequence-1");
  assert.strictEqual(result(await rpc(env, "premiere", "project", "getActiveSequence")).name, "Main edit");
  assert.strictEqual(result(await rpc(env, "premiere", "project", "saveAs", ["C:/edits/intro.prproj"])).path, "C:/edits/intro.prproj");
  assert.strictEqual(result(await rpc(env, "premiere", "project", "createSequence", [{ name: "DCC Intro" }])).name, "DCC Intro");
  assert.strictEqual(result(await rpc(env, "premiere", "sequence", "getVideoTracks", ["seq-1"]))[0].isTargeted, true);
  assert.strictEqual(result(await rpc(env, "premiere", "sequence", "getAudioTracks", ["seq-1"]))[0].isMuted, true);
  assert.strictEqual(result(await rpc(env, "premiere", "track", "getClips", ["seq-1", "video", "v1"]))[0].mediaPath, "C:/media/shot.mov");
  assert.strictEqual(result(await rpc(env, "premiere", "clip", "getSelected", ["seq-1"]))[0].isSelected, true);
  assert.strictEqual(result(await rpc(env, "premiere", "marker", "getMarkers", ["seq-1"]))[0].comments, "cut here");
  const created = result(await rpc(env, "premiere", "marker", "create", ["seq-1", { name: "Review", start: 42, comments: "check" }]));
  assert.strictEqual(created.name, "Review");
  assert.strictEqual(created.start, 42);
  assert.ok(events.some((event) => event.kind === "marker.create" && event.start === 42));
  delete markers.createMarker;
  assert.strictEqual(error(await rpc(env, "premiere", "marker", "create", ["seq-1", { name: "Missing" }])).code, -32004);
  assert.strictEqual(result(await rpc(env, "premiere", "project", "getRootItem")).childCount, 1);
  assert.strictEqual(result(await rpc(env, "premiere", "projectItem", "getChildren", ["root"]))[0].name, "Dailies");
  assert.strictEqual(result(await rpc(env, "premiere", "projectItem", "getChildren", ["bin-1"]))[0].mediaPath, "C:/media/shot.mov");
  assert.strictEqual(result(await rpc(env, "premiere", "projectItem", "findByMediaPath", ["root", "shot", false]))[0].name, "shot.mov");
  assert.strictEqual(result(await rpc(env, "premiere", "projectItem", "getSelected"))[0].id, "media-1");
  assert.strictEqual(result(await rpc(env, "premiere", "bin", "create", [{ parentId: "root", name: "B-Roll" }])).name, "B-Roll");
  assert.ok(events.some((event) => event.kind === "bin.create" && event.parent === "root"));
  const imported = result(await rpc(env, "premiere", "project", "importFiles", [{ filePaths: ["C:/media/new.mov"], targetBin: "bin-1", suppressUI: true, asNumberedStills: false }]));
  assert.strictEqual(imported[0].mediaPath, "C:/media/new.mov");
  assert.ok(events.some((event) => event.kind === "project.importFiles" && event.targetBin === "bin-1"));
  assert.strictEqual(error(await rpc(env, "premiere", "project", "importFiles", [{ filePaths: [] }])).code, -32004);
  const inserted = result(await rpc(env, "premiere", "sequence", "insertProjectItem", ["seq-1", { projectItem: "media-1", time: 2.5, videoTrack: 1, audioTrack: 0, limitShift: true }]));
  assert.strictEqual(inserted.mode, "insert");
  const overwritten = result(await rpc(env, "premiere", "sequence", "overwriteProjectItem", ["seq-1", { projectItem: "media-1", time: "254016000000", videoTrack: 0, audioTrack: 0 }]));
  assert.strictEqual(overwritten.mode, "overwrite");
  assert.ok(events.some((event) => event.kind === "project.transaction" && event.actions[0].kind === "sequence.insert" && event.actions[0].time.seconds === 2.5));
  assert.ok(events.some((event) => event.kind === "project.transaction" && event.actions[0].kind === "sequence.overwrite" && event.actions[0].time.ticks === "254016000000"));
  assert.strictEqual(result(await rpc(env, "premiere", "encoder", "getManager")).isAMEInstalled, true);
  assert.strictEqual(result(await rpc(env, "premiere", "encoder", "getPresets"))[0].path, "C:/presets/h264.epr");
  assert.strictEqual(result(await rpc(env, "premiere", "encoder", "getExportFileExtension", [{ sequence: "seq-1", presetPath: "C:/presets/h264.epr" }])), "mp4");
  const fileJob = result(
    await rpc(env, "premiere", "encoder", "encodeFile", [
      {
        sourcePath: "C:/media/source.mov",
        outputPath: "C:/out/source.mp4",
        presetPath: "C:/presets/h264.epr",
        workArea: 0,
        removeUponCompletion: false,
        startQueueImmediately: true
      }
    ])
  );
  assert.strictEqual(fileJob.jobId, "job-file");
  assert.strictEqual(fileJob.outputPath, "C:/out/source.mp4");
  assert.strictEqual(fileJob.removeUponCompletion, false);
  const itemJob = result(await rpc(env, "premiere", "encoder", "encodeProjectItem", [{ projectItemId: "media-1", outputPath: "C:/out/shot.mp4", presetPath: "C:/presets/h264.epr" }]));
  assert.strictEqual(itemJob.sourceName, "shot.mov");
  const sequenceJob = result(await rpc(env, "premiere", "encoder", "exportSequence", [{ sequence: "seq-1", outputPath: "C:/out/main.mp4", presetPath: "C:/presets/h264.epr", exportType: "QUEUE_TO_AME" }]));
  assert.strictEqual(sequenceJob.exportType, "QUEUE_TO_AME");
  const frameJob = result(await rpc(env, "premiere", "export", "exportFrame", [{ sequence: "seq-1", outputPath: "C:/out/frame.png", time: 42, width: 1920, height: 1080 }]));
  assert.strictEqual(frameJob.status, "exported");
  assert.strictEqual(error(await rpc(env, "premiere", "encoder", "encodeFile", [{ sourcePath: "C:/media/source.mov" }])).code, -32004);
  const premiereModuleRef = result(await rpc(env, "premiere", "dom", "root", ["module"]));
  const projectApiRef = result(await rpc(env, "premiere", "dom", "get", [premiereModuleRef, "Project"]));
  const premiereProjectRef = result(await rpc(env, "premiere", "dom", "call", [projectApiRef, "getActiveProject", []]));
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [premiereProjectRef, "name"])), "cut.prproj");
  const projectUtilsRef = result(await rpc(env, "premiere", "dom", "get", [premiereModuleRef, "ProjectUtils"]));
  const selectedRefs = result(await rpc(env, "premiere", "dom", "call", [projectUtilsRef, "getSelection", [premiereProjectRef]]));
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [selectedRefs[0], "name"])), "shot.mov");
  const aafOptionsRef = result(await rpc(env, "premiere", "dom", "construct", [premiereModuleRef, "AAFExportOptions", []]));
  const returnedOptionsRef = result(await rpc(env, "premiere", "dom", "call", [aafOptionsRef, "setEmbedAudio", [true]], { modal: true }));
  assert.deepStrictEqual(returnedOptionsRef, aafOptionsRef);
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [returnedOptionsRef, "embedAudio"])), true);
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "snapshot", [premiereProjectRef, ["name", "path"]])).path, "C:/edits/intro.prproj");
  assert.ok(result(await rpc(env, "premiere", "dom", "keys", [premiereProjectRef])).includes("save"));
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "release", [premiereProjectRef])), true);
  assert.strictEqual(result(await rpc(env, "premiere", "raw", "evalJs", ["6 * 7"])), 42);
  assert.ok(events.some((event) => event.kind === "encoder.extension" && event.presetPath === "C:/presets/h264.epr"));
  assert.ok(events.some((event) => event.kind === "encoder.encodeFile" && event.workArea === 0 && event.removeUponCompletion === false));
  assert.ok(events.some((event) => event.kind === "encoder.encodeProjectItem" && event.projectItem === "media-1"));
  assert.ok(events.some((event) => event.kind === "encoder.exportSequence" && event.exportType === "QUEUE_TO_AME"));
  assert.ok(events.some((event) => event.kind === "export.frame" && event.filename === "C:/out/frame.png" && event.filepath === "C:/out/"));

  const unavailableEnv = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: { version: "25.6.0" }
  });
  assert.strictEqual(error(await rpc(unavailableEnv, "premiere", "encoder", "encodeFile", [{ sourcePath: "C:/media/source.mov", outputPath: "C:/out/source.mp4" }])).code, -32004);
}

// Mirror the asynchronous UXP 25.6 read API instead of legacy DOM properties.
async function testPremiereNativeReadQueries() {
  const itemIds = new WeakMap();
  const projectItems = new WeakMap();
  const guidValues = new WeakMap();
  const folders = new WeakMap();
  const mediaPaths = new WeakMap();
  let reverseCasts = 0;
  class Guid {
    constructor(value) { guidValues.set(this, value); }
    toString() { return guidValues.get(this); }
  }
  class ProjectItem {
    constructor(id, name) { itemIds.set(this, id); this.name = name; }
    static cast(item) {
      if (item instanceof ProjectItem) return item;
      const base = projectItems.get(item);
      if (base) reverseCasts += 1;
      return base || null;
    }
    getId() { return itemIds.get(this); }
  }
  class AsyncProjectItem extends ProjectItem {
    async getId() { return super.getId(); }
  }
  class FolderItem {
    constructor(name, children) {
      this.name = name;
      folders.set(this, { getItems: async () => children });
    }
    static cast(item) { return item instanceof FolderItem ? item : folders.get(item); }
    async getItems() { return folders.get(this).getItems(); }
  }
  class ClipProjectItem {
    static cast(item) { return mediaPaths.has(item) ? { getMediaFilePath: async () => mediaPaths.get(item) } : null; }
  }
  function folder(id, name, children) {
    const item = new ProjectItem(id, name);
    folders.set(item, { getItems: async () => children });
    return item;
  }
  function media(id, filePath) {
    const Item = id === "media-b" ? AsyncProjectItem : ProjectItem;
    const item = new Item(id, "shared.mov");
    mediaPaths.set(item, filePath);
    return item;
  }
  const mediaA = media("media-a", "C:/fixture/a/shared.mov");
  const mediaB = media("media-b", "C:/fixture/b/shared.mov");
  const nested = folder("nested", "Nested", [mediaB]);
  const actualBin = folder("bin-actual", "Actual", [nested]);
  const nameCollision = folder("bin-decoy", "bin-actual", [mediaA]);
  const emptyBin = folder("empty-bin", "shared.mov", []);
  const rootItem = new FolderItem("Root", [nameCollision, actualBin, emptyBin]);
  projectItems.set(rootItem, new ProjectItem("root-native", "Root"));
  assert.strictEqual(typeof rootItem.getId, "undefined", "the native root is a FolderItem, not a ProjectItem");
  const tickTime = (seconds, ticks) => ({ seconds, ticks });
  const calls = [];
  const videoClip = {
    name: "Native video clip",
    async getProjectItem() { return mediaB; },
    async getStartTime() { return tickTime(1, "254016000000"); },
    async getEndTime() { return tickTime(3, "762048000000"); },
    async getInPoint() { return tickTime(0.5, "127008000000"); },
    async getOutPoint() { return tickTime(2.5, "635040000000"); },
    async getDuration() { return tickTime(2, "508032000000"); }
  };
  const audioClip = {
    ...videoClip,
    name: "Native audio clip",
    async getProjectItem() { return mediaA; },
    async getStartTime() { return tickTime(40000, "10160640000000001"); }
  };
  let videoItems = [videoClip];
  function track(id, name, index, items) {
    return {
      id, name,
      async getIndex() { return index; },
      async isMuted() { return id === 3; },
      async getTrackItems(type, includeEmpty) {
        calls.push({ kind: "getTrackItems", id, type, includeEmpty });
        assert.strictEqual(type, 1);
        assert.strictEqual(includeEmpty, false);
        return items();
      }
    };
  }
  const videoTracks = [track(1, "Native ID wins", 0, () => videoItems), track(9, "Index one", 1, () => [])];
  const audioTracks = [track(3, "A1", 0, () => [audioClip])];
  let videoTrackCount = videoTracks.length;
  const sequence = {
    guid: new Guid("sequence-native"), name: "Native sequence",
    async getEndTime() { return tickTime(120, "30481920000000"); },
    async getTimebase() { return "10160640000"; },
    async getVideoTrackCount() { return videoTrackCount; },
    async getAudioTrackCount() { return audioTracks.length; },
    async getVideoTrack(index) { return videoTracks[index]; },
    async getAudioTrack(index) { return audioTracks[index]; }
  };
  const nestedSequence = { ...sequence, guid: new Guid("nested-sequence-native"), name: "Nested sequence" };
  const project = {
    guid: new Guid("project-native"), name: "native.prproj", path: "C:/fixture/native.prproj",
    async getSequences() { return [sequence, nestedSequence]; },
    async getActiveSequence() { return sequence; },
    async getRootItem() { return rootItem; }
  };
  let activeProjectCalls = 0;
  class Project {
    static async getActiveProject() { activeProjectCalls += 1; return project; }
  }
  const modules = {
    premierepro: { version: "25.6.0", Project, ProjectItem, FolderItem, ClipProjectItem, Constants: { TrackItemType: { CLIP: 1 } } }
  };
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", modules);
  assert.strictEqual(env.socket.url, "ws://localhost:47391/v1/bridge/premiere/ws");
  const active = result(await rpc(env, "premiere", "project", "getActive"));
  assert.strictEqual(active.id, "project-native");
  assert.strictEqual(active.guid, "project-native");
  assert.ok(activeProjectCalls > 0, "the static class getter must be invoked");
  const sequences = result(await rpc(env, "premiere", "project", "getSequences"));
  assert.deepStrictEqual(sequences.map((value) => value.id), ["sequence-native", "nested-sequence-native"]);
  assert.strictEqual(sequences[0].duration.ticks, "30481920000000");
  assert.strictEqual(sequences[0].timebase, "10160640000");
  assert.strictEqual(result(await rpc(env, "premiere", "project", "getActiveSequence")).id, "sequence-native");
  assert.strictEqual(result(await rpc(env, "premiere", "sequence", "getVideoTracks", ["nested-sequence-native"])).length, 2);
  const serializedAudioTracks = result(await rpc(env, "premiere", "sequence", "getAudioTracks", ["sequence-native"]));
  assert.strictEqual(serializedAudioTracks.length, 1);
  assert.strictEqual(serializedAudioTracks[0].isMuted, true);
  const video = result(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "video", 1]));
  assert.strictEqual(video.length, 1, "native track ID must take precedence over another track's index");
  assert.strictEqual(video[0].projectItemId, "media-b");
  assert.strictEqual(video[0].mediaPath, "C:/fixture/b/shared.mov");
  assert.deepStrictEqual(video[0].start, { seconds: 1, ticks: "254016000000" });
  assert.deepStrictEqual(video[0].end, { seconds: 3, ticks: "762048000000" });
  assert.deepStrictEqual(video[0].inPoint, { seconds: 0.5, ticks: "127008000000" });
  assert.deepStrictEqual(video[0].outPoint, { seconds: 2.5, ticks: "635040000000" });
  assert.deepStrictEqual(video[0].duration, { seconds: 2, ticks: "508032000000" });
  assert.ok(typeof video[0].id === "string" && video[0].id.length > 0);
  assert.strictEqual(video[0].idSource, "derived");
  assert.deepStrictEqual(result(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "video", 9])), []);
  const audio = result(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "audio", 3]));
  assert.strictEqual(audio[0].start.ticks, "10160640000000001", "ticks must never round through a JS number");
  assert.notStrictEqual(audio[0].id, video[0].id);
  assert.ok(calls.some((call) => call.id === 1 && call.type === 1 && call.includeEmpty === false));
  const serializedRoot = result(await rpc(env, "premiere", "project", "getRootItem"));
  assert.strictEqual(serializedRoot.id, "root-native");
  assert.strictEqual(serializedRoot.childCount, 3);
  assert.ok(reverseCasts > 0, "FolderItem IDs must be read through ProjectItem.cast");
  const children = result(await rpc(env, "premiere", "projectItem", "getChildren", ["bin-actual"]));
  assert.deepStrictEqual(children.map((item) => item.id), ["nested"], "native item ID must beat a colliding name");
  assert.deepStrictEqual(result(await rpc(env, "premiere", "projectItem", "getChildren", ["empty-bin"])), []);
  const nestedChildren = result(await rpc(env, "premiere", "projectItem", "getChildren", ["nested"]));
  assert.strictEqual(nestedChildren[0].id, "media-b");
  assert.strictEqual(nestedChildren[0].mediaPath, "C:/fixture/b/shared.mov");
  const matches = result(await rpc(env, "premiere", "projectItem", "findByMediaPath", ["root-native", "shared.mov", false]));
  assert.deepStrictEqual(matches.map((item) => item.id).sort(), ["media-a", "media-b"]);
  assert.strictEqual(error(await rpc(env, "premiere", "projectItem", "findByMediaPath", ["root-native", "shared.mov", true])).code, -32004,
    "a fallback without a native subclip filter must reject ignoreSubclips=true");

  videoTrackCount = 10001;
  const tooManyTracks = error(await rpc(env, "premiere", "sequence", "getVideoTracks", ["sequence-native"]));
  assert.strictEqual(tooManyTracks.code, -32004);
  assert.match(tooManyTracks.message, /limit/i);
  videoTrackCount = videoTracks.length;
  videoItems = Array(10001).fill(videoClip);
  const tooManyClips = error(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "video", 1]));
  assert.strictEqual(tooManyClips.code, -32004);
  assert.match(tooManyClips.message, /limit/i);
  videoItems = [videoClip];
  const getTrackItems = videoTracks[0].getTrackItems;
  delete videoTracks[0].getTrackItems;
  assert.strictEqual(error(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "video", 1])).code, -32004);
  videoTracks[0].getTrackItems = async () => { throw new Error("native clip read failed"); };
  const failedRead = error(await rpc(env, "premiere", "track", "getClips", ["sequence-native", "video", 1]));
  assert.strictEqual(failedRead.code, -32004);
  assert.match(failedRead.message, /native clip read failed/);
  videoTracks[0].getTrackItems = getTrackItems;
  folders.set(emptyBin, {});
  assert.strictEqual(error(await rpc(env, "premiere", "projectItem", "getChildren", ["empty-bin"])).code, -32004);
  folders.set(emptyBin, { getItems: async () => [] });
  folders.set(rootItem, { getItems: async () => Array(10001).fill(mediaA) });
  const tooManyItems = error(await rpc(env, "premiere", "projectItem", "getChildren", ["root-native"]));
  assert.strictEqual(tooManyItems.code, -32004);
  assert.match(tooManyItems.message, /limit/i);
  folders.set(rootItem, { getItems: async () => [nameCollision, actualBin, emptyBin] });

  const overridden = await loadBundle("bridges/uxp/premiere/dist/main.js", modules, {
    __ADOBEPY_BROKER_URL: "wss://fixture.invalid/v1/bridge/premiere/ws"
  });
  assert.strictEqual(overridden.socket.url, "wss://fixture.invalid/v1/bridge/premiere/ws");
}

// Native Premiere 25.6 collections are objects rather than arrays: the value can
// be a Promise, its count can be asynchronous, and item access can be asynchronous.
// Fixtures that only return arrays would make the "Premiere collection read" path
// self-fulfilling and would not catch the reported regression.
async function testPremiereAsyncNativeCollections() {
  const guidValues = new WeakMap();
  class Guid {
    constructor(value) { guidValues.set(this, value); }
    toString() { return guidValues.get(this); }
  }
  class ProjectItem {
    constructor(id, name) { this.id = id; this.name = name; this.typename = "Clip"; }
    getId() { return this.id; }
    static cast(item) { return item instanceof ProjectItem ? item : undefined; }
  }
  class FolderItem {
    static cast(item) { return item instanceof FolderItem ? item : undefined; }
  }
  class ClipProjectItem {
    static cast() { return undefined; }
  }

  // Four native shapes: async count method with async at(), async count method
  // with async getAt(), a Promise-valued count property, and a Promise-valued
  // collection object. None is an array or a plain Promise<Array>.
  function nativeCollection(items, shape) {
    if (shape === "promise-value") {
      return Promise.resolve({
        async getNumItems() { return items.length; },
        async at(index) { return items[index]; }
      });
    }
    if (shape === "promise-count") {
      return {
        get numItems() { return Promise.resolve(items.length); },
        async item(index) { return items[index]; }
      };
    }
    if (shape === "count-method") {
      return {
        async getItemCount() { return items.length; },
        async getAt(index) { return items[index]; }
      };
    }
    return {
      async getNumItems() { return items.length; },
      async at(index) { return items[index]; }
    };
  }

  for (const shape of ["async-count", "count-method", "promise-count", "promise-value"]) {
    const clip = { id: "clip-native", name: "Native clip" };
    const track = { id: "track-native", name: "V1", clips: nativeCollection([clip], shape) };
    const sequence = {
      guid: new Guid("sequence-async"), name: "Async sequence",
      videoTracks: nativeCollection([track], shape),
      audioTracks: nativeCollection([], shape)
    };
    const children = [new ProjectItem("child-a", "A"), new ProjectItem("child-b", "B")];
    const rootItem = { name: "Root", getItems: async () => nativeCollection(children, shape) };
    const project = {
      guid: new Guid("project-async"), name: "async.prproj",
      sequences: nativeCollection([sequence], shape),
      getActiveSequence: async () => sequence,
      getRootItem: async () => rootItem
    };
    class Project {
      static async getActiveProject() { return project; }
    }
    const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
      premierepro: { version: "25.6.0", Project, ProjectItem, FolderItem, ClipProjectItem }
    });
    const sequences = result(await rpc(env, "premiere", "project", "getSequences"));
    assert.deepStrictEqual(sequences.map((value) => value.id), ["sequence-async"], `shape ${shape}: project sequences`);
    const tracks = result(await rpc(env, "premiere", "sequence", "getVideoTracks", ["sequence-async"]));
    assert.strictEqual(tracks.length, 1, `shape ${shape}: video tracks`);
    assert.strictEqual(tracks[0].id, "track-native");
    const clips = result(await rpc(env, "premiere", "track", "getClips", ["sequence-async", "video"]));
    assert.strictEqual(clips.length, 1, `shape ${shape}: track clips`);
    assert.strictEqual(clips[0].id, "clip-native");
    const childItems = result(await rpc(env, "premiere", "projectItem", "getChildren"));
    assert.deepStrictEqual(childItems.map((value) => value.id).sort(), ["child-a", "child-b"], `shape ${shape}: project item children`);
  }
}

// serializeId() must isolate broken native IDs and never let an unserializable
// value become the literal string "undefined" during sequence matching.
async function testPremiereIdSerializationBoundaries() {
  const throwingToString = { toString() { throw new Error("native toString failed"); } };
  const asyncToString = { toString() { return Promise.resolve("async-id"); } };
  const throwingGetter = {};
  Object.defineProperty(throwingGetter, "toString", { get() { throw new Error("native getter failed"); } });
  const plainObject = {};
  for (const badId of [throwingToString, asyncToString, throwingGetter, plainObject]) {
    const project = { guid: badId, name: "boundary.prproj" };
    class Project { static async getActiveProject() { return project; } }
    const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
      premierepro: { version: "25.6.0", Project }
    });
    const active = result(await rpc(env, "premiere", "project", "getActive"));
    assert.strictEqual(active.id, undefined, "a broken native ID must be isolated from the RPC boundary");
    assert.strictEqual(active.guid, undefined);
    assert.strictEqual(active.name, "boundary.prproj");
  }

  const badGuid = { toString() { return "[object Object]"; } };
  const sequence = { guid: badGuid, name: "Real sequence", videoTracks: [], audioTracks: [] };
  const project = { getActiveSequence: async () => sequence, sequences: [sequence] };
  class Project { static async getActiveProject() { return project; } }
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: { version: "25.6.0", Project }
  });
  const rejected = error(await rpc(env, "premiere", "sequence", "getVideoTracks", ["undefined"]));
  assert.strictEqual(rejected.code, -32004, "the string 'undefined' must not match an unserializable ID");
}

// End-to-end regression through the real RPC/DOM dispatch. A function receiver
// reached via dom.root/dom.get must not expose Function.prototype members, while
// ordinary own properties and host DOM prototype methods remain reachable.
async function testDomDispatchMemberBoundary() {
  function HostConstructor() {
    this.tag = "instance";
  }
  HostConstructor.nativeStatic = 7;
  HostConstructor.prototype.hostMethod = function (suffix) {
    return `host:${suffix}:${this.tag}`;
  };

  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: { version: "25.6.0", HostConstructor }
  });
  assert.strictEqual(env.sent[0].capabilities.host, "premiere");

  const moduleRef = result(await rpc(env, "premiere", "dom", "root", ["module"]));
  assert.ok(moduleRef && typeof moduleRef.$adobepyRef === "string");
  const fnRef = result(await rpc(env, "premiere", "dom", "get", [moduleRef, "HostConstructor"]));
  assert.ok(fnRef && typeof fnRef.$adobepyRef === "string");

  // Own properties of a function receiver are legitimate host capabilities.
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [fnRef, "nativeStatic"])), 7);
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [fnRef, "name"])), "HostConstructor");
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "set", [fnRef, "dynamicOwn", 42])), 42);

  // Prototype-chain escape hatches are denied at every dispatch read path.
  for (const blocked of ["__proto__", "constructor", "prototype"]) {
    assert.match(
      error(await rpc(env, "premiere", "dom", "get", [fnRef, blocked])).message,
      /not accessible/i,
      `dom.get must reject ${blocked}`
    );
  }
  for (const member of ["call", "apply", "bind"]) {
    assert.strictEqual(
      result(await rpc(env, "premiere", "dom", "get", [fnRef, member])),
      null,
      `dom.get must not expose Function.prototype.${member}`
    );
    assert.match(
      error(await rpc(env, "premiere", "dom", "call", [fnRef, member, []])).message,
      /not callable/i,
      `dom.call must reject Function.prototype.${member}`
    );
    assert.match(
      error(await rpc(env, "premiere", "dom", "construct", [fnRef, member, []])).message,
      /not a constructor/i,
      `dom.construct must reject Function.prototype.${member}`
    );
  }
  assert.deepStrictEqual(
    result(await rpc(env, "premiere", "dom", "snapshot", [fnRef, ["nativeStatic", "call", "apply", "bind"]])),
    { nativeStatic: 7, call: null, apply: null, bind: null }
  );
  const fnKeys = result(await rpc(env, "premiere", "dom", "keys", [fnRef]));
  assert.ok(fnKeys.includes("nativeStatic"));
  for (const member of ["call", "apply", "bind"]) {
    assert.ok(!fnKeys.includes(member), `dom.keys must not enumerate Function.prototype.${member}`);
  }

  // Object receivers still reach their host DOM prototype methods.
  const instanceRef = result(await rpc(env, "premiere", "dom", "construct", [moduleRef, "HostConstructor", []]));
  assert.strictEqual(result(await rpc(env, "premiere", "dom", "get", [instanceRef, "tag"])), "instance");
  assert.strictEqual(
    result(await rpc(env, "premiere", "dom", "call", [instanceRef, "hostMethod", ["ok"]])),
    "host:ok:instance"
  );
}

// Own-property boundary for the shared runtime member reader. Function receivers
// must never expose the Function/Object prototype chain escapes.
function testRuntimeMemberBoundary() {
  const source = fs.readFileSync(path.join(root, "bridges/uxp/core/src/runtime.ts"), "utf8");
  const { code } = require("esbuild").transformSync(source, { loader: "ts", format: "cjs", target: "es2020" });
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, require, console, globalThis: {} }, { filename: "runtime.ts" });
  const { property, readMember, BLOCKED_MEMBERS } = module.exports;
  assert.strictEqual(typeof readMember, "function", "a bounded readMember helper must be exported");
  for (const blocked of ["__proto__", "constructor", "prototype"]) {
    assert.ok(BLOCKED_MEMBERS.has(blocked), `${blocked} must be in the denylist`);
    assert.strictEqual(property({}, blocked), undefined, `${blocked} must not be readable on objects`);
  }
  assert.strictEqual(property({ own: 1 }, "own"), 1);
  const inherited = Object.create({ sharedMethod: 5 });
  assert.strictEqual(property(inherited, "sharedMethod"), 5, "object receivers still reach prototype methods");
  function hostConstructor() {}
  hostConstructor.nativeStatic = 7;
  assert.strictEqual(property(hostConstructor, "nativeStatic"), 7);
  for (const blocked of ["constructor", "__proto__", "prototype", "call", "apply", "bind"]) {
    assert.strictEqual(property(hostConstructor, blocked), undefined,
      `function receiver must not expose ${blocked} from the prototype chain`);
  }
  assert.strictEqual(property(null, "x"), undefined);
  assert.strictEqual(property("scalar", "length"), undefined);
}

function testManifestPermissions() {
  for (const host of ["photoshop", "indesign", "premiere"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "bridges", "uxp", host, "manifest.json"), "utf8"));
    const domains = manifest.requiredPermissions?.network?.domains;
    assert.ok(
      domains === "all" || domains.includes("ws://127.0.0.1:47391"),
      `${host} manifest must allow broker WebSocket`
    );
    if (host === "photoshop") assert.strictEqual(manifest.requiredPermissions.localFileSystem, "fullAccess");
    if (host === "premiere") assert.strictEqual(manifest.host.app, "premierepro");
    assert.ok(manifest.entrypoints.some((entry) => entry.type === "panel"), `${host} must declare an invokable panel`);
  }
}

// The Rust cross-layer regression supplies the production-generated config on
// stdin. Only UXP APIs are mocked here: do not inject __ADOBEPY_HOST_IDENTITY or
// fill identity fields from the bootstrap request.
async function emitPhotoshopGeneratedConfigHello() {
  const generatedConfig = fs.readFileSync(0, "utf8");
  assert.ok(generatedConfig.length > 0 && generatedConfig.length <= 64 * 1024);
  const env = await loadBundle("bridges/uxp/photoshop/dist/main.js", {
    photoshop: { app: { version: "26.5.1" } },
    uxp: {
      host: { name: "Adobe Photoshop", version: "26.5.1" },
      storage: {
        localFileSystem: {
          getPluginFolder: async () => ({ nativePath: "C:/UXP/External/com.adobepy.bridge.photoshop" })
        }
      }
    }
  }, {}, generatedConfig);
  assert.strictEqual(env.sent.length, 1);
  assert.strictEqual(env.sent[0].type, "hello");
  process.stdout.write(JSON.stringify({ url: env.socket.url, hello: env.sent[0] }));
}

async function main() {
  if (process.argv[2] === "--review-regressions") {
    await testNativeReviewRegressions();
    return;
  }
  if (process.argv[2] === "--photoshop-generated-config-hello") {
    await emitPhotoshopGeneratedConfigHello();
    return;
  }
  testManifestPermissions();
  await testNativeReviewRegressions();
  await testPhotoshopBridge();
  await testInDesignBridge();
  await testPremiereBridge();
  await testPremiereNativeReadQueries();
  await testPremiereAsyncNativeCollections();
  await testPremiereIdSerializationBoundaries();
  await testDomDispatchMemberBoundary();
  testRuntimeMemberBoundary();
  console.log("UXP bridge protocol test passed");
}

async function testNativeReviewRegressions() {
  class TickTime {
    constructor(seconds, ticks) { this.seconds = seconds; this.ticks = ticks; }
    static createWithSeconds(seconds) { return new TickTime(seconds); }
    static createWithTicks(ticks) { return new TickTime(undefined, ticks); }
    subtract(other) { return TickTime.createWithSeconds(this.seconds - other.seconds); }
  }
  TickTime.TIME_INVALID = new TickTime(-1);
  const media = { id: "media", name: "shot.mov" };
  const parent = { id: "parent", name: "Dailies" };
  const rootItem = { id: "root", name: "Root" };
  const clip = { getMediaFilePath: () => "C:/a/shot.mov" };
  const folderChildren = new Map([[rootItem, [parent]], [parent, [media]]]);
  const clips = new Map([[media, clip]]);
  let mutationsSucceed = true;
  const markerList = [];
  const nativeMarker = (name, markerType, start, duration, comments) => ({
    getName: () => name, getType: () => markerType, getStart: () => start,
    getDuration: () => duration, getComments: () => comments
  });
  const markers = {
    getMarkers: () => markerList,
    createAddMarkerAction(name, type, start, duration, comments) {
      assert.ok(start instanceof TickTime && duration instanceof TickTime);
      return () => markerList.push(nativeMarker(name, type, start, duration, comments));
    }
  };
  const folders = new Map(Array.from(folderChildren, ([item, children]) => [item, {
    getItems: () => children,
    createBinAction: (name) => () => {
      const created = { id: `new-${children.length}`, name };
      children.push(created);
      folders.set(created, { getItems: () => [] });
    }
  }]));
  const sequence = { id: "seq", name: "Sequence" };
  const project = {
    getRootItem: () => rootItem, getActiveSequence: () => sequence,
    getSequences: () => [sequence], save: () => mutationsSucceed, saveAs: () => mutationsSucceed,
    lockedAccess(callback) { callback(); },
    executeTransaction(callback) {
      if (!mutationsSucceed) return false;
      const actions = [];
      callback({ addAction: (action) => actions.push(action) });
      actions.forEach((action) => action());
      return true;
    },
    importFiles(paths) {
      if (!mutationsSucceed) return false;
      for (const path of paths) {
        const item = { id: `import-${path}`, name: path.split("/").pop() };
        folderChildren.get(parent).push(item);
        clips.set(item, { getMediaFilePath: () => path });
      }
      return true;
    }
  };
  const encoded = [];
  const modules = {
    premierepro: {
      version: "25.6.0", Project: { getActiveProject: () => project }, TickTime,
      FolderItem: { cast: (item) => folders.get(item) },
      ClipProjectItem: { cast: (item) => clips.get(item) },
      Markers: { getMarkers: (owner) => { assert.strictEqual(owner, sequence); return markers; } },
      Marker: { MARKER_TYPE_COMMENT: "Comment" },
      SequenceEditor: { getEditor: () => ({
        createInsertProjectItemAction: (item, time) => { assert.ok(time instanceof TickTime); return () => {}; },
        createOverwriteItemAction: () => () => {}
      }) },
      EncoderManager: { getManager: () => ({
        encodeFile: (...args) => { encoded.push(args); assert.ok(args[3] instanceof TickTime && args[4] instanceof TickTime); return true; },
        encodeProjectItem: (item) => { assert.strictEqual(item, clip); return true; }
      }) },
      Exporter: { exportSequenceFrame: (seq, time) => { assert.ok(time instanceof TickTime); return true; } }
    },
    uxp: { host: { version: "25.6.0" } }
  };
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", modules);
  const failures = [];
  async function check(name, callback) {
    try { await callback(); } catch (err) { failures.push(`${name}: ${err.message}`); }
  }
  for (const [namespace, method, args] of [
    ["project", "save", []], ["project", "saveAs", ["C:/out.prproj"]],
    ["project", "importFiles", [{ filePaths: ["C:/a/shot.mov"] }]],
    ["sequence", "insertProjectItem", ["seq", { projectItem: "media", time: 1 }]],
    ["sequence", "overwriteProjectItem", ["seq", { projectItem: "media", time: 1 }]],
    ["bin", "create", [{ parentId: "parent", name: "Rejected" }]],
    ["marker", "create", ["seq", { name: "Rejected" }]]
  ]) {
    await check(`${namespace}.${method} false result`, async () => {
      mutationsSucceed = false;
      assert.strictEqual(error(await rpc(env, "premiere", namespace, method, args)).code, -32004);
      mutationsSucceed = true;
    });
    mutationsSucceed = true;
  }
  await check("native time factories", async () => {
    result(await rpc(env, "premiere", "sequence", "insertProjectItem", ["seq", { projectItem: "media", time: { ticks: "254016000000" } }]));
    result(await rpc(env, "premiere", "export", "exportFrame", [{ sequence: "seq", outputPath: "C:/out.png", time: 1 }]));
    result(await rpc(env, "premiere", "encoder", "encodeFile", [{ sourcePath: "C:/in.mov", outputPath: "C:/out.mov" }]));
    assert.strictEqual(encoded[0][4], TickTime.TIME_INVALID);
  });
  await check("FolderItem and new direct child", async () => {
    const created = result(await rpc(env, "premiere", "bin", "create", [{ parentId: "parent", name: "Dailies" }]));
    assert.strictEqual(created.name, "Dailies");
    assert.notStrictEqual(created.id, parent.id);
  });
  await check("exact imported path", async () => {
    const imported = result(await rpc(env, "premiere", "project", "importFiles", [{ filePaths: ["C:/b/shot.mov"], targetBin: "parent" }]));
    assert.strictEqual(imported[0].mediaPath, "C:/b/shot.mov");
    const importFiles = project.importFiles;
    project.importFiles = () => true;
    const unknown = { id: "unknown-path", name: "unknown.mov", typename: "ClipProjectItem" };
    folderChildren.get(parent).push(unknown);
    clips.set(unknown, { getMediaFilePath: () => undefined });
    assert.deepStrictEqual(result(await rpc(env, "premiere", "project", "importFiles", [{ filePaths: ["C:/b/unknown.mov"], targetBin: "parent" }])), []);
    project.importFiles = importFiles;
  });
  await check("ClipProjectItem encoder cast", async () => {
    result(await rpc(env, "premiere", "encoder", "encodeProjectItem", [{ projectItemId: "media", outputPath: "C:/out.mov" }]));
    assert.strictEqual(error(await rpc(env, "premiere", "encoder", "encodeProjectItem", [{ projectItemId: "parent", outputPath: "C:/out.mov" }])).code, -32004);
  });
  await check("native marker transaction and reads", async () => {
    const created = result(await rpc(env, "premiere", "marker", "create", ["seq", { name: "Review", start: 2, duration: 1, comments: "check" }]));
    assert.strictEqual(created.name, "Review");
    const listed = result(await rpc(env, "premiere", "marker", "getMarkers", ["seq"]));
    assert.strictEqual(listed[0].comments, "check");
    assert.strictEqual(listed[0].start, 2);
    const second = result(await rpc(env, "premiere", "marker", "create", ["seq", { name: "Until", start: 2, end: 5 }]));
    assert.strictEqual(second.duration, 3);
  });
  const activeLayer = { id: 1, name: "User layer" };
  const requestedLayer = { id: 7, name: "Requested" };
  const ownerSelectedLayer = { id: 8, name: "Another selected layer" };
  const owner = { id: 9, layers: [requestedLayer, ownerSelectedLayer], activeLayers: [ownerSelectedLayer] };
  const app = { activeDocument: { id: 2, layers: [activeLayer], activeLayers: [activeLayer] }, documents: [owner] };
  app.documents.unshift(app.activeDocument);
  let pickerCalls = 0;
  const commands = [];
  const ps = await loadBundle("bridges/uxp/photoshop/dist/main.js", {
    photoshop: { app, action: { batchPlay: async (descriptors) => { commands.push(...descriptors); return []; } } },
    uxp: { storage: { localFileSystem: {
      getEntryWithUrl: async () => { throw new Error("requested path missing"); },
      getFileForOpening: async () => { pickerCalls++; return {}; }, createSessionToken: () => "unexpected"
    } } }
  });
  await check("smart object owning document", async () => {
    assert.strictEqual(result(await rpc(ps, "photoshop", "smartObject", "editContents", [7])).id, 7);
    for (const command of commands) assert.ok(command._target.some((target) => target._ref === "document" && target._id === owner.id));
  });
  await check("explicit path must never invoke picker", async () => {
    assert.match(error(await rpc(ps, "photoshop", "smartObject", "replaceContents", [7, "C:/missing.psb"])).message, /requested path missing/);
    assert.strictEqual(pickerCalls, 0);
  });
  assert.deepStrictEqual(failures, [], failures.join("\n"));
  console.log("Native contract review regressions passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
