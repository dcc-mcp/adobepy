import { connectBridge } from "../../core/src/rpc";
import { photoshopAdapter } from "./host";
import { photoshopRuntimeIdentity } from "./identity";

connectBridge(photoshopAdapter, photoshopRuntimeIdentity);
