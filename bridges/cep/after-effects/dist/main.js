"use strict";
(() => {
  // bridges/cep/core/src/protocol.ts
  var ERROR_CODES = Object.freeze({
    ERROR_PARSE: -32700,
    ERROR_INVALID_REQUEST: -32600,
    ERROR_METHOD_NOT_FOUND: -32601,
    ERROR_HOST_NOT_RUNNING: -32001,
    ERROR_BRIDGE_NOT_INSTALLED: -32002,
    ERROR_CAPABILITY: -32003,
    ERROR_HOST_SCRIPT: -32004,
    ERROR_PERMISSION: -32005,
    ERROR_MODAL_REQUIRED: -32006,
    ERROR_TIMEOUT: -32007,
    ERROR_SERIALIZATION: -32008,
    ERROR_UNAUTHORIZED: -32009
  });

  // bridges/cep/core/src/rpc.ts
  function startCepBridge(config) {
    const socket = new WebSocket(config.brokerUrl);
    const cs = new CSInterface();
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: "hello", token: config.token, target: config.target, capabilities: config.capabilities }));
      console.log("adobepy CEP bridge connected", config.capabilities);
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== "request") return;
      const request = message.request;
      const encoded = encodeURIComponent(JSON.stringify(request)).replace(/'/g, "%27");
      try {
        cs.evalScript(`adobepyDispatch(decodeURIComponent('${encoded}'))`, (raw) => {
          var _a;
          try {
            const parsed = raw ? JSON.parse(raw) : { jsonrpc: "2.0", id: request.id, result: null };
            if (parsed.error) {
              socket.send(JSON.stringify({ type: "error", error: { ...parsed, id: (_a = parsed.id) != null ? _a : request.id } }));
              return;
            }
            if (!Object.prototype.hasOwnProperty.call(parsed, "result")) parsed.result = null;
            socket.send(JSON.stringify({ type: "response", response: parsed }));
          } catch (error) {
            socket.send(JSON.stringify({ type: "error", error: hostScriptError(request.id, error) }));
          }
        });
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", error: hostScriptError(request.id, error) }));
      }
    });
  }
  function hostScriptError(id, error) {
    return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: (error == null ? void 0 : error.message) || String(error) } };
  }

  // bridges/cep/after-effects/src/main.ts
  startCepBridge({
    host: "after-effects",
    brokerUrl: globalThis.__ADOBEPY_BROKER_URL || "ws://127.0.0.1:47391/v1/bridge/after-effects/ws",
    token: globalThis.__ADOBEPY_TOKEN || "dev-token",
    target: globalThis.__ADOBEPY_TARGET || "default",
    capabilities: {
      host: "after-effects",
      bridgeKind: "cep",
      bridgeVersion: "0.1.0",
      namespaces: ["app", "project", "item", "layer", "mask", "effect", "text", "raw"],
      features: ["extendscript", "projectInfo", "projectItems", "compositions", "footageItems", "layers", "masks", "effects", "text"],
      methods: {
        app: ["getVersion"],
        project: ["getActive", "getItems", "getCompositions", "getFootageItems", "getFolders", "getActiveItem", "getSelectedItems"],
        item: ["getById", "getByName"],
        layer: ["getLayers", "getSelected", "getById"],
        mask: ["getMasks"],
        effect: ["getEffects", "getByName"],
        text: ["getSourceText", "setSourceText"],
        raw: ["evalExtendScript"]
      }
    }
  });
})();
//# sourceMappingURL=main.js.map
