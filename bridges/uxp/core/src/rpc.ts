import type { HostAdapter } from "./host-adapter";
import type { BridgeIdentityClaim, RpcRequest } from "./protocol";
import { ERROR_CODES } from "./protocol";
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
  const initialRetryDelayMs = 500;
  const maxRetryDelayMs = 30_000;
  let retryDelayMs = initialRetryDelayMs;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let terminalFailure = false;
  let socket: any;
  const scheduleReconnect = (): void => {
    if (terminalFailure || reconnectTimer !== undefined) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(maxRetryDelayMs, retryDelayMs * 2);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
    (reconnectTimer as any).unref?.();
  };
  const reportTerminalFailure = (candidate: any, reason?: string, notifyBroker = true): void => {
    if (candidate !== socket) return;
    terminalFailure = true;
    onStatus?.("error");
    if (reason) console.error(`[adobepy] ${reason}`);
    if (notifyBroker) {
      try {
        // Answer a bad frame through the shared BridgeError envelope instead of
        // letting an uncaught exception escape the message handler.
        candidate.send(JSON.stringify({
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
    }
    if (typeof candidate.close === "function") candidate.close();
  };
  const scheduleTransportRetry = (candidate: any): void => {
    if (candidate !== socket || terminalFailure) return;
    try {
      if (typeof candidate.close === "function") candidate.close();
    } catch {
      // The close event below still drives the retry if the host reports it.
    }
    scheduleReconnect();
  };
  function openSocket(): void {
    if (terminalFailure) return;
    onStatus?.("connecting");
    try {
      socket = new WebSocket(url);
    } catch {
      onStatus?.("error");
      scheduleReconnect();
      return;
    }
    const candidate = socket;
    let transportFailed = false;
    candidate.addEventListener("error", () => {
      if (candidate !== socket || terminalFailure) return;
      transportFailed = true;
      onStatus?.("error");
      scheduleTransportRetry(candidate);
    });
    candidate.addEventListener("close", () => {
      if (candidate !== socket) return;
      if (terminalFailure) {
        onStatus?.("error");
        return;
      }
      onStatus?.(transportFailed ? "error" : "disconnected");
      scheduleReconnect();
    });
    candidate.addEventListener("open", async () => {
      if (candidate !== socket || terminalFailure) return;
      let identity: BridgeIdentityClaim | undefined;
      try {
        identity = await identityProvider?.();
      } catch {
        reportTerminalFailure(candidate, "runtime identity is unavailable; exact-instance verification will fail closed.", false);
        return;
      }
      if (candidate !== socket || terminalFailure || candidate.readyState !== 1) return;
      const bootstrapNonce = boundedBootstrapNonce((globalThis as any).__ADOBEPY_BOOTSTRAP_NONCE);
      try {
        candidate.send(JSON.stringify({
          type: "hello",
          token,
          target,
          capabilities: adapter.capabilities(),
          ...(identity ? { identity } : {}),
          ...(bootstrapNonce ? { bootstrapNonce } : {})
        }));
      } catch {
        transportFailed = true;
        onStatus?.("error");
        scheduleTransportRetry(candidate);
        return;
      }
      onStatus?.("ready");
    });
    candidate.addEventListener("message", async (event: { data: string }) => {
      if (candidate !== socket || terminalFailure) return;
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        reportTerminalFailure(candidate, "Invalid JSON frame from broker");
        return;
      }
      if (!isBridgeEnvelope(message)) {
        reportTerminalFailure(candidate, "Invalid bridge frame from broker");
        return;
      }
      retryDelayMs = initialRetryDelayMs;
      // Broker rejections arrive either as a bare JSON-RPC error object or as the
      // shared BridgeError envelope (type: "error"). Both must fail closed.
      if (isBrokerError(message)) {
        reportTerminalFailure(candidate, undefined, false);
        return;
      }
      if (message.type !== "request") return;
      const request = message.request as RpcRequest;
      try {
        const result = await adapter.dispatch(request);
        if (candidate !== socket || candidate.readyState !== 1) return;
        candidate.send(JSON.stringify({ type: "response", response: { jsonrpc: "2.0", id: request.id, result: result ?? null } }));
      } catch (error: any) {
        if (candidate !== socket || candidate.readyState !== 1) return;
        try {
          candidate.send(JSON.stringify({ type: "error", error: hostError(request.id, error) }));
        } catch {
          transportFailed = true;
          onStatus?.("error");
          scheduleTransportRetry(candidate);
        }
      }
    });
  }
  openSocket();
}

function isBridgeEnvelope(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrokerError(message: Record<string, unknown>): boolean {
  return Boolean(message.error) && (message.type === "error" || message.jsonrpc === "2.0");
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
