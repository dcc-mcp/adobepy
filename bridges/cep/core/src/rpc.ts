import type { Capabilities, RpcRequest } from "./protocol";
import { ERROR_CODES } from "./protocol";

export interface CepConfig {
  host: string;
  brokerUrl: string;
  token: string;
  target: string;
  capabilities: Capabilities;
}

declare const WebSocket: any;

export function startCepBridge(config: CepConfig): void {
  const cep = (globalThis as any).__adobe_cep__;
  if (!cep || typeof cep.evalScript !== "function") throw new Error("Adobe CEP evalScript API unavailable");
  if (typeof config.token !== "string" || config.token.trim() === "") {
    throw new Error("ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
  }
  const extensionPath = cep.getSystemPath("extension").replace(/\\/g, "/");
  const connect = () => {
    const socket = new WebSocket(config.brokerUrl);
    let greeted = false;
    const greet = () => {
      if (greeted || socket.readyState !== 1) return;
      greeted = true;
      socket.send(JSON.stringify({ type: "hello", token: config.token, target: config.target, capabilities: config.capabilities }));
      console.log("adobepy CEP bridge connected", config.capabilities);
    };
    socket.onopen = greet;
    setTimeout(greet, 0);
    socket.onmessage = (event: { data: string }) => {
      const message = JSON.parse(event.data);
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
      if (status === "ready") connect();
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

function hostScriptError(id: string | number, error: any) {
  return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: error?.message || String(error) } };
}
