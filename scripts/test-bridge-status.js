#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");

async function loadPanel(host, options = {}) {
  const status = { textContent: "Bridge not started." };
  const sent = [];
  const logs = [];
  const errors = [];
  const sockets = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      this.listeners = {};
      this.closed = false;
      sockets.push(this);
    }
    addEventListener(name, listener) {
      (this.listeners[name] ||= []).push(listener);
    }
    send(payload) { sent.push(JSON.parse(payload)); }
    close() { this.closed = true; this.readyState = 3; }
    async emit(name, event = {}) {
      if (name === "open") this.readyState = 1;
      if (name === "close") this.readyState = 3;
      const listeners = [...(this.listeners[name] || [])];
      if (this[`on${name}`]) listeners.push(this[`on${name}`]);
      await Promise.all(listeners.map((listener) => Promise.resolve().then(() => listener(event))));
    }
  }
  const cep = {
    getSystemPath() { return "C:/extension"; },
    evalScript(script, callback) {
      if (script.startsWith("$.evalFile(")) return callback("true");
      if (script.includes("typeof adobepyDispatch")) return callback(options.runtimeMissing ? "missing" : "ready");
      if (script.includes("typeof app === \"object\"")) return callback("25.0.0");
      const match = script.match(/^adobepyDispatch\((.*)\)$/);
      assert.ok(match, `unexpected host script: ${script}`);
      const request = JSON.parse(JSON.parse(match[1]));
      callback(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: "25.0.0" }));
    }
  };
  const context = {
    console: { log: (...args) => logs.push(args[0]), error: (...args) => errors.push(args[0]) },
    setTimeout, clearTimeout, WebSocket: FakeWebSocket,
    document: { getElementById(id) { return id === "adobepy-bridge-status" ? status : null; } },
    __ADOBEPY_TOKEN: options.token === undefined ? "PRIVATE_TEST_TOKEN" : options.token,
    __adobe_cep__: options.cepMissing ? undefined : cep,
    require(name) {
      if (name === "premierepro") return { version: "25.6.0" };
      throw new Error(`missing test module: ${name}`);
    }
  };
  context.globalThis = context;
  const kind = host === "after-effects" ? "cep" : "uxp";
  const bundle = path.join(root, "bridges", kind, host, "dist", "main.js");
  let startupError;
  try { vm.runInNewContext(fs.readFileSync(bundle, "utf8"), context, { filename: bundle }); }
  catch (error) { startupError = error; }
  await new Promise((resolve) => setImmediate(resolve));
  return { status, sent, logs, errors, sockets, startupError };
}

async function main() {
  for (const host of ["after-effects", "premiere"]) {
    const panel = await loadPanel(host);
    assert.match(panel.status.textContent, /Connecting to broker/);
    assert.strictEqual(panel.sent.length, 0, "initialization must not claim a connection");
    await panel.sockets[0].emit("open");
    assert.strictEqual(panel.sent[0].type, "hello");
    assert.match(panel.status.textContent, /service ready.*not verified/);
    assert.ok(!panel.logs.includes("adobepy CEP bridge connected"));
    await panel.sockets[0].emit("message", { data: JSON.stringify({ type: "request", request: {
      jsonrpc: "2.0", id: "status-query", host, namespace: "app", method: "getVersion", args: []
    } }) });
    assert.strictEqual(panel.sent[1].type, "response");
    assert.match(panel.status.textContent, /not verified/, "a host RPC is not client identity attestation");
    await panel.sockets[0].emit("close");
    assert.match(panel.status.textContent, /^Disconnected/);
    assert.strictEqual(panel.sockets.length, 1, "status UI must not introduce automatic reconnects");

    const missingToken = await loadPanel(host, { token: "" });
    assert.match(missingToken.status.textContent, /Bridge not ready/);
    assert.strictEqual(missingToken.sockets.length, 0);
    if (host === "after-effects") assert.match(missingToken.startupError.message, /ADOBEPY_TOKEN is missing/);
    else assert.ok(missingToken.errors.some((message) => message.includes("ADOBEPY_TOKEN is missing")));

    for (const event of ["error", "rejection", "malformed", "invalid-envelope", "envelope-error"]) {
      const failed = await loadPanel(host);
      await failed.sockets[0].emit("open");
      if (event === "error") await failed.sockets[0].emit("error", { message: "PRIVATE_ERROR" });
      else if (event === "malformed") {
        // A bad frame must be adjudicated, not thrown out of the message handler.
        await failed.sockets[0].emit("message", { data: "{" });
        assert.strictEqual(failed.sent.length, 2, "a malformed frame must be answered, not thrown");
        assert.strictEqual(failed.sent[1].type, "error", "use the shared BridgeError envelope");
        assert.strictEqual(failed.sent[1].error.error.code, -32700);
        assert.ok(failed.sockets[0].closed, "a malformed frame must close the transport safely");
      } else if (event === "invalid-envelope") {
        await failed.sockets[0].emit("message", { data: "[]" });
        assert.strictEqual(failed.sent[1].type, "error", "non-object frames are protocol violations");
        assert.strictEqual(failed.sent[1].error.error.code, -32700);
        assert.ok(failed.sockets[0].closed);
      } else if (event === "envelope-error") {
        // The same protocol's BridgeError envelope must fail the status closed.
        await failed.sockets[0].emit("message", { data: JSON.stringify({
          type: "error", error: { jsonrpc: "2.0", id: "broker-reject", error: { code: -32009, message: "PRIVATE_ERROR" } }
        }) });
      } else await failed.sockets[0].emit("message", { data: JSON.stringify({
        jsonrpc: "2.0", error: { code: -32009, message: "PRIVATE_ERROR" }
      }) });
      await failed.sockets[0].emit("close", { reason: "PRIVATE_ERROR" });
      assert.match(failed.status.textContent, /Bridge not ready/);
      assert.ok(!failed.status.textContent.includes("PRIVATE"), "untrusted error details must stay out of the UI");
    }

    const closing = await loadPanel(host);
    await Promise.all([closing.sockets[0].emit("open"), closing.sockets[0].emit("close")]);
    assert.match(closing.status.textContent, /^Disconnected/, "late open completion must not overwrite disconnect");
    assert.strictEqual(closing.sent.length, 0);
  }
  const missingRuntime = await loadPanel("after-effects", { runtimeMissing: true });
  assert.match(missingRuntime.status.textContent, /Bridge not ready/);
  assert.strictEqual(missingRuntime.sockets.length, 0);
  const missingCep = await loadPanel("after-effects", { cepMissing: true });
  assert.match(missingCep.status.textContent, /Bridge not ready/);
  assert.match(missingCep.startupError.message, /CEP evalScript API unavailable/);
  console.log("Bridge panel lifecycle status tests passed (mock hosts/transports; no native UI acceptance)");
}

main().catch((error) => { console.error(error); process.exit(1); });
