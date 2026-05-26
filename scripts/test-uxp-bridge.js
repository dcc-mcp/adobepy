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
  const document = {
    id: 9,
    title: "demo.psd",
    width: { valueOf: () => 1920 },
    height: { valueOf: () => 1080 },
    resolution: 72,
    saved: true,
    activeLayers: [{ id: 7, name: "Layer 1", kind: "pixel", opacity: 80, visible: true }],
    layers: [
      { id: 7, name: "Layer 1", kind: "pixel", opacity: 80, visible: true },
      { id: 8, name: "Group", kind: "group", layers: [{ id: 10, name: "Child" }] }
    ],
    selection,
    channels,
    activeChannels: [channels[0]],
    componentChannels: [channels[1]],
    saveAs: {
      psd: async (entry, options, asCopy) => events.push({ kind: "saveAs", url: entry.url, options, asCopy }),
      png: async (entry, options, asCopy) => events.push({ kind: "saveAs", url: entry.url, options, asCopy })
    }
  };
  const env = await loadBundle("bridges/uxp/photoshop/dist/main.js", {
    photoshop: {
      app: { version: "26.5.1", activeDocument: document, documents: [document] },
      action: {
        batchPlay: async (descriptors, options) => {
          events.push({ kind: "batchPlay", descriptors, options });
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
          createEntryWithUrl: async (url) => ({ url })
        }
      }
    }
  });

  assert.strictEqual(env.sent[0].type, "hello");
  assert.strictEqual(env.sent[0].capabilities.hostVersion, "26.5.1");
  assert.ok(env.sent[0].capabilities.methods.document.includes("getLayers"));
  assert.ok(env.sent[0].capabilities.methods.selection.includes("selectRectangle"));
  assert.ok(env.sent[0].capabilities.methods.channel.includes("getChannels"));
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
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "getPath", [["app", "activeDocument", "layers", 0, "name"]], {})), "Layer 1");
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "action", "batchPlay", [[{ _obj: "hide" }], { synchronousExecution: true }], { modal: true, commandName: "Hide" })), [{ _obj: "hide" }]);
  assert.deepStrictEqual(result(await rpc(env, "photoshop", "document", "saveAs", [{ id: 9, path: "C:/out.psd", format: "psd" }], { modal: true, commandName: "Save" })).id, 9);
  assert.strictEqual(result(await rpc(env, "photoshop", "raw", "evalJs", ["1 + 1"])), 2);
  assert.strictEqual(error(await rpc(env, "photoshop", "bad", "missing")).code, -32601);
  assert.ok(events.some((event) => event.kind === "modal" && event.commandName === "Hide"));
  assert.ok(events.some((event) => event.kind === "saveAs" && event.url === "file:///C:/out.psd"));
  assert.ok(events.some((event) => event.kind === "selection.selectRectangle"));
  assert.ok(events.some((event) => event.kind === "channel.remove"));
}

async function testInDesignBridge() {
  const env = await loadBundle("bridges/uxp/indesign/dist/main.js", {
    indesign: {
      app: {
        version: "19.5.0",
        activeDocument: { id: 3, name: "layout.indd", fullName: { fsName: "C:/layout.indd" }, width: 800, height: 600 }
      }
    }
  });
  assert.strictEqual(env.sent[0].capabilities.host, "indesign");
  assert.strictEqual(result(await rpc(env, "indesign", "app", "getVersion")), "19.5.0");
  assert.strictEqual(result(await rpc(env, "indesign", "document", "getActive")).path, "C:/layout.indd");
  assert.strictEqual(result(await rpc(env, "indesign", "raw", "evalJs", ["40 + 2"])), 42);
}

async function testPremiereBridge() {
  const env = await loadBundle("bridges/uxp/premiere/dist/main.js", {
    premierepro: {
      version: "25.6.0",
      Project: {
        getActiveProject() {
          return { guid: "project-1", name: "cut.prproj", path: "C:/cut.prproj", itemCount: 3 };
        }
      }
    }
  });
  assert.strictEqual(env.sent[0].capabilities.host, "premiere");
  assert.strictEqual(result(await rpc(env, "premiere", "app", "getVersion")), "25.6.0");
  assert.deepStrictEqual(result(await rpc(env, "premiere", "project", "getActive")), {
    id: "project-1",
    guid: "project-1",
    name: "cut.prproj",
    path: "C:/cut.prproj",
    itemCount: 3
  });
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
