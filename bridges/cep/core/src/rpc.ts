import type { BridgeIdentityClaim, Capabilities, RpcRequest } from "./protocol";
import { ERROR_CODES } from "./protocol";
import type { BridgeStatus } from "../../../shared/status";
import { cepSystemPath } from "./system-path";

export interface CepConfig {
  host: string;
  brokerUrl: string;
  token: string;
  target: string;
  capabilities: Capabilities;
  identityProvider?: () => Promise<BridgeIdentityClaim | undefined> | BridgeIdentityClaim | undefined;
  onStatus?: (status: BridgeStatus) => void;
}

declare const WebSocket: any;

export function startCepBridge(config: CepConfig): void {
  config.onStatus?.("starting");
  const cep = (globalThis as any).__adobe_cep__;
  if (!cep || typeof cep.evalScript !== "function") {
    config.onStatus?.("error");
    throw new Error("Adobe CEP evalScript API unavailable");
  }
  if (typeof config.token !== "string" || config.token.trim() === "") {
    config.onStatus?.("error");
    throw new Error("ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
  }
  const extensionPath = cepSystemPath(cep.getSystemPath("extension"));
  if (!extensionPath) {
    config.onStatus?.("error");
    throw new Error("Adobe CEP extension path unavailable");
  }
  const connect = async () => {
    config.onStatus?.("connecting");
    let failed = false;
    let identity: BridgeIdentityClaim | undefined;
    if (config.identityProvider) {
      try {
        const provided = config.identityProvider();
        identity = provided && typeof (provided as any).then === "function"
          ? await (provided as Promise<BridgeIdentityClaim | undefined>)
          : provided as BridgeIdentityClaim | undefined;
      } catch {
        failed = true;
        config.onStatus?.("error");
        console.error("[adobepy] runtime identity is unavailable; exact-instance verification will fail closed.");
      }
    }
    const bootstrapNonce = boundedBootstrapNonce((globalThis as any).__ADOBEPY_BOOTSTRAP_NONCE);
    const capabilities = identity?.host.hostVersion
      ? { ...config.capabilities, hostVersion: identity.host.hostVersion }
      : config.capabilities;
    let socket: any;
    try {
      socket = new WebSocket(config.brokerUrl);
    } catch (error) {
      config.onStatus?.("error");
      throw error;
    }
    let greeted = false;
    const greet = () => {
      if (greeted || socket.readyState !== 1) return;
      greeted = true;
      try {
        socket.send(JSON.stringify({
          type: "hello",
          token: config.token,
          target: config.target,
          capabilities,
          ...(identity ? { identity } : {}),
          ...(bootstrapNonce ? { bootstrapNonce } : {})
        }));
      } catch (error) {
        failed = true;
        config.onStatus?.("error");
        throw error;
      }
      config.onStatus?.(failed ? "error" : "ready");
      console.log("adobepy CEP bridge hello sent; connection verification pending", capabilities);
    };
    socket.onopen = greet;
    socket.onerror = () => {
      failed = true;
      config.onStatus?.("error");
    };
    socket.onclose = () => config.onStatus?.(failed ? "error" : "disconnected");
    setTimeout(greet, 0);
    const reportProtocolViolation = (reason: string): void => {
      failed = true;
      config.onStatus?.("error");
      console.error(`[adobepy] ${reason}`);
      try {
        // Answer a bad frame through the shared BridgeError envelope instead of
        // letting an uncaught exception escape the message handler.
        socket.send(JSON.stringify({
          type: "error",
          error: {
            jsonrpc: "2.0",
            id: null,
            error: { code: ERROR_CODES.ERROR_PARSE, message: "Invalid bridge frame" }
          }
        }));
      } catch {
        // The transport may already be gone; the status is already failed.
      }
      if (typeof socket.close === "function") socket.close();
    };
    socket.onmessage = (event: { data: string }) => {
      let message: unknown;
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
      // Broker rejections arrive either as a bare JSON-RPC error object or as
      // the shared BridgeError envelope (type: "error"). Both must fail closed.
      if (isBrokerError(message)) {
        failed = true;
        config.onStatus?.("error");
        return;
      }
      if (message.type !== "request") return;
      const request = message.request as RpcRequest;
      const requestLiteral = JSON.stringify(JSON.stringify(request))
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
      try {
        cep.evalScript(`adobepyDispatch(${requestLiteral})`, (raw: string) => {
          try {
            if (typeof raw !== "string" || raw.trim() === "") {
              throw new Error("Adobe CEP evalScript returned no JSON response");
            }
            if (raw.trim() === "EvalScript error.") {
              throw new Error("Adobe CEP evalScript failed");
            }
            const parsed = JSON.parse(raw);
            if (parsed.error) {
              socket.send(JSON.stringify({ type: "error", error: { ...parsed, id: parsed.id ?? request.id } }));
              return;
            }
            if (!Object.prototype.hasOwnProperty.call(parsed, "result")) parsed.result = null;
            socket.send(JSON.stringify({ type: "response", response: parsed }));
          } catch (error: any) {
            socket.send(JSON.stringify({ type: "error", error: hostScriptError(request.id, error) }));
          }
        });
      } catch (error: any) {
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
      'typeof JSON.stringify === "function"',
    ].join(" && ");
    cep.evalScript(`${probe} ? "ready" : "missing"`, (status: string) => {
      if (status === "ready") void connect();
      else {
        config.onStatus?.("error");
        console.error("adobepy CEP host runtime failed to initialize", status);
      }
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

function boundedBootstrapNonce(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function hostScriptError(id: string | number, error: any) {
  return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: error?.message || String(error) } };
}

function isBridgeEnvelope(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrokerError(message: Record<string, unknown>): boolean {
  return Boolean(message.error) && (message.type === "error" || message.jsonrpc === "2.0");
}
