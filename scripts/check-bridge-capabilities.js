#!/usr/bin/env node
"use strict";

const assert = require("assert");
const esbuild = require("esbuild");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const registryPath = path.join(root, "generators", "api_sources", "adobe_api_sources.json");

const entries = [
  {
    host: "photoshop",
    entry: "bridges/uxp/photoshop/src/main.ts",
    globals: {
      photoshop: {
        app: { version: "test-photoshop" },
        action: {},
        core: {},
      },
      uxp: { host: { version: "test-uxp" } },
    },
  },
  {
    host: "indesign",
    entry: "bridges/uxp/indesign/src/main.ts",
    globals: {
      indesign: { app: { version: "test-indesign" } },
    },
  },
  {
    host: "premiere",
    entry: "bridges/uxp/premiere/src/main.ts",
    globals: {
      premierepro: { version: "test-premiere" },
      uxp: { host: { version: "test-uxp" } },
    },
  },
  {
    host: "after-effects",
    entry: "bridges/cep/after-effects/src/main.ts",
    globals: {},
  },
  {
    host: "illustrator",
    entry: "bridges/cep/illustrator/src/main.ts",
    globals: {},
  },
];

function waitForMicrotasks() {
  return new Promise((resolve) => setImmediate(resolve));
}

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function sourceRegistry() {
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  return new Map(registry.sources.map((source) => [source.host, source]));
}

function expectedCapabilities(host, sources) {
  const source = sources.get(host);
  assert.ok(source, `missing API source entry for ${host}`);
  const ir = readJson(source.ir);
  return {
    host,
    bridgeKind: source.bridgeKind,
    bridgeVersion: ir.version,
    namespaces: ir.namespaces.map((namespace) => namespace.name),
    methods: Object.fromEntries(
      ir.namespaces
        .filter((namespace) => Array.isArray(namespace.methods) && namespace.methods.length > 0)
        .map((namespace) => [namespace.name, namespace.methods.map((method) => method.name)]),
    ),
  };
}

function bundleEntry(entry) {
  const result = esbuild.buildSync({
    absWorkingDir: root,
    bundle: true,
    entryPoints: [entry],
    format: "iife",
    logLevel: "silent",
    platform: "browser",
    sourcemap: false,
    write: false,
  });
  return result.outputFiles[0].text;
}

async function captureCapabilities(entry) {
  const sent = [];
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
      if (script.includes("typeof adobepyDispatch")) {
        callback("ready");
        return;
      }
      callback(JSON.stringify({ jsonrpc: "2.0", id: "unused", result: null }));
    }
  };

  const context = {
    ...entry.globals,
    console: { ...console, log() {} },
    setImmediate,
    setTimeout,
    WebSocket: FakeWebSocket,
    __adobe_cep__: fakeCep,
    document: { getElementById() { return { textContent: "", addEventListener() {} }; } },
    __ADOBEPY_TOKEN: "test-token",
    __ADOBEPY_TARGET: "default",
    require(name) {
      if (Object.prototype.hasOwnProperty.call(entry.globals, name)) return entry.globals[name];
      throw new Error(`missing test module: ${name}`);
    },
  };
  context.globalThis = context;

  const code = bundleEntry(entry.entry);
  vm.runInNewContext(code, context, { filename: entry.entry });
  await waitForMicrotasks();

  assert.ok(socketInstance, `${entry.host}: bridge did not open a WebSocket`);
  const hello = sent.find((message) => message.type === "hello");
  assert.ok(hello, `${entry.host}: bridge did not send hello capabilities`);
  return hello.capabilities;
}

function assertCapabilitiesMatch(host, actual, expected) {
  assert.strictEqual(actual.host, expected.host, `${host}: host mismatch`);
  assert.strictEqual(actual.bridgeKind, expected.bridgeKind, `${host}: bridgeKind mismatch`);
  assert.strictEqual(actual.bridgeVersion, expected.bridgeVersion, `${host}: bridgeVersion mismatch`);
  assert.deepStrictEqual(actual.namespaces, expected.namespaces, `${host}: namespaces must match IR order`);
  assert.deepStrictEqual(actual.methods, expected.methods, `${host}: methods must match IR exactly`);

  for (const namespace of Object.keys(actual.methods || {})) {
    assert.ok(actual.namespaces.includes(namespace), `${host}: methods mention unknown namespace ${namespace}`);
  }
}

async function main() {
  const sources = sourceRegistry();
  for (const entry of entries) {
    const actual = await captureCapabilities(entry);
    const expected = expectedCapabilities(entry.host, sources);
    assertCapabilitiesMatch(entry.host, actual, expected);
    console.log(`bridge capability ok: ${entry.host}`);
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
