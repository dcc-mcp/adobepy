import type { HostAdapter } from "./host-adapter";
import type { BridgeRequest, RpcRequest } from "./protocol";
import { BridgeRpcError, ERROR_HOST_SCRIPT } from "./errors";

declare const WebSocket: any;

export function connectBridge(adapter: HostAdapter): void {
  const url = (globalThis as any).__ADOBEPY_BROKER_URL || `ws://127.0.0.1:47391/v1/bridge/${adapter.capabilities().host}/ws`;
  const token = (globalThis as any).__ADOBEPY_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    console.error("[adobepy] ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
    return;
  }
  const target = (globalThis as any).__ADOBEPY_TARGET || "default";
  const socket = new WebSocket(url);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", token, target, capabilities: adapter.capabilities() }));
  });
  socket.addEventListener("message", async (event: { data: string }) => {
    const message = JSON.parse(event.data) as BridgeRequest;
    if (message.type !== "request") return;
    const request = message.request as RpcRequest;
    try {
      const result = await adapter.dispatch(request);
      socket.send(JSON.stringify({ type: "response", response: { jsonrpc: "2.0", id: request.id, result: result ?? null } }));
    } catch (error: any) {
      socket.send(JSON.stringify({ type: "error", error: hostError(request.id, error) }));
    }
  });
}

function hostError(id: string | number, error: unknown) {
  const code = error instanceof BridgeRpcError ? error.code : ERROR_HOST_SCRIPT;
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof BridgeRpcError ? error.data : undefined;
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
