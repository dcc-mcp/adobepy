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

  // bridges/cep/illustrator/src/main.ts
  startCepBridge({
    host: "illustrator",
    brokerUrl: globalThis.__ADOBEPY_BROKER_URL || "ws://127.0.0.1:47391/v1/bridge/illustrator/ws",
    token: globalThis.__ADOBEPY_TOKEN || "dev-token",
    target: globalThis.__ADOBEPY_TARGET || "default",
    capabilities: {
      host: "illustrator",
      bridgeKind: "cep",
      bridgeVersion: "0.1.0",
      namespaces: ["app", "document", "artboard", "layer", "pageItem", "pathItem", "compoundPath", "placedItem", "rasterItem", "raw"],
      features: ["extendscript", "document", "artboards", "layers", "pageItems", "selection", "pathItems", "compoundPathItems", "placedItems", "rasterItems"],
      methods: {
        app: ["getVersion"],
        document: ["getActive"],
        artboard: ["getArtboards", "getActive", "getActiveIndex"],
        layer: ["getLayers", "getByName", "getChildren"],
        pageItem: ["getPageItems", "getSelected", "getByName", "getLayerItems"],
        pathItem: ["getPathItems", "getSelected", "getByName", "getLayerItems"],
        compoundPath: ["getCompoundPathItems", "getSelected", "getByName", "getLayerItems", "getPathItems"],
        placedItem: ["getPlacedItems", "getSelected", "getByName", "getLayerItems"],
        rasterItem: ["getRasterItems", "getSelected", "getByName", "getLayerItems"],
        raw: ["evalExtendScript"]
      }
    }
  });
})();
//# sourceMappingURL=main.js.map
