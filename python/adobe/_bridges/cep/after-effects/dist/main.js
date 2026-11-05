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

  // bridges/cep/core/src/rpc.ts
  function startCepBridge(config) {
    const cep = globalThis.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== "function") throw new Error("Adobe CEP evalScript API unavailable");
    if (typeof config.token !== "string" || config.token.trim() === "") {
      throw new Error("ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
    }
    const extensionPath = cep.getSystemPath("extension").replace(/\\/g, "/");
    const connect = async () => {
      let identity;
      if (config.identityProvider) {
        try {
          const provided = config.identityProvider();
          identity = provided && typeof provided.then === "function" ? await provided : provided;
        } catch (e) {
          console.error("[adobepy] runtime identity is unavailable; exact-instance verification will fail closed.");
        }
      }
      const bootstrapNonce = boundedBootstrapNonce(globalThis.__ADOBEPY_BOOTSTRAP_NONCE);
      const capabilities = (identity == null ? void 0 : identity.host.hostVersion) ? { ...config.capabilities, hostVersion: identity.host.hostVersion } : config.capabilities;
      const socket = new WebSocket(config.brokerUrl);
      let greeted = false;
      const greet = () => {
        if (greeted || socket.readyState !== 1) return;
        greeted = true;
        socket.send(JSON.stringify({
          type: "hello",
          token: config.token,
          target: config.target,
          capabilities,
          ...identity ? { identity } : {},
          ...bootstrapNonce ? { bootstrapNonce } : {}
        }));
        console.log("adobepy CEP bridge connected", capabilities);
      };
      socket.onopen = greet;
      setTimeout(greet, 0);
      socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type !== "request") return;
        const request = message.request;
        const requestLiteral = JSON.stringify(JSON.stringify(request)).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
        try {
          cep.evalScript(`adobepyDispatch(${requestLiteral})`, (raw) => {
            var _a;
            try {
              if (typeof raw !== "string" || raw.trim() === "") {
                throw new Error("Adobe CEP evalScript returned no JSON response");
              }
              if (raw.trim() === "EvalScript error.") {
                throw new Error("Adobe CEP evalScript failed");
              }
              const parsed = JSON.parse(raw);
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
      cep.evalScript(`${probe} ? "ready" : "missing"`, (status) => {
        if (status === "ready") void connect();
        else console.error("adobepy CEP host runtime failed to initialize", status);
      });
    };
    const loadDispatcher = () => {
      cep.evalScript(`$.evalFile(${JSON.stringify(`${extensionPath}/host/dispatcher.jsx`)})`, verifyRuntime);
    };
    const loadDomRuntime = () => {
      cep.evalScript(`$.evalFile(${JSON.stringify(`${extensionPath}/dist/dom.jsx`)})`, loadDispatcher);
    };
    cep.evalScript(`$.evalFile(${JSON.stringify(`${extensionPath}/dist/json.jsx`)})`, loadDomRuntime);
  }
  function boundedBootstrapNonce(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : void 0;
  }
  function hostScriptError(id, error) {
    return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: (error == null ? void 0 : error.message) || String(error) } };
  }

  // bridges/cep/after-effects/src/identity.ts
  var bridgeInstanceId;
  async function afterEffectsRuntimeIdentity() {
    var _a;
    const cep = globalThis.__adobe_cep__;
    const pluginRoot = absolutePath((_a = cep == null ? void 0 : cep.getSystemPath) == null ? void 0 : _a.call(cep, "extension"));
    const hostVersion = await afterEffectsHostVersion(cep);
    return {
      host: { ...externalHostIdentity(), ...hostVersion ? { hostVersion } : {} },
      bridge: {
        ...bridgeInstanceIdValue() ? { instanceId: bridgeInstanceIdValue() } : {},
        ...pluginRoot ? { installedPluginRoot: pluginRoot, moduleOrigin: `${pluginRoot}/dist/main.js` } : {}
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
      candidate = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
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
