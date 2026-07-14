import { startCepBridge } from "../../core/src/rpc";

startCepBridge({
  host: "after-effects",
  brokerUrl: (globalThis as any).__ADOBEPY_BROKER_URL || "ws://127.0.0.1:47391/v1/bridge/after-effects/ws",
  token: (globalThis as any).__ADOBEPY_TOKEN || "dev-token",
  target: (globalThis as any).__ADOBEPY_TARGET || "default",
  capabilities: {
    host: "after-effects",
    bridgeKind: "cep",
    bridgeVersion: "0.1.0",
    namespaces: ["app", "project", "item", "layer", "mask", "effect", "text", "renderQueue", "renderQueueItem", "outputModule", "raw"],
    features: ["extendscript", "projectInfo", "projectItems", "compositions", "footageItems", "layers", "masks", "effects", "text", "renderQueue", "outputModule"],
    methods: {
      app: ["getVersion"],
      project: ["getActive", "getItems", "getCompositions", "getFootageItems", "getFolders", "getActiveItem", "getSelectedItems", "save"],
      item: ["getById", "getByName"],
      layer: ["getLayers", "getSelected", "getById"],
      mask: ["getMasks"],
      effect: ["getEffects", "getByName"],
      text: ["getSourceText", "setSourceText"],
      renderQueue: ["get", "getItems", "getItemByIndex", "addComposition", "queueSelectedCompositions", "render", "pauseRendering", "stopRendering", "showWindow", "queueInAME", "setQueueNotify"],
      renderQueueItem: ["applyTemplate", "setSettings", "setRender", "setQueueItemNotify"],
      outputModule: ["getModules", "getByIndex", "applyTemplate", "setSettings", "setOutputPath", "saveAsTemplate"],
      raw: ["evalExtendScript"]
    }
  }
});
