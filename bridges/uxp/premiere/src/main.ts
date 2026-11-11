import { connectBridge } from "../../core/src/rpc";
import { premiereAdapter } from "./host";
import { showBridgeStatus } from "../../../shared/status";

// Use Premiere's permitted localhost origin for the default bridge connection.
const config = globalThis as { __ADOBEPY_BROKER_URL?: string };
config.__ADOBEPY_BROKER_URL = config.__ADOBEPY_BROKER_URL || "ws://localhost:47391/v1/bridge/premiere/ws";
connectBridge(premiereAdapter, undefined, showBridgeStatus);
