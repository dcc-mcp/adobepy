"use strict";
(() => {
  var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
    get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
  }) : x)(function(x) {
    if (typeof require !== "undefined") return require.apply(this, arguments);
    throw Error('Dynamic require of "' + x + '" is not supported');
  });

  // bridges/uxp/core/src/protocol.ts
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

  // bridges/uxp/core/src/errors.ts
  var ERROR_METHOD_NOT_FOUND = ERROR_CODES.ERROR_METHOD_NOT_FOUND;
  var ERROR_HOST_SCRIPT = ERROR_CODES.ERROR_HOST_SCRIPT;
  var BridgeRpcError = class extends Error {
    constructor(code, message, data) {
      super(message);
      this.name = "BridgeRpcError";
      this.code = code;
      this.data = data;
    }
  };
  function methodNotFound(namespace, method) {
    throw new BridgeRpcError(ERROR_METHOD_NOT_FOUND, `unsupported method ${namespace}.${method}`);
  }
  function unavailable(feature) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `${feature} is unavailable in this host runtime`);
  }

  // bridges/uxp/core/src/rpc.ts
  function connectBridge(adapter, identityProvider, onStatus) {
    onStatus?.("starting");
    const url = globalThis.__ADOBEPY_BROKER_URL || `ws://127.0.0.1:47391/v1/bridge/${adapter.capabilities().host}/ws`;
    const token = globalThis.__ADOBEPY_TOKEN;
    if (typeof token !== "string" || token.trim() === "") {
      onStatus?.("error");
      console.error("[adobepy] ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
      return;
    }
    const target = globalThis.__ADOBEPY_TARGET || "default";
    onStatus?.("connecting");
    let failed = false;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (error) {
      onStatus?.("error");
      throw error;
    }
    socket.addEventListener("error", () => {
      failed = true;
      onStatus?.("error");
    });
    socket.addEventListener("close", () => onStatus?.(failed ? "error" : "disconnected"));
    socket.addEventListener("open", async () => {
      let identity;
      try {
        identity = await identityProvider?.();
      } catch {
        failed = true;
        onStatus?.("error");
        console.error("[adobepy] runtime identity is unavailable; exact-instance verification will fail closed.");
      }
      if (socket.readyState !== 1) return;
      const bootstrapNonce = boundedBootstrapNonce(globalThis.__ADOBEPY_BOOTSTRAP_NONCE);
      try {
        socket.send(JSON.stringify({
          type: "hello",
          token,
          target,
          capabilities: adapter.capabilities(),
          ...identity ? { identity } : {},
          ...bootstrapNonce ? { bootstrapNonce } : {}
        }));
      } catch (error) {
        failed = true;
        onStatus?.("error");
        throw error;
      }
      onStatus?.(failed ? "error" : "ready");
    });
    const reportProtocolViolation = (reason) => {
      failed = true;
      onStatus?.("error");
      console.error(`[adobepy] ${reason}`);
      try {
        socket.send(JSON.stringify({
          type: "error",
          error: {
            jsonrpc: "2.0",
            id: null,
            error: { code: ERROR_CODES.ERROR_PARSE, message: "Invalid bridge frame" }
          }
        }));
      } catch {
      }
      if (typeof socket.close === "function") socket.close();
    };
    socket.addEventListener("message", async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        reportProtocolViolation("Invalid JSON frame from broker");
        return;
      }
      if (!isBridgeEnvelope(message)) {
        reportProtocolViolation("Invalid bridge frame from broker");
        return;
      }
      if (isBrokerError(message)) {
        failed = true;
        onStatus?.("error");
        return;
      }
      if (message.type !== "request") return;
      const request = message.request;
      try {
        const result = await adapter.dispatch(request);
        socket.send(JSON.stringify({ type: "response", response: { jsonrpc: "2.0", id: request.id, result: result ?? null } }));
      } catch (error) {
        socket.send(JSON.stringify({ type: "error", error: hostError(request.id, error) }));
      }
    });
  }
  function isBridgeEnvelope(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function isBrokerError(message) {
    return Boolean(message.error) && (message.type === "error" || message.jsonrpc === "2.0");
  }
  function boundedBootstrapNonce(value) {
    return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : void 0;
  }
  function hostError(id, error) {
    const code = error instanceof BridgeRpcError ? error.code : ERROR_HOST_SCRIPT;
    const message = error instanceof Error ? error.message : String(error);
    const data = error instanceof BridgeRpcError ? error.data : void 0;
    return { jsonrpc: "2.0", id, error: { code, message, ...data === void 0 ? {} : { data } } };
  }

  // bridges/uxp/core/src/runtime.ts
  function optionalRequire(moduleName) {
    const loader = globalThis.require ?? __require;
    if (typeof loader !== "function") return void 0;
    try {
      const loaded = loader(moduleName);
      return isObject(loaded) ? loaded : void 0;
    } catch {
      return void 0;
    }
  }
  function isObject(value) {
    return typeof value === "object" && value !== null;
  }
  function asString(value) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return void 0;
  }
  function asNumber(value) {
    if (typeof value === "number") return value;
    if (isObject(value) && typeof value.valueOf === "function") {
      const converted = value.valueOf();
      if (typeof converted === "number") return converted;
    }
    return void 0;
  }
  var BLOCKED_MEMBERS = /* @__PURE__ */ new Set(["__proto__", "constructor", "prototype"]);
  function readMember(value, name) {
    if (!isObject(value) && typeof value !== "function" || BLOCKED_MEMBERS.has(String(name))) {
      return void 0;
    }
    if (typeof value === "function" && !Object.prototype.hasOwnProperty.call(value, name)) {
      return void 0;
    }
    return value[name];
  }
  function property(value, name) {
    return readMember(value, name);
  }
  async function maybePromise(value) {
    return await value;
  }
  async function evalJavaScript(source, args) {
    try {
      return await (0, eval)(source);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const fn = new Function("args", source);
      return await fn(args);
    }
  }

  // bridges/uxp/core/src/dom.ts
  var REFERENCE_KEY = "$adobepyRef";
  var TYPE_KEY = "$adobepyType";
  var DomRuntime = class {
    constructor(options) {
      this.options = options;
      this.references = /* @__PURE__ */ new Map();
      this.reverseReferences = /* @__PURE__ */ new WeakMap();
      this.nextReference = 1;
    }
    async dispatch(request) {
      if (request.namespace !== "dom") {
        throw new BridgeRpcError(ERROR_HOST_SCRIPT, `invalid DOM namespace ${request.namespace}`);
      }
      if (request.method === "root") {
        const name = requiredString(request.args?.[0], "root name");
        const value = this.options.roots(name);
        if (value === void 0 || value === null) {
          throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM root '${name}' is unavailable`);
        }
        return this.encode(value);
      }
      if (request.method === "get") {
        const receiver = this.resolve(request.args?.[0]);
        const member = requiredMember(request.args?.[1]);
        return this.encode(await maybePromise(readMember2(receiver, member)));
      }
      if (request.method === "set") {
        return this.runMutation(request, "Set official DOM property", async () => {
          const receiver = this.resolve(request.args?.[0]);
          const member = requiredMember(request.args?.[1]);
          const value = this.decode(request.args?.[2]);
          writeMember(receiver, member, value);
          return this.encode(await maybePromise(readMember2(receiver, member)));
        });
      }
      if (request.method === "call") {
        const operation = async () => {
          const receiver = this.resolve(request.args?.[0]);
          const member = requiredMember(request.args?.[1]);
          const callable = readMember2(receiver, member);
          if (typeof callable !== "function") {
            throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${String(member)}' is not callable`);
          }
          const args = this.decodeArgs(request.args?.[2]);
          return this.encode(await maybePromise(callable.apply(receiver, args)));
        };
        if (request.options?.modal === true || typeof request.options?.commandName === "string") {
          return this.runMutation(request, `Call official DOM method ${String(request.args?.[1] ?? "")}`, operation);
        }
        return operation();
      }
      if (request.method === "construct") {
        return this.runMutation(request, "Construct official DOM object", async () => {
          const receiver = this.resolve(request.args?.[0]);
          const member = requiredMember(request.args?.[1]);
          const constructor = readMember2(receiver, member);
          if (typeof constructor !== "function") {
            throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${String(member)}' is not a constructor`);
          }
          return this.encode(Reflect.construct(constructor, this.decodeArgs(request.args?.[2])));
        });
      }
      if (request.method === "keys") {
        return collectKeys(this.resolve(request.args?.[0]));
      }
      if (request.method === "snapshot") {
        const receiver = this.resolve(request.args?.[0]);
        const requested = request.args?.[1];
        const members = Array.isArray(requested) ? requested.map(requiredMember) : collectSnapshotKeys(receiver);
        const snapshot = {};
        for (const member of members) {
          try {
            const value = await maybePromise(readMember2(receiver, member));
            if (typeof value !== "function") snapshot[String(member)] = this.encode(value);
          } catch (error) {
            snapshot[String(member)] = {
              $adobepyError: error instanceof Error ? error.message : String(error)
            };
          }
        }
        return snapshot;
      }
      if (request.method === "release") {
        const reference = referenceId(request.args?.[0]);
        const value = this.references.get(reference);
        if (typeof value === "object" && value !== null || typeof value === "function") {
          this.reverseReferences.delete(value);
        }
        return this.references.delete(reference);
      }
      methodNotFound("dom", request.method);
    }
    async runMutation(request, defaultCommandName, operation) {
      if (this.options.runMutation) {
        return this.options.runMutation(request, defaultCommandName, operation);
      }
      return operation();
    }
    encode(value) {
      if (value === void 0 || value === null) return null;
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
      if (typeof value === "bigint") return value.toString();
      if (typeof value === "symbol") return value.description ?? value.toString();
      if (Array.isArray(value)) return value.map((item) => this.encode(item));
      const objectValue = value;
      const existing = this.reverseReferences.get(objectValue);
      if (existing) {
        return {
          [REFERENCE_KEY]: existing,
          [TYPE_KEY]: domTypeName(value)
        };
      }
      const reference = `uxp_${this.nextReference++}`;
      this.references.set(reference, value);
      this.reverseReferences.set(objectValue, reference);
      return {
        [REFERENCE_KEY]: reference,
        [TYPE_KEY]: domTypeName(value)
      };
    }
    decode(value) {
      if (Array.isArray(value)) return value.map((item) => this.decode(item));
      if (!isObject(value)) return value;
      if (typeof value[REFERENCE_KEY] === "string") return this.resolve(value);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decode(item)]));
    }
    decodeArgs(value) {
      if (value === void 0) return [];
      if (!Array.isArray(value)) {
        throw new BridgeRpcError(ERROR_HOST_SCRIPT, "official DOM call arguments must be an array");
      }
      return value.map((item) => this.decode(item));
    }
    resolve(value) {
      const reference = referenceId(value);
      if (!this.references.has(reference)) {
        throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM reference '${reference}' is stale or unknown`);
      }
      return this.references.get(reference);
    }
  };
  function referenceId(value) {
    const reference = isObject(value) ? value[REFERENCE_KEY] : void 0;
    if (typeof reference !== "string" || reference.length === 0) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `expected an object containing '${REFERENCE_KEY}'`);
    }
    return reference;
  }
  function requiredString(value, label) {
    const result = asString(value);
    if (!result) throw new BridgeRpcError(ERROR_HOST_SCRIPT, `${label} is required`);
    return result;
  }
  function requiredMember(value) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, "official DOM member must be a string or array index");
    }
    if (typeof value === "string" && BLOCKED_MEMBERS.has(value)) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${value}' is not accessible`);
    }
    return value;
  }
  function readMember2(receiver, member) {
    if (typeof receiver !== "object" && typeof receiver !== "function" || receiver === null) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `cannot read '${String(member)}' from a primitive value`);
    }
    return readMember(receiver, member);
  }
  function writeMember(receiver, member, value) {
    if (typeof receiver !== "object" && typeof receiver !== "function" || receiver === null) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `cannot write '${String(member)}' on a primitive value`);
    }
    receiver[member] = value;
  }
  function collectKeys(value) {
    if (typeof value !== "object" && typeof value !== "function" || value === null) return [];
    const keys = /* @__PURE__ */ new Set();
    const maxDepth = typeof value === "function" ? 1 : 8;
    let current = value;
    for (let depth = 0; current && depth < maxDepth; depth += 1) {
      try {
        for (const key of Object.getOwnPropertyNames(current)) {
          if (!BLOCKED_MEMBERS.has(key) && key !== "constructor") keys.add(key);
        }
        current = Object.getPrototypeOf(current);
      } catch {
        break;
      }
    }
    return Array.from(keys).sort();
  }
  function collectSnapshotKeys(value) {
    if (typeof value !== "object" && typeof value !== "function" || value === null) return [];
    try {
      return Object.keys(value).filter((key) => !BLOCKED_MEMBERS.has(key)).sort();
    } catch {
      return [];
    }
  }
  function domTypeName(value) {
    if (typeof value === "function") return value.name || "Function";
    if (!isObject(value)) return typeof value;
    const typename = asString(property(value, "typename")) ?? asString(property(value, "typeName"));
    if (typename) return typename;
    try {
      const prototype = Object.getPrototypeOf(value);
      return asString(prototype?.constructor?.name) ?? "Object";
    } catch {
      return "Object";
    }
  }

  // bridges/uxp/premiere/src/host.ts
  var COLLECTION_LIMIT = 1e4;
  var domRuntime = new DomRuntime({
    roots(name) {
      if (name === "app" || name === "module" || name === "premierepro") return premiereModule();
      if (name === "uxp") return uxpModule();
      return void 0;
    }
  });
  var premiereAdapter = {
    capabilities() {
      return {
        host: "premiere",
        bridgeKind: "uxp",
        bridgeVersion: "0.1.0",
        hostVersion: premiereVersion(),
        namespaces: ["app", "project", "sequence", "track", "clip", "projectItem", "bin", "marker", "encoder", "export", "dom", "raw"],
        features: ["project", "sequence", "track", "clip", "projectItem", "bin", "marker", "encoder", "export", "structuredDom"],
        methods: {
          app: ["getVersion"],
          project: ["getActive", "getSequences", "getActiveSequence", "getRootItem", "save", "saveAs", "createSequence", "importFiles"],
          sequence: ["getVideoTracks", "getAudioTracks", "insertProjectItem", "overwriteProjectItem"],
          track: ["getClips"],
          clip: ["getSelected"],
          projectItem: ["getChildren", "getSelected", "findByMediaPath"],
          bin: ["create"],
          marker: ["getMarkers", "create"],
          encoder: ["getManager", "getPresets", "getExportFileExtension", "encodeFile", "encodeProjectItem", "exportSequence"],
          export: ["getExporter", "exportFrame"],
          dom: ["root", "get", "set", "call", "construct", "keys", "snapshot", "release"],
          raw: ["evalJs"]
        }
      };
    },
    async dispatch(request) {
      if (request.namespace === "dom") return domRuntime.dispatch(request);
      if (request.namespace === "app" && request.method === "getVersion") return premiereVersion();
      if (request.namespace === "project" && request.method === "getActive") return serializeProject(await activeProject());
      if (request.namespace === "project" && request.method === "getSequences") return serializeSequences(await projectSequences(await activeProject()));
      if (request.namespace === "project" && request.method === "getActiveSequence") return serializeSequence(await activeSequence());
      if (request.namespace === "project" && request.method === "getRootItem") return serializeProjectItem(await rootProjectItem());
      if (request.namespace === "project" && request.method === "save") return saveProject();
      if (request.namespace === "project" && request.method === "saveAs") return saveProjectAs(request);
      if (request.namespace === "project" && request.method === "createSequence") return createSequence(request);
      if (request.namespace === "project" && request.method === "importFiles") return importFiles(request);
      if (request.namespace === "sequence" && request.method === "getVideoTracks") {
        return serializeTracks(await sequenceTracks(await requireSequence(request.args?.[0]), "video"), "video");
      }
      if (request.namespace === "sequence" && request.method === "getAudioTracks") {
        return serializeTracks(await sequenceTracks(await requireSequence(request.args?.[0]), "audio"), "audio");
      }
      if (request.namespace === "sequence" && request.method === "insertProjectItem") return editProjectItem(request, false);
      if (request.namespace === "sequence" && request.method === "overwriteProjectItem") return editProjectItem(request, true);
      if (request.namespace === "track" && request.method === "getClips") return trackClips(request);
      if (request.namespace === "clip" && request.method === "getSelected") return selectedClips(await requireSequence(request.args?.[0]));
      if (request.namespace === "projectItem" && request.method === "getChildren") return projectItemChildren(request);
      if (request.namespace === "projectItem" && request.method === "getSelected") return selectedProjectItems();
      if (request.namespace === "projectItem" && request.method === "findByMediaPath") return projectItemsByMediaPath(request);
      if (request.namespace === "bin" && request.method === "create") return createBin(request);
      if (request.namespace === "marker" && request.method === "getMarkers") return sequenceMarkers(await requireSequence(request.args?.[0]));
      if (request.namespace === "marker" && request.method === "create") return createMarker(request);
      if (request.namespace === "encoder" && request.method === "getManager") return serializeEncoderManager(await encoderManager());
      if (request.namespace === "encoder" && request.method === "getPresets") return encoderPresets();
      if (request.namespace === "encoder" && request.method === "getExportFileExtension") return getExportFileExtension(request);
      if (request.namespace === "encoder" && request.method === "encodeFile") return encodeFile(request);
      if (request.namespace === "encoder" && request.method === "encodeProjectItem") return encodeProjectItem(request);
      if (request.namespace === "encoder" && request.method === "exportSequence") return exportSequence(request);
      if (request.namespace === "export" && request.method === "getExporter") return serializeExporter(await exporterApi());
      if (request.namespace === "export" && request.method === "exportFrame") return exportFrame(request);
      if (request.namespace === "raw" && request.method === "evalJs") return evalJavaScript(asString(request.args?.[0]) ?? "", request.args?.slice(1) ?? []);
      methodNotFound(request.namespace, request.method);
    }
  };
  function premiereModule() {
    return optionalRequire("premierepro") ?? globalThis.premierepro ?? {};
  }
  function uxpModule() {
    return optionalRequire("uxp") ?? globalThis.uxp ?? {};
  }
  function premiereVersion() {
    const premiere = premiereModule();
    const host = property(uxpModule(), "host");
    return asString(property(premiere, "version")) ?? asString(property(host, "version")) ?? "unknown";
  }
  async function activeProject() {
    const premiere = premiereModule();
    const projectApi = property(premiere, "Project");
    const getActiveProject = property(projectApi, "getActiveProject") ?? property(projectApi, "getActive");
    if (getActiveProject) return await maybePromise(getActiveProject.call(projectApi));
    return property(premiere, "project") ?? property(property(premiere, "app"), "project");
  }
  async function projectSequences(project) {
    if (!project) return [];
    const getSequences = property(project, "getSequences");
    if (getSequences) return await collectionItems(await maybePromise(getSequences.call(project)), true);
    const sequences = property(project, "sequences") ?? property(project, "sequenceCollection");
    return await collectionItems(sequences, true);
  }
  async function saveProject() {
    const project = await activeProject();
    const save = property(project, "save");
    if (!save) unavailable("Premiere project save");
    if (await maybePromise(save.call(project)) === false) unavailable("Premiere project save failed");
    return serializeProject(project);
  }
  async function saveProjectAs(request) {
    const project = await activeProject();
    const path = asString(request.args?.[0]);
    const saveAs = property(project, "saveAs");
    if (!path || !saveAs) unavailable("Premiere project saveAs");
    if (await maybePromise(saveAs.call(project, path)) === false) unavailable("Premiere project saveAs failed");
    return serializeProject(project);
  }
  async function createSequence(request) {
    const project = await activeProject();
    const payload = isObject(request.args?.[0]) ? request.args?.[0] : { name: request.args?.[0] };
    const name = asString(property(payload, "name"));
    const presetPath = asString(property(payload, "presetPath") ?? property(payload, "preset_path"));
    if (!name) unavailable("Premiere sequence name");
    const createWithPreset = property(project, "createSequenceWithPresetPath");
    const create = property(project, "createSequence");
    if (presetPath && createWithPreset) return serializeSequence(await maybePromise(createWithPreset.call(project, name, presetPath)));
    if (!create) unavailable("Premiere project.createSequence");
    return serializeSequence(await maybePromise(create.call(project, name, presetPath)));
  }
  async function editProjectItem(request, overwrite) {
    const sequence = await requireSequence(request.args?.[0]);
    const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
    const item = await requireProjectItem(property(payload, "projectItem") ?? property(payload, "project_item"));
    const time = premiereTickTime(property(payload, "time") ?? 0);
    const videoTrack = asNumber(property(payload, "videoTrack") ?? property(payload, "video_track")) ?? 0;
    const audioTrack = asNumber(property(payload, "audioTrack") ?? property(payload, "audio_track")) ?? 0;
    const premiere = premiereModule();
    const editorType = property(premiere, "SequenceEditor");
    const getEditor = property(editorType, "getEditor");
    const editor = getEditor ? getEditor.call(editorType, sequence) : null;
    const method = property(editor, overwrite ? "createOverwriteItemAction" : "createInsertProjectItemAction");
    const project = await activeProject();
    if (!method) unavailable(`Premiere SequenceEditor ${overwrite ? "overwrite" : "insert"}`);
    const action = overwrite ? method.call(editor, item, time, videoTrack, audioTrack) : method.call(editor, item, time, videoTrack, audioTrack, booleanValue(property(payload, "limitShift") ?? property(payload, "limit_shift")) ?? false);
    await executeProjectAction(project, action, asString(request.options?.commandName) ?? (overwrite ? "Overwrite project item" : "Insert project item"));
    return { edited: true, mode: overwrite ? "overwrite" : "insert", sequence: await serializeSequence(sequence), projectItem: await serializeProjectItem(item) };
  }
  function premiereTickTime(value) {
    const tickTime = property(premiereModule(), "TickTime");
    const ticks = typeof value === "string" ? value : property(value, "ticks");
    if (ticks !== void 0) {
      const createWithTicks = property(tickTime, "createWithTicks");
      if (typeof ticks !== "string" || !/^-?\d+$/.test(ticks) || !createWithTicks) unavailable("Premiere TickTime ticks");
      return createWithTicks.call(tickTime, ticks);
    }
    const seconds = asNumber(isObject(value) ? property(value, "seconds") : value);
    if (seconds === void 0 || !Number.isFinite(seconds)) unavailable("Premiere TickTime seconds");
    const createWithSeconds = property(tickTime, "createWithSeconds");
    if (!createWithSeconds) unavailable("Premiere TickTime.createWithSeconds");
    return createWithSeconds.call(tickTime, seconds);
  }
  async function executeProjectAction(project, action, commandName) {
    const execute = property(project, "executeTransaction");
    if (!execute) unavailable("Premiere project.executeTransaction");
    let result;
    const run = () => {
      result = execute.call(project, (compound) => {
        const add = property(compound, "addAction") ?? property(compound, "add");
        if (!add) unavailable("Premiere compound action");
        add.call(compound, action);
      }, commandName);
    };
    const lockedAccess = property(project, "lockedAccess");
    if (lockedAccess) await maybePromise(lockedAccess.call(project, run));
    else run();
    if (await maybePromise(result) === false) unavailable("Premiere transaction failed");
  }
  async function activeSequence() {
    const project = await activeProject();
    const direct = property(project, "activeSequence") ?? property(project, "active_sequence");
    if (direct) return direct;
    const getActiveSequence = property(project, "getActiveSequence") ?? property(project, "getActiveSequenceProjectItem");
    if (getActiveSequence) return await maybePromise(getActiveSequence.call(project));
    const premiere = premiereModule();
    return property(premiere, "activeSequence") ?? property(property(premiere, "app"), "activeSequence");
  }
  async function findSequence(idOrName) {
    const active = await activeSequence();
    if (sequenceMatches(active, idOrName) || idOrName === void 0 || idOrName === null) return active;
    const sequences = await projectSequences(await activeProject());
    return sequences.find((sequence) => sequenceMatches(sequence, idOrName));
  }
  async function requireSequence(idOrName) {
    const sequence = await findSequence(idOrName);
    if (!sequence) unavailable("Premiere sequence");
    return sequence;
  }
  function sequenceMatches(sequence, idOrName) {
    if (!isObject(sequence)) return false;
    if (idOrName === void 0 || idOrName === null) return true;
    const target = String(idOrName);
    const values = [
      property(sequence, "id"),
      property(sequence, "guid"),
      property(sequence, "sequenceId"),
      property(sequence, "sequenceID"),
      property(sequence, "name")
    ];
    return values.some((value) => {
      if (value === void 0 || value === null) return false;
      const serialized = serializeId(value);
      return serialized !== void 0 && String(serialized) === target;
    });
  }
  function isThenable(value) {
    return (isObject(value) || typeof value === "function") && typeof value.then === "function";
  }
  function serializeProject(project) {
    if (!isObject(project)) return null;
    return {
      id: serializeId(property(project, "guid") ?? property(project, "id")),
      guid: serializeId(property(project, "guid")),
      name: asString(property(project, "name")),
      path: asString(property(project, "path")),
      itemCount: asNumber(property(project, "itemCount")) ?? asNumber(property(project, "numItems"))
    };
  }
  async function rootProjectItem(project) {
    project = project ?? await activeProject();
    const getRootItem = property(project, "getRootItem");
    if (getRootItem) return await maybePromise(getRootItem.call(project));
    return property(project, "rootItem") ?? property(project, "root") ?? property(project, "rootProjectItem");
  }
  async function requireProjectItem(idOrName) {
    const project = await activeProject();
    const root = await rootProjectItem(project);
    const item = await findProjectItem(root, idOrName);
    if (!item) unavailable("Premiere project item");
    return item;
  }
  async function importFiles(request) {
    const project = await activeProject();
    if (!project) unavailable("Premiere project");
    const payload = isObject(request.args?.[0]) ? request.args?.[0] : { filePaths: request.args?.[0] };
    const filePaths = normalizeFilePaths(property(payload, "filePaths") ?? property(payload, "paths") ?? property(payload, "path"));
    if (filePaths.length === 0) unavailable("Premiere import file paths");
    const targetBinId = property(payload, "targetBin") ?? property(payload, "target_bin") ?? property(payload, "targetBinId") ?? property(payload, "target_bin_id");
    const targetBin = targetBinId === void 0 || targetBinId === null ? await rootProjectItem(project) : await requireProjectItem(targetBinId);
    const importProjectFiles = property(project, "importFiles");
    if (!importProjectFiles) unavailable("Premiere project.importFiles");
    const suppressUI = booleanValue(property(payload, "suppressUI") ?? property(payload, "suppress_ui")) ?? true;
    const asNumberedStills = booleanValue(property(payload, "asNumberedStills") ?? property(payload, "as_numbered_stills")) ?? false;
    const result = await maybePromise(importProjectFiles.call(project, filePaths, suppressUI, targetBin, asNumberedStills));
    if (result === false) unavailable("Premiere project importFiles failed");
    const resultItems = await collectionItems(result);
    if (resultItems.length > 0) return serializeProjectItems(resultItems);
    return serializeProjectItems(await findImportedProjectItems(filePaths, targetBin ?? await rootProjectItem(project)));
  }
  async function projectItemChildren(request) {
    const item = request.args?.[0] === void 0 || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
    return serializeProjectItems(await projectItemChildObjects(item));
  }
  async function selectedProjectItems() {
    const premiere = premiereModule();
    const project = await activeProject();
    const projectUtils = property(premiere, "ProjectUtils") ?? property(premiere, "projectUtils");
    const getSelection = property(projectUtils, "getSelection");
    if (getSelection) {
      const selection2 = await maybePromise(getSelection.call(projectUtils, project));
      return serializeProjectItems(await collectionItems(await readValue(selection2, "getItems") ?? selection2, true));
    }
    const selection = property(project, "selection") ?? property(premiere, "selection");
    return serializeProjectItems(await collectionItems(selection, true));
  }
  async function projectItemsByMediaPath(request) {
    const root = request.args?.[0] === void 0 || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
    const matchString = asString(request.args?.[1]) ?? "";
    const ignoreSubclips = booleanValue(request.args?.[2]) ?? false;
    if (!matchString) unavailable("Premiere media path match");
    const directFind = property(root, "findItemsMatchingMediaPath");
    if (directFind) return serializeProjectItems(await collectionItems(await maybePromise(directFind.call(root, matchString, ignoreSubclips))));
    if (ignoreSubclips) unavailable("Premiere media path search excluding subclips");
    return serializeProjectItems(await findProjectItemsMatchingMediaPath(root, matchString));
  }
  async function createBin(request) {
    const project = await activeProject();
    const payload = isObject(request.args?.[0]) ? request.args?.[0] : { parentId: request.args?.[0], name: request.args?.[1] };
    const name = asString(property(payload, "name"));
    if (!name) unavailable("Premiere bin name");
    const parentId = property(payload, "parentId") ?? property(payload, "parent_id");
    const resolvedParent = parentId === void 0 || parentId === null ? await rootProjectItem(project) : await requireProjectItem(parentId);
    const parent = await castProjectItem(resolvedParent, "FolderItem") ?? resolvedParent;
    if (!parent) unavailable("Premiere parent bin");
    const existingIds = new Set(await Promise.all((await projectItemChildObjects(parent)).map(projectItemId)));
    const makeUnique = booleanValue(property(payload, "makeUnique") ?? property(payload, "make_unique")) ?? true;
    const createDirect = property(parent, "createBin");
    if (createDirect) {
      const created = await maybePromise(createDirect.call(parent, name, makeUnique));
      if (created === false) unavailable("Premiere bin creation failed");
      if (isObject(created)) return serializeProjectItem(created);
    } else {
      const createAction = property(parent, "createBinAction");
      if (!createAction) unavailable("Premiere bin.create");
      await executeProjectAction(project, createAction.call(parent, name, makeUnique), asString(request.options?.commandName) ?? "Create bin");
    }
    const createdChildren = [];
    for (const child of await projectItemChildObjects(parent)) {
      const id = await projectItemId(child);
      if (id !== void 0 && !existingIds.has(id)) createdChildren.push(child);
    }
    if (createdChildren.length !== 1) unavailable("Premiere newly created bin identity");
    return serializeProjectItem(createdChildren[0]);
  }
  async function serializeSequences(sequences) {
    return (await Promise.all(sequences.map(serializeSequence))).filter((sequence) => sequence !== null);
  }
  async function serializeSequence(sequence) {
    if (!isObject(sequence)) return null;
    const id = sequenceId(sequence);
    return {
      id,
      guid: serializeId(property(sequence, "guid")),
      sequenceId: serializeId(property(sequence, "sequenceId") ?? property(sequence, "sequenceID")) ?? id,
      name: asString(property(sequence, "name")),
      duration: serializeTime(await readValue(sequence, "getEndTime", "duration", "end")),
      timebase: await readValue(sequence, "getTimebase", "timebase", "videoDisplayFormat"),
      typename: asString(property(sequence, "typename")) ?? asString(property(sequence, "typeName"))
    };
  }
  function sequenceId(sequence) {
    return serializeId(property(sequence, "id") ?? property(sequence, "guid") ?? property(sequence, "sequenceId") ?? property(sequence, "sequenceID"));
  }
  async function sequenceTracks(sequence, mediaType) {
    const prefix = mediaType === "video" ? "Video" : "Audio";
    const getCount = property(sequence, `get${prefix}TrackCount`);
    const getTrack = property(sequence, `get${prefix}Track`);
    if (getCount || getTrack) {
      if (!getCount || !getTrack) unavailable(`Premiere ${mediaType} track enumeration`);
      const count = await maybePromise(getCount.call(sequence));
      validateCollectionCount(count);
      const tracks = [];
      for (let index = 0; index < count; index += 1) {
        const track = await maybePromise(getTrack.call(sequence, index));
        if (!isObject(track)) unavailable(`Premiere ${mediaType} track at index ${index}`);
        tracks.push(track);
      }
      return tracks;
    }
    const propertyName = mediaType === "video" ? "videoTracks" : "audioTracks";
    return await collectionItems(property(sequence, propertyName), true);
  }
  async function serializeTracks(tracks, mediaType) {
    return Promise.all(tracks.map((track, index) => serializeTrack(track, index, mediaType)));
  }
  async function serializeTrack(track, index, mediaType) {
    if (!isObject(track)) unavailable("Premiere track object");
    return {
      id: serializeId(property(track, "id") ?? property(track, "trackID") ?? property(track, "trackId")) ?? index,
      name: asString(property(track, "name")),
      index: asNumber(await readValue(track, "getIndex", "index")) ?? index,
      mediaType,
      isLocked: booleanValue(await readValue(track, "isLocked", "locked")),
      isMuted: booleanValue(await readValue(track, "isMuted", "muted")),
      isTargeted: booleanValue(await readValue(track, "isTargeted", "targeted")),
      typename: asString(property(track, "typename")) ?? asString(property(track, "typeName"))
    };
  }
  async function trackClips(request) {
    const sequence = await requireSequence(request.args?.[0]);
    const mediaType = normalizeMediaType(request.args?.[1]);
    const found = await findTrack(sequence, mediaType, request.args?.[2]);
    if (!found) unavailable("Premiere track");
    const clips = await trackClipObjects(found.track);
    return Promise.all(clips.map((clip, index) => serializeClip(clip, sequence, mediaType, found.index, index)));
  }
  async function selectedClips(sequence) {
    const selected = [];
    let count = 0;
    for (const mediaType of ["video", "audio"]) {
      const tracks = await sequenceTracks(sequence, mediaType);
      for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
        const clips = await trackClipObjects(tracks[trackIndex]);
        count += clips.length;
        validateCollectionCount(count);
        for (let index = 0; index < clips.length; index += 1) {
          if (booleanValue(await readValue(clips[index], "getIsSelected", "isSelected", "selected")) === true) {
            selected.push(await serializeClip(clips[index], sequence, mediaType, trackIndex, index));
          }
        }
      }
    }
    return selected;
  }
  async function findTrack(sequence, mediaType, idOrIndex) {
    const tracks = await sequenceTracks(sequence, mediaType);
    let index = 0;
    if (idOrIndex !== void 0 && idOrIndex !== null) {
      const matches = (value) => value !== void 0 && String(value) === String(idOrIndex);
      index = tracks.findIndex((track) => matches(serializeId(property(track, "id") ?? property(track, "trackID") ?? property(track, "trackId"))));
      if (index < 0) index = tracks.findIndex((track) => matches(property(track, "name")));
      if (index < 0) {
        const indices = await Promise.all(tracks.map((track, position) => readValue(track, "getIndex", "index").then((value) => value ?? position)));
        index = indices.findIndex(matches);
      }
    }
    return index >= 0 && tracks[index] ? { track: tracks[index], index } : void 0;
  }
  async function trackClipObjects(track) {
    const getTrackItems = property(track, "getTrackItems");
    if (getTrackItems) {
      const constants = property(premiereModule(), "Constants") ?? property(premiereModule(), "constants");
      const clipType = property(property(constants, "TrackItemType"), "CLIP");
      if (clipType === void 0) unavailable("Premiere TrackItemType.CLIP");
      return await collectionItems(await maybePromise(getTrackItems.call(track, clipType, false)), true);
    }
    return await collectionItems(property(track, "clips"), true);
  }
  async function serializeClip(clip, sequence, mediaType, trackIndex, clipIndex) {
    if (!isObject(clip)) unavailable("Premiere clip object");
    const projectItem = await readValue(clip, "getProjectItem", "projectItem");
    const nativeId = serializeId(property(clip, "id") ?? property(clip, "nodeId") ?? property(clip, "nodeID"));
    const parentSequenceId = sequenceId(sequence);
    if (nativeId === void 0 && parentSequenceId === void 0) unavailable("Premiere clip sequence ID");
    let isEnabled = booleanValue(await readValue(clip, "isEnabled", "enabled"));
    if (isEnabled === void 0) {
      const disabled = booleanValue(await readValue(clip, "isDisabled"));
      if (disabled !== void 0) isEnabled = !disabled;
    }
    return {
      id: nativeId ?? `${parentSequenceId}/${mediaType}/${trackIndex}/${clipIndex}`,
      idSource: nativeId === void 0 ? "derived" : "native",
      name: asString(await readValue(clip, "getName", "name")) ?? asString(property(projectItem, "name")),
      projectItemId: await projectItemId(projectItem),
      mediaPath: asString(property(clip, "mediaPath")) ?? await projectItemMediaPath(projectItem) ?? asString(property(projectItem, "treePath")),
      start: serializeTime(await readValue(clip, "getStartTime", "start")),
      end: serializeTime(await readValue(clip, "getEndTime", "end")),
      inPoint: serializeTime(await readValue(clip, "getInPoint", "inPoint")),
      outPoint: serializeTime(await readValue(clip, "getOutPoint", "outPoint")),
      duration: serializeTime(await readValue(clip, "getDuration", "duration")),
      isEnabled,
      isSelected: booleanValue(await readValue(clip, "getIsSelected", "isSelected", "selected")),
      typename: asString(property(clip, "typename")) ?? asString(property(clip, "typeName"))
    };
  }
  async function markerCollection(sequence) {
    const api = property(premiereModule(), "Markers");
    const getMarkers = property(api, "getMarkers");
    if (getMarkers) return await maybePromise(getMarkers.call(api, sequence));
    return property(sequence, "markers") ?? property(sequence, "markerCollection");
  }
  async function sequenceMarkers(sequence) {
    const markers = await markerCollection(sequence);
    const getMarkers = property(markers, "getMarkers") ?? property(sequence, "getMarkers");
    const items = getMarkers ? await collectionItems(await maybePromise(getMarkers.call(markers ?? sequence))) : await markerItems(markers);
    return (await Promise.all(items.map(serializeMarker))).filter((marker) => marker !== null);
  }
  async function createMarker(request) {
    const sequence = await requireSequence(request.args?.[0]);
    const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
    const markers = await markerCollection(sequence);
    const createAction = property(markers, "createAddMarkerAction");
    if (createAction) {
      const before = /* @__PURE__ */ new Map();
      for (const marker2 of await sequenceMarkers(sequence)) {
        const key = JSON.stringify(marker2);
        before.set(key, (before.get(key) ?? 0) + 1);
      }
      const start2 = premiereTickTime(property(payload, "start") ?? property(payload, "time") ?? 0);
      const end = property(payload, "end");
      const durationValue = property(payload, "duration");
      let duration = premiereTickTime(durationValue ?? 0);
      if (durationValue === void 0 && end !== void 0) {
        const endTime = premiereTickTime(end);
        const subtract = property(endTime, "subtract");
        if (!subtract) unavailable("Premiere TickTime.subtract");
        duration = subtract.call(endTime, start2);
      }
      if ((asNumber(property(duration, "seconds")) ?? 0) < 0) unavailable("Premiere marker duration");
      const markerType = asString(property(payload, "markerType") ?? property(payload, "marker_type")) ?? asString(property(property(premiereModule(), "Marker"), "MARKER_TYPE_COMMENT"));
      if (!markerType) unavailable("Premiere marker type");
      const action = createAction.call(
        markers,
        asString(property(payload, "name")) ?? "",
        markerType,
        start2,
        duration,
        asString(property(payload, "comments") ?? property(payload, "comment")) ?? ""
      );
      await executeProjectAction(await activeProject(), action, asString(request.options?.commandName) ?? "Create marker");
      for (const marker2 of await sequenceMarkers(sequence)) {
        const key = JSON.stringify(marker2);
        const count = before.get(key) ?? 0;
        if (count === 0) return marker2;
        before.set(key, count - 1);
      }
      unavailable("Premiere newly created marker");
    }
    const create = property(markers, "createMarker") ?? property(sequence, "createMarker");
    if (!create) unavailable("Premiere marker.createMarker");
    const start = property(payload, "start") ?? property(payload, "time") ?? 0;
    const marker = await maybePromise(create.call(markers ?? sequence, start));
    if (isObject(marker)) applyMarkerPayload(marker, payload);
    return serializeMarker(marker);
  }
  function applyMarkerPayload(marker, payload) {
    const assignments = [
      ["name", property(payload, "name")],
      ["comments", property(payload, "comments") ?? property(payload, "comment")],
      ["end", property(payload, "end")],
      ["duration", property(payload, "duration")],
      ["markerType", property(payload, "markerType") ?? property(payload, "marker_type")]
    ];
    for (const [key, value] of assignments) {
      if (value !== void 0) marker[key] = value;
    }
  }
  async function markerItems(markers) {
    const direct = await collectionItems(markers);
    if (direct.length > 0) return direct;
    const getFirstMarker = property(markers, "getFirstMarker");
    const getNextMarker = property(markers, "getNextMarker");
    if (getFirstMarker && getNextMarker) {
      const result = [];
      let current = getFirstMarker.call(markers);
      for (let guard = 0; current && guard < 1e4; guard += 1) {
        result.push(current);
        current = getNextMarker.call(markers, current);
      }
      return result;
    }
    return [];
  }
  async function serializeMarker(marker) {
    if (!isObject(marker)) return null;
    return {
      id: serializeId(property(marker, "id") ?? property(marker, "guid") ?? property(marker, "markerID") ?? property(marker, "markerId")),
      name: asString(await readValue(marker, "getName", "name")),
      comments: asString(await readValue(marker, "getComments", "comments", "comment")),
      start: serializeTime(await readValue(marker, "getStart", "start", "time")),
      end: serializeTime(property(marker, "end")),
      duration: serializeTime(await readValue(marker, "getDuration", "duration")),
      markerType: asString(await readValue(marker, "getType", "markerType", "marker_type")),
      typename: asString(property(marker, "typename")) ?? asString(property(marker, "typeName"))
    };
  }
  async function encoderManager() {
    const encoderApi = property(premiereModule(), "EncoderManager") ?? property(premiereModule(), "encoderManager");
    if (!encoderApi) unavailable("Premiere EncoderManager");
    const getManager = property(encoderApi, "getManager");
    const manager = getManager ? await maybePromise(getManager.call(encoderApi)) : encoderApi;
    if (!manager) unavailable("Premiere EncoderManager");
    return manager;
  }
  async function exporterApi() {
    const exporter = property(premiereModule(), "Exporter") ?? property(premiereModule(), "exporter");
    if (!exporter) unavailable("Premiere Exporter");
    return exporter;
  }
  function serializeEncoderManager(manager) {
    if (!isObject(manager)) return {};
    return {
      isAMEInstalled: booleanValue(property(manager, "isAMEInstalled")),
      typename: asString(property(manager, "typename")) ?? "EncoderManager"
    };
  }
  function serializeExporter(exporter) {
    if (!isObject(exporter)) return {};
    return {
      typename: asString(property(exporter, "typename")) ?? "Exporter"
    };
  }
  async function encoderPresets() {
    const manager = await encoderManager();
    const getPresets = property(manager, "getPresets") ?? property(manager, "getPresetList");
    const rawPresets = getPresets ? await maybePromise(getPresets.call(manager)) : property(manager, "presets");
    return (await collectionItems(rawPresets)).map(serializeEncoderPreset);
  }
  async function getExportFileExtension(request) {
    const payload = requestPayload(request);
    const presetPath = requiredPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file"), "Premiere encoder preset file");
    const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
    const encoderApi = property(premiereModule(), "EncoderManager") ?? property(premiereModule(), "encoderManager");
    const manager = await encoderManager();
    const staticGetExtension = property(encoderApi, "getExportFileExtension");
    const managerGetExtension = property(manager, "getExportFileExtension");
    const getExtension = staticGetExtension ?? managerGetExtension;
    if (!getExtension) unavailable("Premiere EncoderManager.getExportFileExtension");
    return await maybePromise(getExtension.call(staticGetExtension ? encoderApi : manager, sequence, presetPath));
  }
  async function encodeFile(request) {
    const payload = requestPayload(request);
    const sourcePath = requiredPath(
      property(payload, "sourcePath") ?? property(payload, "source_path") ?? property(payload, "filePath") ?? property(payload, "file_path") ?? property(payload, "inputPath") ?? property(payload, "input_path"),
      "Premiere encode source file"
    );
    const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"), "Premiere encode output file");
    const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
    const manager = await encoderManager();
    const encode = property(manager, "encodeFile");
    if (!encode) unavailable("Premiere EncoderManager.encodeFile");
    const outPoint = property(payload, "outPoint") ?? property(payload, "out_point");
    const nativeOutPoint = outPoint === void 0 ? property(property(premiereModule(), "TickTime"), "TIME_INVALID") : premiereTickTime(outPoint);
    if (!nativeOutPoint) unavailable("Premiere TickTime.TIME_INVALID");
    const result = await maybePromise(
      encode.call(
        manager,
        sourcePath,
        outputPath,
        presetPath,
        premiereTickTime(property(payload, "inPoint") ?? property(payload, "in_point") ?? 0),
        nativeOutPoint,
        asNumber(property(payload, "workArea") ?? property(payload, "work_area")) ?? 0,
        booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
        booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
      )
    );
    return serializeExportJob(result, { ...payload, sourcePath, outputPath, presetPath }, "encodeFile");
  }
  async function encodeProjectItem(request) {
    const payload = requestPayload(request);
    const projectItemId2 = property(payload, "projectItem") ?? property(payload, "project_item") ?? property(payload, "projectItemId") ?? property(payload, "project_item_id") ?? property(payload, "sourceId") ?? property(payload, "source_id");
    const projectItem = await castProjectItem(await requireProjectItem(projectItemId2), "ClipProjectItem");
    if (!projectItem) unavailable("Premiere ClipProjectItem for encoder");
    const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"), "Premiere encode output file");
    const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
    const manager = await encoderManager();
    const encode = property(manager, "encodeProjectItem");
    if (!encode) unavailable("Premiere EncoderManager.encodeProjectItem");
    const result = await maybePromise(
      encode.call(
        manager,
        projectItem,
        outputPath,
        presetPath,
        asNumber(property(payload, "workArea") ?? property(payload, "work_area")) ?? 0,
        booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
        booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
      )
    );
    return serializeExportJob(result, { ...payload, outputPath, presetPath }, "encodeProjectItem", projectItem);
  }
  async function exportSequence(request) {
    const payload = requestPayload(request);
    const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
    const outputPath = optionalPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"));
    const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
    const manager = await encoderManager();
    const exportSequenceMethod = property(manager, "exportSequence");
    if (!exportSequenceMethod) unavailable("Premiere EncoderManager.exportSequence");
    const exportType = resolveExportType(property(payload, "exportType") ?? property(payload, "export_type"));
    const result = await maybePromise(
      exportSequenceMethod.call(
        manager,
        sequence,
        exportType,
        outputPath,
        presetPath,
        booleanValue(property(payload, "exportFull") ?? property(payload, "export_full")) ?? true,
        booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
        booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
      )
    );
    return serializeExportJob(result, { ...payload, outputPath, presetPath, exportType: exportTypeName(exportType) }, "exportSequence", sequence);
  }
  async function exportFrame(request) {
    const payload = requestPayload(request);
    const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
    const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "filename") ?? property(payload, "path"), "Premiere frame output file");
    const exporter = await exporterApi();
    const exportSequenceFrame = property(exporter, "exportSequenceFrame");
    if (!exportSequenceFrame) unavailable("Premiere Exporter.exportSequenceFrame");
    const outputDirectory = asString(property(payload, "filepath")) ?? asString(property(payload, "filePath")) ?? parentDirectory(outputPath);
    const result = await maybePromise(
      exportSequenceFrame.call(
        exporter,
        sequence,
        premiereTickTime(property(payload, "time") ?? property(payload, "tickTime") ?? property(payload, "tick_time") ?? 0),
        outputPath,
        outputDirectory,
        asNumber(property(payload, "width")),
        asNumber(property(payload, "height"))
      )
    );
    return serializeExportJob(result, { ...payload, outputPath }, "exportFrame", sequence);
  }
  function serializeEncoderPreset(preset) {
    if (!isObject(preset)) {
      const path2 = asString(preset);
      return {
        name: path2?.split(/[\\/]/).filter(Boolean).pop() ?? path2,
        path: path2,
        format: void 0,
        extension: path2?.split(".").pop(),
        typename: "EncoderPreset"
      };
    }
    const path = asString(property(preset, "path")) ?? asString(property(preset, "presetPath")) ?? asString(property(preset, "filePath"));
    return {
      name: asString(property(preset, "name")) ?? path?.split(/[\\/]/).filter(Boolean).pop(),
      path,
      format: asString(property(preset, "format")),
      extension: asString(property(preset, "extension")) ?? path?.split(".").pop(),
      typename: asString(property(preset, "typename")) ?? asString(property(preset, "typeName")) ?? "EncoderPreset"
    };
  }
  async function serializeExportJob(result, payload, kind, source) {
    const resultObject = isObject(result) ? result : {};
    const resultJobId = property(resultObject, "jobId") ?? property(resultObject, "jobID") ?? property(resultObject, "id");
    const jobId = resultJobId ?? (typeof result === "string" || typeof result === "number" ? result : void 0);
    const started = typeof result === "boolean" ? result : booleanValue(property(resultObject, "started") ?? property(resultObject, "success") ?? property(resultObject, "ok"));
    return {
      id: jobId,
      jobId,
      status: asString(property(resultObject, "status")) ?? (started === false ? "failed" : kind === "exportFrame" ? "exported" : "queued"),
      outputPath: asString(property(resultObject, "outputPath")) ?? asString(property(resultObject, "outputFile")) ?? asString(property(payload, "outputPath")),
      presetPath: asString(property(resultObject, "presetPath")) ?? asString(property(resultObject, "presetFile")) ?? asString(property(payload, "presetPath")),
      sourceId: property(resultObject, "sourceId") ?? await projectItemId(source) ?? property(source, "id") ?? property(payload, "sourcePath"),
      sourceName: asString(property(resultObject, "sourceName")) ?? asString(property(source, "name")) ?? asString(property(payload, "sourcePath")),
      exportType: asString(property(resultObject, "exportType")) ?? asString(property(payload, "exportType")),
      removeUponCompletion: booleanValue(property(resultObject, "removeUponCompletion") ?? property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")),
      started,
      typename: asString(property(resultObject, "typename")) ?? "ExportJob"
    };
  }
  function requestPayload(request) {
    const first = request.args?.[0];
    return isObject(first) ? first : {};
  }
  function requiredPath(value, label) {
    const path = asString(value);
    if (!path) unavailable(label);
    return path;
  }
  function optionalPath(value) {
    return asString(value);
  }
  function resolveExportType(value) {
    if (value === void 0 || value === null) return value;
    const name = asString(value);
    if (!name) return value;
    const exportTypes = property(property(premiereModule(), "constants"), "ExportType");
    return property(exportTypes, name) ?? property(exportTypes, name.toUpperCase()) ?? value;
  }
  function exportTypeName(value) {
    const raw = asString(value);
    if (raw) return raw;
    if (value === void 0 || value === null) return void 0;
    return String(value);
  }
  function parentDirectory(outputPath) {
    const index = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
    return index > 0 ? outputPath.slice(0, index + 1) : "";
  }
  async function serializeProjectItems(items) {
    return (await Promise.all(items.map(serializeProjectItem))).filter((item) => item !== null);
  }
  async function serializeProjectItem(item) {
    if (!isObject(item)) return null;
    const children = await projectItemChildObjects(item);
    const typename = asString(property(item, "typename")) ?? asString(property(item, "typeName"));
    const mediaPath = await projectItemMediaPath(item);
    const treePath = asString(property(item, "treePath")) ?? asString(property(item, "path"));
    const folder = await castProjectItem(item, "FolderItem");
    const clip = await castProjectItem(item, "ClipProjectItem");
    const isSequence = booleanValue(await readValue(clip ?? item, "isSequence"));
    const itemType = folder || property(item, "getItems") ? "bin" : isSequence ? "sequence" : clip ? "clip" : projectItemType(item, children, typename, mediaPath);
    return {
      id: await projectItemId(item),
      name: asString(property(item, "name")),
      type: property(item, "type"),
      itemType,
      path: treePath ?? mediaPath,
      mediaPath,
      treePath,
      parentId: await projectItemId(await readValue(item, "getParentBin", "parent")),
      childCount: children.length,
      isBin: itemType === "bin",
      isClip: itemType === "clip",
      isSequence: itemType === "sequence",
      canProxy: booleanValue(await readValue(clip ?? item, "canProxy")),
      hasProxy: booleanValue(await readValue(clip ?? item, "hasProxy")),
      isOffline: booleanValue(await readValue(clip ?? item, "isOffline")),
      typename
    };
  }
  function projectItemType(item, children, typename, mediaPath) {
    const explicit = asString(property(item, "itemType")) ?? asString(property(item, "kind"));
    if (explicit) return explicit;
    const normalizedTypename = typename?.toLowerCase() ?? "";
    if (normalizedTypename.includes("folder") || normalizedTypename.includes("bin")) return "bin";
    if (booleanValue(property(item, "isBin")) === true || children.length > 0) return "bin";
    if (booleanValue(property(item, "isSequence")) === true || normalizedTypename.includes("sequence")) return "sequence";
    if (mediaPath || normalizedTypename.includes("clip")) return "clip";
    const type = property(item, "type");
    return type === void 0 ? void 0 : String(type);
  }
  async function projectItemId(item) {
    if (!item) return void 0;
    const direct = await readValue(item, "getId", "id", "guid", "nodeId", "nodeID");
    if (direct !== void 0 && direct !== null) return serializeId(direct);
    const base = await castProjectItem(item, "ProjectItem");
    return serializeId(await readValue(base, "getId"));
  }
  async function projectItemMediaPath(item) {
    if (!item) return void 0;
    const direct = await readValue(item, "getMediaFilePath", "mediaPath");
    if (direct !== void 0) return asString(direct);
    const clip = await castProjectItem(item, "ClipProjectItem");
    if (!clip) return void 0;
    const getPath = property(clip, "getMediaFilePath");
    if (!getPath) unavailable("Premiere ClipProjectItem.getMediaFilePath");
    return asString(await maybePromise(getPath.call(clip)));
  }
  async function castProjectItem(item, type) {
    const api = property(premiereModule(), type);
    const cast = property(api, "cast");
    return cast && item ? await maybePromise(cast.call(api, item)) : void 0;
  }
  async function projectItemChildObjects(item) {
    if (!isObject(item)) unavailable("Premiere project item object");
    const direct = await readValue(item, "getItems", "getChildren", "children", "items");
    if (direct !== void 0 && direct !== null) return await collectionItems(direct, true);
    const folder = await castProjectItem(item, "FolderItem");
    if (folder) {
      const getItems = property(folder, "getItems");
      if (!getItems) unavailable("Premiere FolderItem.getItems");
      return await collectionItems(await maybePromise(getItems.call(folder)), true);
    }
    const clip = await castProjectItem(item, "ClipProjectItem");
    if (clip || await projectItemMediaPath(item) !== void 0 || /clip|sequence/i.test(asString(property(item, "typename")) ?? asString(property(item, "itemType")) ?? "")) return [];
    unavailable("Premiere project item children");
  }
  async function findProjectItem(root, idOrName) {
    if (idOrName === void 0 || idOrName === null) return root;
    const items = await collectProjectItems(root);
    const target = String(idOrName);
    for (const item of items) {
      const id = await projectItemId(item);
      if (id !== void 0 && String(id) === target) return item;
    }
    for (const item of items) {
      const values = [property(item, "name"), property(item, "treePath"), property(item, "path"), await projectItemMediaPath(item)];
      if (values.some((value) => value !== void 0 && String(value) === target)) return item;
    }
    return void 0;
  }
  async function collectProjectItems(root) {
    const result = [];
    const queue = root ? [root] : [];
    const seen = /* @__PURE__ */ new Set();
    const seenIds = /* @__PURE__ */ new Set();
    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      if (!item || seen.has(item)) continue;
      seen.add(item);
      const id = await projectItemId(item);
      if (id !== void 0 && seenIds.has(id)) continue;
      if (id !== void 0) seenIds.add(id);
      result.push(item);
      validateCollectionCount(result.length);
      for (const child of await projectItemChildObjects(item)) {
        if (seen.has(child)) continue;
        queue.push(child);
        validateCollectionCount(queue.length);
      }
    }
    return result;
  }
  async function findProjectItemsMatchingMediaPath(root, matchString) {
    const matches = [];
    for (const item of await collectProjectItems(root)) {
      const mediaPath = await projectItemMediaPath(item);
      if (mediaPath?.includes(matchString)) matches.push(item);
    }
    return matches;
  }
  async function findImportedProjectItems(filePaths, root) {
    const candidates = await collectProjectItems(root);
    const mediaPaths = await Promise.all(candidates.map(projectItemMediaPath));
    const matches = [];
    for (const filePath of filePaths) {
      const index = mediaPaths.findIndex((path) => path?.replace(/\\/g, "/") === filePath.replace(/\\/g, "/"));
      if (index >= 0) matches.push(candidates[index]);
    }
    return matches;
  }
  function normalizeFilePaths(value) {
    const values = Array.isArray(value) ? value : [value];
    return values.map((item) => asString(item)).filter((item) => item !== void 0);
  }
  async function readValue(receiver, ...names) {
    for (const name of names) {
      const value = property(receiver, name);
      if (value !== void 0 && value !== null) {
        return typeof value === "function" ? await maybePromise(value.call(receiver)) : value;
      }
    }
    return void 0;
  }
  function serializeId(value) {
    if (typeof value === "string" || typeof value === "number") return value;
    if (value === void 0 || value === null) return void 0;
    try {
      const toString = property(value, "toString");
      if (typeof toString !== "function" || toString === Object.prototype.toString) return void 0;
      const converted = toString.call(value);
      if (isThenable(converted)) {
        Promise.resolve(converted).catch(() => void 0);
        return void 0;
      }
      return typeof converted === "string" && converted.length > 0 && converted !== "[object Object]" ? converted : void 0;
    } catch {
      return void 0;
    }
  }
  function validateCollectionCount(count) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) unavailable("Premiere collection count");
    if (count > COLLECTION_LIMIT) unavailable(`Premiere collection limit ${COLLECTION_LIMIT}`);
  }
  async function collectionItems(value, required = false) {
    return collectItems(await maybePromise(value), required);
  }
  async function collectItems(value, required) {
    if (Array.isArray(value)) {
      validateCollectionCount(value.length);
      return value;
    }
    const iterator = isObject(value) ? value[Symbol.iterator] : void 0;
    if (typeof iterator === "function") {
      const result2 = [];
      for (const item of value) {
        result2.push(item);
        validateCollectionCount(result2.length);
      }
      return result2;
    }
    const count = await readCollectionCount(value);
    if (count === void 0) {
      if (required) unavailable("Premiere collection read");
      return [];
    }
    validateCollectionCount(count);
    const at = property(value, "at") ?? property(value, "getAt") ?? property(value, "item");
    const result = [];
    for (let index = 0; index < count; index += 1) {
      const item = await maybePromise(at ? at.call(value, index) : property(value, String(index)));
      if ((item === void 0 || item === null) && required) unavailable(`Premiere collection item ${index}`);
      if (item !== void 0 && item !== null) result.push(item);
    }
    return result;
  }
  async function readCollectionCount(value) {
    const countNames = ["numItems", "numTracks", "numMarkers", "length"];
    const methodNames = ["getNumItems", "getNumTracks", "getNumMarkers", "getItemCount", "getCount", "getLength"];
    try {
      for (const name of countNames) {
        const raw = property(value, name);
        if (raw === void 0 || raw === null) continue;
        const resolved = typeof raw === "function" ? await maybePromise(raw.call(value)) : await maybePromise(raw);
        const count = asNumber(resolved);
        if (count !== void 0) return count;
      }
      for (const name of methodNames) {
        const method = property(value, name);
        if (typeof method !== "function") continue;
        const count = asNumber(await maybePromise(method.call(value)));
        if (count !== void 0) return count;
      }
    } catch {
      return void 0;
    }
    return void 0;
  }
  function normalizeMediaType(value) {
    return asString(value)?.toLowerCase() === "audio" ? "audio" : "video";
  }
  function booleanValue(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
    return void 0;
  }
  function serializeTime(value) {
    if (!isObject(value)) return asNumber(value) ?? asString(value) ?? value;
    const seconds = asNumber(property(value, "seconds"));
    const ticks = asString(property(value, "ticks")) ?? asString(property(value, "ticksPerSecond"));
    if (seconds !== void 0 && ticks !== void 0) return { seconds, ticks };
    if (seconds !== void 0) return seconds;
    if (ticks !== void 0) return ticks;
    return asNumber(value) ?? value;
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
    const element = globalThis.document?.getElementById("adobepy-bridge-status");
    if (element) element.textContent = statusText[status];
  }

  // bridges/uxp/premiere/src/main.ts
  var config = globalThis;
  config.__ADOBEPY_BROKER_URL = config.__ADOBEPY_BROKER_URL || "ws://localhost:47391/v1/bridge/premiere/ws";
  connectBridge(premiereAdapter, void 0, showBridgeStatus);
})();
//# sourceMappingURL=main.js.map
