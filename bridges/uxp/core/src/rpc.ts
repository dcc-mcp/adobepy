import type { HostAdapter } from "./host-adapter";
import type { BridgeIdentityClaim, RpcRequest } from "./protocol";
import { BridgeRpcError, ERROR_HOST_SCRIPT } from "./errors";
import type { BridgeStatus } from "../../../shared/status";

declare const WebSocket: any;

export type BridgeIdentityProvider = () => Promise<BridgeIdentityClaim | undefined>;

export function connectBridge(
  adapter: HostAdapter,
  identityProvider?: BridgeIdentityProvider,
  onStatus?: (status: BridgeStatus) => void
): void {
  onStatus?.("starting");
  const url = (globalThis as any).__ADOBEPY_BROKER_URL || `ws://127.0.0.1:47391/v1/bridge/${adapter.capabilities().host}/ws`;
  const token = (globalThis as any).__ADOBEPY_TOKEN;
  if (typeof token !== "string" || token.trim() === "") {
    onStatus?.("error");
    console.error("[adobepy] ADOBEPY_TOKEN is missing; install the bridge with --token or configure adobepy.config.js.");
    return;
  }
  const target = (globalThis as any).__ADOBEPY_TARGET || "default";
  onStatus?.("connecting");
  let failed = false;
  let socket: any;
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
    let identity: BridgeIdentityClaim | undefined;
    try {
      identity = await identityProvider?.();
    } catch {
      failed = true;
      onStatus?.("error");
      console.error("[adobepy] runtime identity is unavailable; exact-instance verification will fail closed.");
    }
    if (socket.readyState !== 1) return;
    const bootstrapNonce = boundedBootstrapNonce((globalThis as any).__ADOBEPY_BOOTSTRAP_NONCE);
    try {
      socket.send(JSON.stringify({
        type: "hello",
        token,
        target,
        capabilities: adapter.capabilities(),
        ...(identity ? { identity } : {}),
        ...(bootstrapNonce ? { bootstrapNonce } : {})
      }));
    } catch (error) {
      failed = true;
      onStatus?.("error");
      throw error;
    }
    onStatus?.(failed ? "error" : "ready");
  });
  socket.addEventListener("message", async (event: { data: string }) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      failed = true;
      onStatus?.("error");
      throw error;
    }
    if (message.jsonrpc === "2.0" && message.error) {
      failed = true;
      onStatus?.("error");
      return;
    }
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

function boundedBootstrapNonce(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value) ? value : undefined;
}

function hostError(id: string | number, error: unknown) {
  const code = error instanceof BridgeRpcError ? error.code : ERROR_HOST_SCRIPT;
  const message = error instanceof Error ? error.message : String(error);
  const data = error instanceof BridgeRpcError ? error.data : undefined;
  return { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}
