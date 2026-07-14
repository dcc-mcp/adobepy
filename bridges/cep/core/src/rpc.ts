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
  const socket = new WebSocket(config.brokerUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", token: config.token, target: config.target, capabilities: config.capabilities }));
    console.log("adobepy CEP bridge connected", config.capabilities);
  });
  socket.addEventListener("message", (event: { data: string }) => {
    const message = JSON.parse(event.data);
    if (message.type !== "request") return;
    const request = message.request as RpcRequest;
    const encoded = encodeURIComponent(JSON.stringify(request)).replace(/'/g, "%27");
    try {
      cep.evalScript(`adobepyDispatch(decodeURIComponent('${encoded}'))`, (raw: string) => {
        try {
          const parsed = raw ? JSON.parse(raw) : { jsonrpc: "2.0", id: request.id, result: null };
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
  });
}

function hostScriptError(id: string | number, error: any) {
  return { jsonrpc: "2.0", id, error: { code: ERROR_CODES.ERROR_HOST_SCRIPT, message: error?.message || String(error) } };
}
