export type BridgeStatus = "starting" | "connecting" | "ready" | "disconnected" | "error";

const statusText: Record<BridgeStatus, string> = {
  starting: "Starting bridge…",
  connecting: "Connecting to broker…",
  ready: "Bridge service ready. Broker/client connection is not verified.",
  disconnected: "Disconnected from broker. Check bridge and broker logs.",
  error: "Bridge not ready. Check bridge configuration and broker logs."
};

export function showBridgeStatus(status: BridgeStatus): void {
  const element = globalThis.document?.getElementById("adobepy-bridge-status");
  if (element) element.textContent = statusText[status];
}
