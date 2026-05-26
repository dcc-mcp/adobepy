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

async function loadBundle(relativeBundlePath, modules) {
  const bundlePath = path.join(root, relativeBundlePath);
  assert.ok(fs.existsSync(bundlePath), `missing UXP bundle: ${bundlePath}`);
  const sent = [];
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

  const context = {
    console,
    setImmediate,
    setTimeout,
    WebSocket: FakeWebSocket,
    require(name) {
      if (Object.prototype.hasOwnProperty.call(modules, name)) return modules[name];
      throw new Error(`missing test module: ${name}`);
    },
    __ADOBEPY_TOKEN: "test-token"
  };
  context.globalThis = context;
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
  assert.strictEqual(message.type, "response");
  return message.response.result;
}

function error(message) {
  assert.strictEqual(message.type, "error");
  return message.error.error;
}

async function testPhotoshopBridge() {
  const events = [];
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
    { id: 22, name: "Red", kind: "component", visible: true, typename: "Channel" }
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
      app: { version: "26.5.1", activeDocument: document, documents: [document] },
      action: {
        batchPlay: async (descriptors, options) => {
          events.push({ kind: "batchPlay", descriptors, options });
          if (descriptors.some((descriptor) => descriptor._obj === "newPlacedLayer")) textLayer.kind = "smartObject";
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
      storage: {
        localFileSystem: {
          createEntryWithUrl: async (url) => ({ url }),
          getEntryWithUrl: async (url) => ({ url }),
          createSessionToken: async (entry) => `token:${entry.url}`
        }
      }
    }
  });

  assert.strictEqual(env.sent[0].type, "hello");
  assert.strictEqual(env.sent[0].capabilities.hostVersion, "26.5.1");
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
    result(await rpc(env, "photoshop", "selection", "selectRectangle", [9, { top: 4, left: 5, bottom: 9, right: 10 }, "replace", 0, true], { modal: true })).bounds.left,
    5
  );
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
  assert.deepStrictEqual(
    result(await rpc(env, "photoshop", "export", "exportWithPreset", [{ id: 9, path: "C:/out.jpg", preset: "jpg_high", options: { quality: 10 } }], { modal: true })).id,
    9
  );
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "getPath", [["app", "activeDocument", "layers", 0, "name"]], {})), "Layer 1");
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "action", "batchPlay", [[{ _obj: "hide" }], { synchronousExecution: true }], { modal: true, commandName: "Hide" })), [{ _obj: "hide" }]);
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "document", "saveAs", [{ id: 9, path: "C:/out.psd", format: "psd" }], { modal: true, commandName: "Save" })).id, 9);
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "evalJs", ["1 + 1"])), 2);
  assert.strictEqual(error(await rpc(env, "photoshop", "bad", "missing")).code, -32601);
  assert.ok(events.some((event) => event.kind === "modal" && event.commandName === "Hide"));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/out.psd"));
  assert.ok(events.some((event) => event.kind === "selection.selectRectangle"));
  assert.ok(events.some((event) => event.kind === "channel.remove"));
  assert.ok(events.some((event) => event.kind === "text.convertToShape"));
  assert.ok(events.some((event) => event.kind === "filter.applyGaussianBlur" && event.radius === 2));
  assert.ok(events.some((event) => event.kind === "batchPlay" && event.descriptors.some((descriptor) => descriptor._obj === "newPlacedLayer")));
  assert.ok(events.some((event) => event.kind === "batchPlay" && event.descriptors.some((descriptor) => descriptor._obj === "placedLayerReplaceContents")));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/out.jpg" && event.options.quality === 10));
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
  assert.strictEqual(result(await rpc(env, "indesign", "raw", "evalJs", ["40 + 2"])), 42);
  assert.ok(events.some((event) => event.kind === "page.select" && event.existingSelection === "replace"));
  assert.ok(events.some((event) => event.kind === "doScript" && event.commandName === "Text"));
  assert.ok(events.some((event) => event.kind === "doScript" && event.commandName === "Story"));
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
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: {
      version: "25.6.0",
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
  assert.ok(env.sent[0].capabilities.methods.sequence.includes("getVideoTracks"));
  assert.ok(env.sent[0].capabilities.methods.track.includes("getClips"));
  assert.ok(env.sent[0].capabilities.methods.clip.includes("getSelected"));
  assert.ok(env.sent[0].capabilities.methods.projectItem.includes("getChildren"));
  assert.ok(env.sent[0].capabilities.methods.bin.includes("create"));
  assert.ok(env.sent[0].capabilities.methods.marker.includes("create"));
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
  assert.strictEqual(result(await rpc(env, "premiere", "raw", "evalJs", ["6 * 7"])), 42);
}

function testManifestPermissions() {
  for (const host of ["photoshop", "indesign", "premiere"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "bridges", "uxp", host, "manifest.json"), "utf8"));
    const domains = manifest.requiredPermissions?.network?.domains;
    assert.ok(
      domains === "all" || domains.includes("ws://127.0.0.1:47391"),
      `${host} manifest must allow broker WebSocket`
    );
    if (host === "photoshop") assert.strictEqual(manifest.requiredPermissions.localFileSystem, "request");
  }
}

async function main() {
  testManifestPermissions();
  await testPhotoshopBridge();
  await testInDesignBridge();
  await testPremiereBridge();
  console.log("UXP bridge protocol test passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
