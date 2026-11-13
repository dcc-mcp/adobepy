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
    ERROR_UNAUTHORIZED: -32009,
    ERROR_IDENTITY_UNAVAILABLE: -32010,
    ERROR_IDENTITY_STALE: -32011,
    ERROR_IDENTITY_AMBIGUOUS: -32012,
    ERROR_IDENTITY_MISMATCH: -32013
  });

  // bridges/cep/core/src/system-path.ts
  function cepSystemPath(value) {
    if (typeof value !== "string") return void 0;
    let path = value;
    if (/^file:\/\//i.test(path)) {
      try {
        path = decodeURI(path).replace(/^file:\/\//i, "");
      } catch (e) {
        return void 0;
      }
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    }
    path = path.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!path || path.length > 32768 || path.trim() !== path || /[\u0000-\u001f\u007f]/.test(path)) return void 0;
    if (!path.startsWith("/") && !/^[A-Za-z]:\//.test(path)) return void 0;
    if (path.split("/").some((part) => part === "." || part === "..")) return void 0;
    return path;
  }

  // bridges/cep/core/src/rpc.ts
  function startCepBridge(config) {
    var _a, _b, _c, _d;
    (_a = config.onStatus) == null ? void 0 : _a.call(config, "starting");
    const cep = globalThis.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== "function") {
      (_b = config.onStatus) == null ? void 0 : _b.call(config, "error");
      throw new Error("Adobe CEP evalScript API unavailable");
    }
    if (typeof config.token !== "string" || config.token.trim() === "") {
      (_c = config.onStatus) == null ? void 0 : _c.call(config, "error");
      throw new Error("ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
    }
    const extensionPath = cepSystemPath(cep.getSystemPath("extension"));
    if (!extensionPath) {
      (_d = config.onStatus) == null ? void 0 : _d.call(config, "error");
      throw new Error("Adobe CEP extension path unavailable");
    }
    const connect = async () => {
      var _a2, _b2, _c2;
      (_a2 = config.onStatus) == null ? void 0 : _a2.call(config, "connecting");
      let failed = false;
      let identity;
      if (config.identityProvider) {
        try {
          const provided = config.identityProvider();
          identity = provided && typeof provided.then === "function" ? await provided : provided;
        } catch (e) {
          failed = true;
          (_b2 = config.onStatus) == null ? void 0 : _b2.call(config, "error");
          console.error("[adobepy] runtime identity is unavailable; exact-instance verification will fail closed.");
        }
      }
      const bootstrapNonce = boundedBootstrapNonce(globalThis.__ADOBEPY_BOOTSTRAP_NONCE);
      const capabilities = (identity == null ? void 0 : identity.host.hostVersion) ? { ...config.capabilities, hostVersion: identity.host.hostVersion } : config.capabilities;
      let socket;
      try {
        socket = new WebSocket(config.brokerUrl);
      } catch (error) {
        (_c2 = config.onStatus) == null ? void 0 : _c2.call(config, "error");
        throw error;
      }
      let greeted = false;
      const greet = () => {
        var _a3, _b3;
        if (greeted || socket.readyState !== 1) return;
        greeted = true;
        try {
          socket.send(JSON.stringify({
            type: "hello",
            token: config.token,
            target: config.target,
            capabilities,
            ...identity ? { identity } : {},
            ...bootstrapNonce ? { bootstrapNonce } : {}
          }));
        } catch (error) {
          failed = true;
          (_a3 = config.onStatus) == null ? void 0 : _a3.call(config, "error");
          throw error;
        }
        (_b3 = config.onStatus) == null ? void 0 : _b3.call(config, failed ? "error" : "ready");
        console.log("adobepy CEP bridge hello sent; connection verification pending", capabilities);
      };
      socket.onopen = greet;
      socket.onerror = () => {
        var _a3;
        failed = true;
        (_a3 = config.onStatus) == null ? void 0 : _a3.call(config, "error");
      };
      socket.onclose = () => {
        var _a3;
        return (_a3 = config.onStatus) == null ? void 0 : _a3.call(config, failed ? "error" : "disconnected");
      };
      setTimeout(greet, 0);
      const reportProtocolViolation = (reason) => {
        var _a3;
        failed = true;
        (_a3 = config.onStatus) == null ? void 0 : _a3.call(config, "error");
        console.error("[adobepy] ".concat(reason));
        try {
          socket.send(JSON.stringify({
            type: "error",
            error: {
              jsonrpc: "2.0",
              id: null,
              error: { code: ERROR_CODES.ERROR_PARSE, message: "Invalid bridge frame" }
            }
          }));
        } catch (e) {
        }
        if (typeof socket.close === "function") socket.close();
      };
      socket.onmessage = (event) => {
        var _a3;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (e) {
          reportProtocolViolation("Invalid JSON frame from broker");
          return;
        }
        if (!isBridgeEnvelope(message)) {
          reportProtocolViolation("Invalid bridge frame from broker");
          return;
        }
        if (isBrokerError(message)) {
          failed = true;
          (_a3 = config.onStatus) == null ? void 0 : _a3.call(config, "error");
          return;
        }
        if (message.type !== "request") return;
        const request = message.request;
        const requestLiteral = JSON.stringify(JSON.stringify(request)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
        try {
          cep.evalScript("adobepyDispatch(".concat(requestLiteral, ")"), (raw) => {
            var _a4;
            try {
              if (typeof raw !== "string" || raw.trim() === "") {
                throw new Error("Adobe CEP evalScript returned no JSON response");
              }
              if (raw.trim() === "EvalScript error.") {
                throw new Error("Adobe CEP evalScript failed");
              }
              const parsed = JSON.parse(raw);
              if (parsed.error) {
                socket.send(JSON.stringify({ type: "error", error: { ...parsed, id: (_a4 = parsed.id) != null ? _a4 : request.id } }));
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
      };
    };
    const verifyRuntime = () => {
      const probe = [
        'typeof adobepyDispatch === "function"',
        'typeof adobepyDomHasMethod === "function"',
        'typeof JSON === "object"',
        'typeof JSON.parse === "function"',
        'typeof JSON.stringify === "function"'
      ].join(" && ");
      cep.evalScript("".concat(probe, ' ? "ready" : "missing"'), (status) => {
        var _a2;
        if (status === "ready") void connect();
        else {
          (_a2 = config.onStatus) == null ? void 0 : _a2.call(config, "error");
          console.error("adobepy CEP host runtime failed to initialize", status);
        }
      });
    };
    const loadDispatcher = () => {
      cep.evalScript("$.evalFile(".concat(JSON.stringify("".concat(extensionPath, "/host/dispatcher.jsx")), ")"), verifyRuntime);
    };
    const loadDomRuntime = () => {
      cep.evalScript("$.evalFile(".concat(JSON.stringify("".concat(extensionPath, "/dist/dom.jsx")), ")"), loadDispatcher);
    };
    cep.evalScript("$.evalFile(".concat(JSON.stringify("".concat(extensionPath, "/dist/json.jsx")), ")"), loadDomRuntime);
  }
  function boundedBootstrapNonce(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : void 0;
  }
  function hostScriptError(id, error) {
    return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: (error == null ? void 0 : error.message) || String(error) } };
  }
  function isBridgeEnvelope(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isBrokerError(message) {
    return Boolean(message.error) && (message.type === "error" || message.jsonrpc === "2.0");
  }

  // bridges/shared/status.ts
  var statusText = {
    starting: "Starting bridge\u2026",
    connecting: "Connecting to broker\u2026",
    ready: "Bridge service ready. Broker/client connection is not verified.",
    disconnected: "Disconnected from broker. Check bridge and broker logs.",
    error: "Bridge not ready. Check bridge configuration and broker logs."
  };
  function showBridgeStatus(status) {
    var _a;
    const element = (_a = globalThis.document) == null ? void 0 : _a.getElementById("adobepy-bridge-status");
    if (element) element.textContent = statusText[status];
  }

  // bridges/cep/after-effects/src/identity.ts
  var bridgeInstanceId;
  async function afterEffectsRuntimeIdentity() {
    var _a;
    const cep = globalThis.__adobe_cep__;
    const pluginRoot = absolutePath(cepSystemPath((_a = cep == null ? void 0 : cep.getSystemPath) == null ? void 0 : _a.call(cep, "extension")));
    const hostVersion = await afterEffectsHostVersion(cep);
    return {
      host: { ...externalHostIdentity(), ...hostVersion ? { hostVersion } : {} },
      bridge: {
        ...bridgeInstanceIdValue() ? { instanceId: bridgeInstanceIdValue() } : {},
        ...pluginRoot ? { installedPluginRoot: pluginRoot, moduleOrigin: "".concat(pluginRoot, "/dist/main.js") } : {}
      }
    };
  }
  function externalHostIdentity() {
    const configured = globalThis.__ADOBEPY_HOST_IDENTITY;
    if (!configured || typeof configured !== "object") return {};
    const value = configured;
    const pid = value.pid;
    const processStartIdentity = bounded(value.processStartIdentity, 256, /^[A-Za-z0-9:_.-]+$/);
    const executablePath = absolutePath(value.executablePath);
    const profileId = bounded(value.profileId, 256);
    return {
      ...typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 4294967295 ? { pid } : {},
      ...processStartIdentity ? { processStartIdentity } : {},
      ...executablePath ? { executablePath } : {},
      ...profileId ? { profileId } : {}
    };
  }
  function afterEffectsHostVersion(cep) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      if (!cep || typeof cep.evalScript !== "function") {
        finish(void 0);
        return;
      }
      const timer = setTimeout(() => finish(void 0), 1e3);
      try {
        cep.evalScript('typeof app === "object" ? String(app.version) : ""', (value) => {
          clearTimeout(timer);
          finish(bounded(value, 64, /^\S+$/));
        });
      } catch (e) {
        clearTimeout(timer);
        finish(void 0);
      }
    });
  }
  function bridgeInstanceIdValue() {
    var _a;
    if (bridgeInstanceId) return bridgeInstanceId;
    const cryptoApi = globalThis.crypto;
    let candidate = (_a = cryptoApi == null ? void 0 : cryptoApi.randomUUID) == null ? void 0 : _a.call(cryptoApi);
    if (!candidate && (cryptoApi == null ? void 0 : cryptoApi.getRandomValues)) {
      const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
      bytes[6] = bytes[6] & 15 | 64;
      bytes[8] = bytes[8] & 63 | 128;
      const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
      candidate = "".concat(hex.slice(0, 8), "-").concat(hex.slice(8, 12), "-").concat(hex.slice(12, 16), "-").concat(hex.slice(16, 20), "-").concat(hex.slice(20));
    }
    if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) bridgeInstanceId = candidate.toLowerCase();
    return bridgeInstanceId;
  }
  function bounded(value, limit, pattern) {
    if (typeof value !== "string" || !value || value.trim() !== value || utf8Length(value) > limit || /[\u0000-\u001f\u007f]/.test(value)) return void 0;
    return !pattern || pattern.test(value) ? value : void 0;
  }
  function utf8Length(value) {
    var _a;
    let length = 0;
    for (const character of value) {
      const point = (_a = character.codePointAt(0)) != null ? _a : 0;
      length += point <= 127 ? 1 : point <= 2047 ? 2 : point <= 65535 ? 3 : 4;
    }
    return length;
  }
  function absolutePath(value) {
    const text = bounded(value, 32768);
    if (!text) return void 0;
    const normalized = text.replace(/\\/g, "/").replace(/\/+$/, "");
    if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return void 0;
    if (normalized.split("/").some((component) => component === "." || component === "..")) return void 0;
    return normalized;
  }

  // bridges/cep/after-effects/src/main.ts
  startCepBridge({
    onStatus: showBridgeStatus,
    host: "after-effects",
    brokerUrl: globalThis.__ADOBEPY_BROKER_URL || "ws://127.0.0.1:47391/v1/bridge/after-effects/ws",
    token: globalThis.__ADOBEPY_TOKEN || "",
    target: globalThis.__ADOBEPY_TARGET || "default",
    identityProvider: afterEffectsRuntimeIdentity,
    capabilities: {
      host: "after-effects",
      bridgeKind: "cep",
      bridgeVersion: "0.1.0",
      namespaces: ["app", "project", "item", "layer", "mask", "effect", "text", "renderQueue", "renderQueueItem", "outputModule", "dom", "raw"],
      features: ["extendscript", "projectInfo", "projectItems", "compositions", "footageItems", "layers", "masks", "effects", "text", "renderQueue", "outputModule", "officialDom"],
      methods: {
        app: ["getVersion", "openProject"],
        project: ["getActive", "getItems", "getCompositions", "getFootageItems", "getFolders", "getActiveItem", "getSelectedItems", "save", "importFile", "createComposition"],
        item: ["getById", "getByName"],
        layer: [
          "getLayers",
          "getSelected",
          "getById",
          "createText",
          "createSolid",
          "createFootage",
          "setTransform",
          "setKeyframes",
          "moveToBeginning",
          "moveToEnd",
          "moveBefore",
          "moveAfter"
        ],
        mask: ["getMasks"],
        effect: ["getEffects", "getByName"],
        text: ["getSourceText", "setSourceText"],
        renderQueue: ["get", "getItems", "getItemByIndex", "addComposition", "queueSelectedCompositions", "render", "pauseRendering", "stopRendering", "showWindow", "queueInAME", "setQueueNotify"],
        renderQueueItem: ["applyTemplate", "setSettings", "setRender", "setQueueItemNotify"],
        outputModule: ["getModules", "getByIndex", "applyTemplate", "setSettings", "setOutputPath", "saveAsTemplate"],
        dom: ["root", "get", "set", "call", "construct", "keys", "snapshot", "release"],
        raw: ["evalExtendScript"]
      }
    }
  });
})();
//# sourceMappingURL=main.js.map
