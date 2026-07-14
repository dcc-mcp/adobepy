function adobepyDispatch(payload) {
  var request = JSON.parse(payload);
  try {
    if (request.namespace === "app" && request.method === "getVersion") {
      return adobepyResult(request.id, String(app.version || ""));
    }
    if (request.namespace === "app" && request.method === "openProject") {
      var projectPath = String((request.args || [])[0] || "");
      if (!projectPath) throw new Error("After Effects project path required");
      return adobepyResult(request.id, adobepyAfterEffectsProject(app.open(new File(projectPath))));
    }
    if (request.namespace === "project" && request.method === "getActive") {
      return adobepyResult(request.id, adobepyAfterEffectsProject(app.project));
    }
    if (request.namespace === "project" && request.method === "getItems") {
      return adobepyResult(request.id, adobepyAfterEffectsItems(app.project));
    }
    if (request.namespace === "project" && request.method === "getCompositions") {
      return adobepyResult(request.id, adobepyAfterEffectsItemsByType(app.project, "composition"));
    }
    if (request.namespace === "project" && request.method === "getFootageItems") {
      return adobepyResult(request.id, adobepyAfterEffectsItemsByType(app.project, "footage"));
    }
    if (request.namespace === "project" && request.method === "getFolders") {
      return adobepyResult(request.id, adobepyAfterEffectsItemsByType(app.project, "folder"));
    }
    if (request.namespace === "project" && request.method === "getActiveItem") {
      return adobepyResult(request.id, adobepyAfterEffectsItem(app.project && app.project.activeItem, app.project));
    }
    if (request.namespace === "project" && request.method === "getSelectedItems") {
      return adobepyResult(request.id, adobepyAfterEffectsSelectedItems(app.project));
    }
    if (request.namespace === "project" && request.method === "save") {
      var savePath = String((request.args || [])[0] || "");
      if (!app.project) throw new Error("After Effects project unavailable");
      app.project.save(savePath ? new File(savePath) : undefined);
      return adobepyResult(request.id, adobepyAfterEffectsProject(app.project));
    }
    if (request.namespace === "project" && request.method === "importFile") {
      return adobepyResult(request.id, adobepyAfterEffectsImportFile(app.project, (request.args || [])[0] || {}));
    }
    if (request.namespace === "project" && request.method === "createComposition") {
      return adobepyResult(request.id, adobepyAfterEffectsCreateComposition(app.project, (request.args || [])[0] || {}));
    }
    if (request.namespace === "item" && request.method === "getById") {
      return adobepyResult(request.id, adobepyAfterEffectsItem(adobepyAfterEffectsFindItemById(app.project, (request.args || [])[0]), app.project));
    }
    if (request.namespace === "item" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyAfterEffectsItemsByName(app.project, String((request.args || [])[0] || "")));
    }
    if (request.namespace === "layer" && request.method === "getLayers") {
      return adobepyResult(request.id, adobepyAfterEffectsLayers(adobepyAfterEffectsRequireComp(app.project, (request.args || [])[0])));
    }
    if (request.namespace === "layer" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyAfterEffectsSelectedLayers(adobepyAfterEffectsRequireComp(app.project, (request.args || [])[0])));
    }
    if (request.namespace === "layer" && request.method === "getById") {
      var layerArgs = request.args || [];
      var layerComp = adobepyAfterEffectsRequireComp(app.project, layerArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsLayer(adobepyAfterEffectsFindLayer(layerComp, layerArgs[1]), layerComp));
    }
    if (request.namespace === "layer" && request.method === "createText") {
      return adobepyResult(request.id, adobepyAfterEffectsCreateTextLayer(app.project, (request.args || [])[0], (request.args || [])[1] || {}));
    }
    if (request.namespace === "layer" && request.method === "createSolid") {
      return adobepyResult(request.id, adobepyAfterEffectsCreateSolidLayer(app.project, (request.args || [])[0], (request.args || [])[1] || {}));
    }
    if (request.namespace === "layer" && request.method === "createFootage") {
      return adobepyResult(request.id, adobepyAfterEffectsCreateFootageLayer(app.project, (request.args || [])[0], (request.args || [])[1] || {}));
    }
    if (request.namespace === "layer" && request.method === "setTransform") {
      return adobepyResult(request.id, adobepyAfterEffectsSetTransform(app.project, (request.args || [])[0], (request.args || [])[1], (request.args || [])[2] || {}));
    }
    if (request.namespace === "layer" && request.method === "setKeyframes") {
      return adobepyResult(request.id, adobepyAfterEffectsSetKeyframes(app.project, (request.args || [])[0], (request.args || [])[1], (request.args || [])[2] || {}));
    }
    if (request.namespace === "mask" && request.method === "getMasks") {
      var maskArgs = request.args || [];
      var maskComp = adobepyAfterEffectsRequireComp(app.project, maskArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsMasks(adobepyAfterEffectsRequireLayer(maskComp, maskArgs[1])));
    }
    if (request.namespace === "effect" && request.method === "getEffects") {
      var effectArgs = request.args || [];
      var effectComp = adobepyAfterEffectsRequireComp(app.project, effectArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsEffects(adobepyAfterEffectsRequireLayer(effectComp, effectArgs[1])));
    }
    if (request.namespace === "effect" && request.method === "getByName") {
      var effectByNameArgs = request.args || [];
      var effectByNameComp = adobepyAfterEffectsRequireComp(app.project, effectByNameArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsEffectByName(adobepyAfterEffectsRequireLayer(effectByNameComp, effectByNameArgs[1]), String(effectByNameArgs[2] || "")));
    }
    if (request.namespace === "text" && request.method === "getSourceText") {
      var textArgs = request.args || [];
      var textComp = adobepyAfterEffectsRequireComp(app.project, textArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsSourceText(adobepyAfterEffectsRequireLayer(textComp, textArgs[1])));
    }
    if (request.namespace === "text" && request.method === "setSourceText") {
      var setTextArgs = request.args || [];
      var setTextComp = adobepyAfterEffectsRequireComp(app.project, setTextArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsSetSourceText(adobepyAfterEffectsRequireLayer(setTextComp, setTextArgs[1]), setTextArgs[2] || {}));
    }
    if (request.namespace === "renderQueue" && request.method === "get") {
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(adobepyAfterEffectsRequireRenderQueue(app.project)));
    }
    if (request.namespace === "renderQueue" && request.method === "getItems") {
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueueItems(adobepyAfterEffectsRequireRenderQueue(app.project)));
    }
    if (request.namespace === "renderQueue" && request.method === "getItemByIndex") {
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueueItem(adobepyAfterEffectsFindRenderQueueItem(adobepyAfterEffectsRequireRenderQueue(app.project), (request.args || [])[0]), (request.args || [])[0]));
    }
    if (request.namespace === "renderQueue" && request.method === "addComposition") {
      return adobepyResult(request.id, adobepyAfterEffectsAddCompositionToRenderQueue(app.project, (request.args || [])[0] || {}));
    }
    if (request.namespace === "renderQueue" && request.method === "queueSelectedCompositions") {
      return adobepyResult(request.id, adobepyAfterEffectsQueueSelectedCompositions(app.project, (request.args || [])[0] || {}));
    }
    if (request.namespace === "renderQueue" && request.method === "render") {
      var renderQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      if (typeof renderQueue.render !== "function") throw new Error("After Effects RenderQueue.render unavailable");
      renderQueue.render();
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(renderQueue));
    }
    if (request.namespace === "renderQueue" && request.method === "pauseRendering") {
      var pauseQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      if (typeof pauseQueue.pauseRendering !== "function") throw new Error("After Effects RenderQueue.pauseRendering unavailable");
      pauseQueue.pauseRendering(Boolean((request.args || [])[0]));
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(pauseQueue));
    }
    if (request.namespace === "renderQueue" && request.method === "stopRendering") {
      var stopQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      if (typeof stopQueue.stopRendering !== "function") throw new Error("After Effects RenderQueue.stopRendering unavailable");
      stopQueue.stopRendering();
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(stopQueue));
    }
    if (request.namespace === "renderQueue" && request.method === "showWindow") {
      var showQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      if (typeof showQueue.showWindow !== "function") throw new Error("After Effects RenderQueue.showWindow unavailable");
      showQueue.showWindow(Boolean((request.args || [])[0]));
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(showQueue));
    }
    if (request.namespace === "renderQueue" && request.method === "queueInAME") {
      var ameQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      if (typeof ameQueue.queueInAME !== "function") throw new Error("After Effects RenderQueue.queueInAME unavailable");
      ameQueue.queueInAME(Boolean((request.args || [])[0]));
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(ameQueue));
    }
    if (request.namespace === "renderQueue" && request.method === "setQueueNotify") {
      var notifyQueue = adobepyAfterEffectsRequireRenderQueue(app.project);
      notifyQueue.queueNotify = Boolean((request.args || [])[0]);
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueue(notifyQueue));
    }
    if (request.namespace === "renderQueueItem" && request.method === "applyTemplate") {
      var applyRqArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsApplyRenderQueueItemTemplate(adobepyAfterEffectsRequireRenderQueue(app.project), applyRqArgs[0], String(applyRqArgs[1] || "")));
    }
    if (request.namespace === "renderQueueItem" && request.method === "setSettings") {
      var rqSettingsArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsSetRenderQueueItemSettings(adobepyAfterEffectsRequireRenderQueue(app.project), rqSettingsArgs[0], rqSettingsArgs[1] || {}));
    }
    if (request.namespace === "renderQueueItem" && request.method === "setRender") {
      var rqRenderArgs = request.args || [];
      var rqRenderItem = adobepyAfterEffectsRequireRenderQueueItem(adobepyAfterEffectsRequireRenderQueue(app.project), rqRenderArgs[0]);
      rqRenderItem.render = Boolean(rqRenderArgs[1]);
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueueItem(rqRenderItem, rqRenderArgs[0]));
    }
    if (request.namespace === "renderQueueItem" && request.method === "setQueueItemNotify") {
      var rqNotifyArgs = request.args || [];
      var rqNotifyItem = adobepyAfterEffectsRequireRenderQueueItem(adobepyAfterEffectsRequireRenderQueue(app.project), rqNotifyArgs[0]);
      rqNotifyItem.queueItemNotify = Boolean(rqNotifyArgs[1]);
      return adobepyResult(request.id, adobepyAfterEffectsRenderQueueItem(rqNotifyItem, rqNotifyArgs[0]));
    }
    if (request.namespace === "outputModule" && request.method === "getModules") {
      var outputModulesArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsOutputModules(adobepyAfterEffectsRequireRenderQueueItem(adobepyAfterEffectsRequireRenderQueue(app.project), outputModulesArgs[0])));
    }
    if (request.namespace === "outputModule" && request.method === "getByIndex") {
      var outputByIndexArgs = request.args || [];
      var outputByIndexItem = adobepyAfterEffectsRequireRenderQueueItem(adobepyAfterEffectsRequireRenderQueue(app.project), outputByIndexArgs[0]);
      return adobepyResult(request.id, adobepyAfterEffectsOutputModule(adobepyAfterEffectsFindOutputModule(outputByIndexItem, outputByIndexArgs[1]), outputByIndexItem, outputByIndexArgs[0], outputByIndexArgs[1]));
    }
    if (request.namespace === "outputModule" && request.method === "applyTemplate") {
      var outputTemplateArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsApplyOutputModuleTemplate(adobepyAfterEffectsRequireRenderQueue(app.project), outputTemplateArgs[0], outputTemplateArgs[1], String(outputTemplateArgs[2] || "")));
    }
    if (request.namespace === "outputModule" && request.method === "setSettings") {
      var outputSettingsArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsSetOutputModuleSettings(adobepyAfterEffectsRequireRenderQueue(app.project), outputSettingsArgs[0], outputSettingsArgs[1], outputSettingsArgs[2] || {}));
    }
    if (request.namespace === "outputModule" && request.method === "setOutputPath") {
      var outputPathArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsSetOutputModulePath(adobepyAfterEffectsRequireRenderQueue(app.project), outputPathArgs[0], outputPathArgs[1], String(outputPathArgs[2] || "")));
    }
    if (request.namespace === "outputModule" && request.method === "saveAsTemplate") {
      var outputSaveArgs = request.args || [];
      return adobepyResult(request.id, adobepyAfterEffectsSaveOutputModuleTemplate(adobepyAfterEffectsRequireRenderQueue(app.project), outputSaveArgs[0], outputSaveArgs[1], String(outputSaveArgs[2] || "")));
    }
    if (request.namespace === "raw" && request.method === "evalExtendScript") {
      return adobepyResult(request.id, eval((request.args || [])[0]));
    }
    return adobepyError(request.id, -32601, "unsupported method " + request.namespace + "." + request.method);
  } catch (error) {
    return adobepyError(request.id, -32004, error && error.message ? error.message : String(error), {
      line: error && error.line,
      source: error && error.source
    });
  }
}

function adobepyAfterEffectsProject(project) {
  if (!project) return null;
  var file = project.file || null;
  return {
    name: file ? String(file.name || "") : "Untitled Project",
    path: file ? String(file.fsName || file.fullName || "") : null,
    itemCount: Number(project.numItems || 0)
  };
}

function adobepyAfterEffectsImportFile(project, options) {
  if (!project) throw new Error("After Effects project unavailable");
  var path = String(options.path || "");
  if (!path) throw new Error("After Effects import path required");
  var importOptions = new ImportOptions(new File(path));
  if (typeof options.sequence !== "undefined") importOptions.sequence = Boolean(options.sequence);
  if (typeof options.forceAlphabetical !== "undefined") importOptions.forceAlphabetical = Boolean(options.forceAlphabetical);
  return adobepyAfterEffectsItem(project.importFile(importOptions), project);
}

function adobepyAfterEffectsCreateComposition(project, options) {
  if (!project || !project.items) throw new Error("After Effects project unavailable");
  var name = String(options.name || "Composition");
  var comp = project.items.addComp(
    name,
    Number(options.width || 1920),
    Number(options.height || 1080),
    Number(options.pixelAspect || 1),
    Number(options.duration || 10),
    Number(options.frameRate || 30)
  );
  return adobepyAfterEffectsItem(comp, project);
}

function adobepyAfterEffectsCreateTextLayer(project, compKey, options) {
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var layer = comp.layers.addText(String(options.text || ""));
  if (options.name) layer.name = String(options.name);
  return adobepyAfterEffectsLayer(layer, comp);
}

function adobepyAfterEffectsCreateSolidLayer(project, compKey, options) {
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var color = options.color || [0, 0, 0];
  var layer = comp.layers.addSolid(
    color,
    String(options.name || "Solid"),
    Number(options.width || comp.width),
    Number(options.height || comp.height),
    Number(options.pixelAspect || 1),
    Number(options.duration || comp.duration)
  );
  return adobepyAfterEffectsLayer(layer, comp);
}

function adobepyAfterEffectsCreateFootageLayer(project, compKey, options) {
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var item = adobepyAfterEffectsFindItemById(project, options.item);
  if (!item) throw new Error("After Effects footage item unavailable");
  var layer = typeof options.duration === "number" ? comp.layers.add(item, options.duration) : comp.layers.add(item);
  return adobepyAfterEffectsLayer(layer, comp);
}

function adobepyAfterEffectsSetTransform(project, compKey, layerKey, values) {
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var layer = adobepyAfterEffectsRequireLayer(comp, layerKey);
  for (var name in values) {
    if (values.hasOwnProperty(name)) adobepyAfterEffectsTransformProperty(layer, name).setValue(values[name]);
  }
  return adobepyAfterEffectsLayer(layer, comp);
}

function adobepyAfterEffectsSetKeyframes(project, compKey, layerKey, options) {
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var layer = adobepyAfterEffectsRequireLayer(comp, layerKey);
  var property = adobepyAfterEffectsTransformProperty(layer, String(options.property || ""));
  var keyframes = options.keyframes || [];
  for (var index = 0; index < keyframes.length; index += 1) {
    property.setValueAtTime(Number(keyframes[index].time), keyframes[index].value);
  }
  return adobepyAfterEffectsLayer(layer, comp);
}

function adobepyAfterEffectsTransformProperty(layer, name) {
  var names = {
    anchor_point: "ADBE Anchor Point",
    position: "ADBE Position",
    scale: "ADBE Scale",
    rotation: "ADBE Rotate Z",
    opacity: "ADBE Opacity"
  };
  var matchName = names[name] || name;
  var transform = layer.property("ADBE Transform Group");
  var property = transform && transform.property(matchName);
  if (!property) throw new Error("After Effects transform property unavailable: " + name);
  return property;
}

function adobepyAfterEffectsItems(project) {
  var result = [];
  if (!project) return result;
  for (var index = 1; index <= Number(project.numItems || 0); index += 1) {
    var item = project.item(index);
    var serialized = adobepyAfterEffectsItem(item, project, index);
    if (serialized) result.push(serialized);
  }
  return result;
}

function adobepyAfterEffectsItemsByType(project, itemType) {
  var items = adobepyAfterEffectsItems(project);
  var result = [];
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].itemType === itemType) result.push(items[index]);
  }
  return result;
}

function adobepyAfterEffectsSelectedItems(project) {
  var items = adobepyAfterEffectsItems(project);
  var result = [];
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].selected === true) result.push(items[index]);
  }
  return result;
}

function adobepyAfterEffectsItemsByName(project, name) {
  var items = adobepyAfterEffectsItems(project);
  var result = [];
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].name === name) result.push(items[index]);
  }
  return result;
}

function adobepyAfterEffectsFindItemById(project, id) {
  if (!project) return null;
  for (var index = 1; index <= Number(project.numItems || 0); index += 1) {
    var item = project.item(index);
    if (String(adobepySafeValue(item, "id")) === String(id)) return item;
  }
  return null;
}

function adobepyAfterEffectsItem(item, project, index) {
  if (!item) return null;
  var parent = adobepySafeValue(item, "parentFolder");
  var source = adobepySafeValue(item, "mainSource");
  var sourceFile = source ? adobepySafeValue(source, "file") : null;
  var file = adobepySafeValue(item, "file") || sourceFile;
  var itemType = adobepyAfterEffectsItemType(item);
  var missingFootage = adobepySafeValue(item, "footageMissing");
  if (typeof missingFootage === "undefined") missingFootage = adobepySafeValue(source, "missingFootage");
  return {
    id: adobepySafeValue(item, "id"),
    index: typeof index === "number" ? index : adobepyAfterEffectsItemIndex(project, item),
    name: String(adobepySafeValue(item, "name") || ""),
    typeName: String(adobepySafeValue(item, "typeName") || ""),
    itemType: itemType,
    parentFolderId: parent ? adobepySafeValue(parent, "id") : null,
    parentFolderName: parent ? String(adobepySafeValue(parent, "name") || "") : null,
    selected: Boolean(adobepySafeValue(item, "selected")),
    isActive: Boolean(project && project.activeItem === item),
    width: adobepyNumberOrNull(adobepySafeValue(item, "width")),
    height: adobepyNumberOrNull(adobepySafeValue(item, "height")),
    duration: adobepyNumberOrNull(adobepySafeValue(item, "duration")),
    frameRate: adobepyNumberOrNull(adobepySafeValue(item, "frameRate")),
    hasVideo: adobepyBooleanOrNull(adobepySafeValue(item, "hasVideo")),
    hasAudio: adobepyBooleanOrNull(adobepySafeValue(item, "hasAudio")),
    filePath: file ? String(adobepySafeValue(file, "fsName") || adobepySafeValue(file, "fullName") || "") : null,
    missingFootage: adobepyBooleanOrNull(missingFootage),
    itemCount: adobepyNumberOrNull(adobepySafeValue(item, "numItems")),
    numLayers: adobepyNumberOrNull(adobepySafeValue(item, "numLayers")),
    workAreaStart: adobepyNumberOrNull(adobepySafeValue(item, "workAreaStart")),
    workAreaDuration: adobepyNumberOrNull(adobepySafeValue(item, "workAreaDuration")),
    typename: itemType === "composition" ? "CompItem" : itemType === "footage" ? "FootageItem" : itemType === "folder" ? "FolderItem" : "Item"
  };
}

function adobepyAfterEffectsItemType(item) {
  var typeName = String(adobepySafeValue(item, "typeName") || "").toLowerCase();
  if (typeName.indexOf("composition") >= 0 || typeof adobepySafeValue(item, "numLayers") !== "undefined") return "composition";
  if (typeName.indexOf("footage") >= 0 || adobepySafeValue(item, "mainSource")) return "footage";
  if (typeName.indexOf("folder") >= 0 || typeof adobepySafeValue(item, "numItems") !== "undefined") return "folder";
  return typeName || "item";
}

function adobepyAfterEffectsItemIndex(project, item) {
  if (!project || !item) return null;
  for (var index = 1; index <= Number(project.numItems || 0); index += 1) {
    if (project.item(index) === item) return index;
  }
  return null;
}

function adobepyAfterEffectsRequireComp(project, idOrName) {
  var comp = adobepyAfterEffectsFindItemById(project, idOrName);
  if (!comp) {
    var byName = adobepyAfterEffectsItemsByName(project, String(idOrName || ""));
    if (byName.length > 0) comp = adobepyAfterEffectsFindItemById(project, byName[0].id);
  }
  if (!comp || adobepyAfterEffectsItemType(comp) !== "composition") throw new Error("After Effects composition unavailable");
  return comp;
}

function adobepyAfterEffectsLayers(comp) {
  var result = [];
  var count = Number(adobepySafeValue(comp, "numLayers") || 0);
  for (var index = 1; index <= count; index += 1) {
    result.push(adobepyAfterEffectsLayer(comp.layer(index), comp));
  }
  return result;
}

function adobepyAfterEffectsSelectedLayers(comp) {
  var selected = adobepySafeValue(comp, "selectedLayers") || [];
  var result = [];
  for (var index = 0; index < selected.length; index += 1) {
    result.push(adobepyAfterEffectsLayer(selected[index], comp));
  }
  return result;
}

function adobepyAfterEffectsFindLayer(comp, idOrName) {
  if (!comp) return null;
  var count = Number(adobepySafeValue(comp, "numLayers") || 0);
  for (var index = 1; index <= count; index += 1) {
    var layer = comp.layer(index);
    var values = [adobepySafeValue(layer, "id"), adobepySafeValue(layer, "index"), adobepySafeValue(layer, "name"), index];
    for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (String(values[valueIndex]) === String(idOrName)) return layer;
    }
  }
  return null;
}

function adobepyAfterEffectsRequireLayer(comp, idOrName) {
  var layer = adobepyAfterEffectsFindLayer(comp, idOrName);
  if (!layer) throw new Error("After Effects layer unavailable");
  return layer;
}

function adobepyAfterEffectsLayer(layer, comp) {
  if (!layer) return null;
  var source = adobepySafeValue(layer, "source");
  var layerType = adobepyAfterEffectsLayerType(layer);
  return {
    id: adobepySafeValue(layer, "id"),
    index: adobepyNumberOrNull(adobepySafeValue(layer, "index")),
    name: String(adobepySafeValue(layer, "name") || ""),
    typeName: String(adobepySafeValue(layer, "typeName") || ""),
    layerType: layerType,
    compId: adobepySafeValue(comp, "id"),
    sourceId: source ? adobepySafeValue(source, "id") : null,
    sourceName: source ? String(adobepySafeValue(source, "name") || "") : null,
    selected: adobepyBooleanOrNull(adobepySafeValue(layer, "selected")),
    enabled: adobepyBooleanOrNull(adobepySafeValue(layer, "enabled")),
    solo: adobepyBooleanOrNull(adobepySafeValue(layer, "solo")),
    locked: adobepyBooleanOrNull(adobepySafeValue(layer, "locked")),
    shy: adobepyBooleanOrNull(adobepySafeValue(layer, "shy")),
    isText: layerType === "text",
    startTime: adobepyNumberOrNull(adobepySafeValue(layer, "startTime")),
    inPoint: adobepyNumberOrNull(adobepySafeValue(layer, "inPoint")),
    outPoint: adobepyNumberOrNull(adobepySafeValue(layer, "outPoint")),
    stretch: adobepyNumberOrNull(adobepySafeValue(layer, "stretch")),
    width: adobepyNumberOrNull(adobepySafeValue(layer, "width")),
    height: adobepyNumberOrNull(adobepySafeValue(layer, "height")),
    hasVideo: adobepyBooleanOrNull(adobepySafeValue(layer, "hasVideo")),
    hasAudio: adobepyBooleanOrNull(adobepySafeValue(layer, "hasAudio")),
    typename: layerType === "text" ? "TextLayer" : "Layer"
  };
}

function adobepyAfterEffectsLayerType(layer) {
  var typeName = String(adobepySafeValue(layer, "typeName") || "").toLowerCase();
  if (typeName.indexOf("text") >= 0 || adobepyAfterEffectsTextProperty(layer)) return "text";
  if (typeName.indexOf("camera") >= 0) return "camera";
  if (typeName.indexOf("light") >= 0) return "light";
  return typeName || "av";
}

function adobepyAfterEffectsMasks(layer) {
  var group = adobepyPropertyGroup(layer, "ADBE Mask Parade");
  var result = [];
  var count = Number(adobepySafeValue(group, "numProperties") || 0);
  for (var index = 1; index <= count; index += 1) {
    result.push(adobepyAfterEffectsMask(group.property(index), index));
  }
  return result;
}

function adobepyAfterEffectsMask(mask, index) {
  if (!mask) return null;
  return {
    id: adobepySafeValue(mask, "id"),
    index: index,
    name: String(adobepySafeValue(mask, "name") || ""),
    maskMode: String(adobepySafeValue(mask, "maskMode") || ""),
    inverted: adobepyBooleanOrNull(adobepySafeValue(mask, "inverted")),
    locked: adobepyBooleanOrNull(adobepySafeValue(mask, "locked")),
    rotoBezier: adobepyBooleanOrNull(adobepySafeValue(mask, "rotoBezier")),
    opacity: adobepyPropertyValue(mask, "ADBE Mask Opacity"),
    feather: adobepyPropertyValue(mask, "ADBE Mask Feather"),
    expansion: adobepyPropertyValue(mask, "ADBE Mask Expansion"),
    typename: "MaskPropertyGroup"
  };
}

function adobepyAfterEffectsEffects(layer) {
  var group = adobepyPropertyGroup(layer, "ADBE Effect Parade");
  var result = [];
  var count = Number(adobepySafeValue(group, "numProperties") || 0);
  for (var index = 1; index <= count; index += 1) {
    result.push(adobepyAfterEffectsEffect(group.property(index), index));
  }
  return result;
}

function adobepyAfterEffectsEffectByName(layer, name) {
  var effects = adobepyAfterEffectsEffects(layer);
  for (var index = 0; index < effects.length; index += 1) {
    if (effects[index].name === name || effects[index].matchName === name) return effects[index];
  }
  return null;
}

function adobepyAfterEffectsEffect(effect, index) {
  if (!effect) return null;
  return {
    id: adobepySafeValue(effect, "id"),
    index: index,
    name: String(adobepySafeValue(effect, "name") || ""),
    matchName: String(adobepySafeValue(effect, "matchName") || ""),
    enabled: adobepyBooleanOrNull(adobepySafeValue(effect, "enabled")),
    active: adobepyBooleanOrNull(adobepySafeValue(effect, "active")),
    selected: adobepyBooleanOrNull(adobepySafeValue(effect, "selected")),
    propertyCount: adobepyNumberOrNull(adobepySafeValue(effect, "numProperties")),
    typename: "EffectPropertyGroup"
  };
}

function adobepyAfterEffectsSourceText(layer) {
  var property = adobepyAfterEffectsTextProperty(layer);
  if (!property) return null;
  return adobepyAfterEffectsTextDocument(adobepySafeValue(property, "value"));
}

function adobepyAfterEffectsSetSourceText(layer, payload) {
  var property = adobepyAfterEffectsTextProperty(layer);
  if (!property || typeof property.setValue !== "function") throw new Error("After Effects text source unavailable");
  var current = adobepySafeValue(property, "value") || {};
  var text = String(adobepySafeValue(payload, "text") || "");
  var doc = typeof TextDocument === "function" ? new TextDocument(text) : {};
  doc.text = text;
  adobepyCopyTextDocumentField(doc, current, "font");
  adobepyCopyTextDocumentField(doc, current, "fontSize");
  adobepyCopyTextDocumentField(doc, current, "fillColor");
  adobepyCopyTextDocumentField(doc, current, "strokeColor");
  adobepyCopyTextDocumentField(doc, current, "tracking");
  adobepyCopyTextDocumentField(doc, current, "justification");
  adobepyAssignTextDocumentField(doc, payload, "font");
  adobepyAssignTextDocumentField(doc, payload, "fontSize");
  adobepyAssignTextDocumentField(doc, payload, "fillColor");
  adobepyAssignTextDocumentField(doc, payload, "strokeColor");
  adobepyAssignTextDocumentField(doc, payload, "tracking");
  adobepyAssignTextDocumentField(doc, payload, "justification");
  property.setValue(doc);
  return adobepyAfterEffectsTextDocument(adobepySafeValue(property, "value"));
}

function adobepyAfterEffectsTextProperty(layer) {
  var textGroup = adobepyPropertyGroup(layer, "ADBE Text Properties");
  var sourceText = adobepyPropertyGroup(textGroup, "ADBE Text Document");
  if (sourceText) return sourceText;
  var text = adobepySafeValue(layer, "text");
  return text ? adobepySafeValue(text, "sourceText") : null;
}

function adobepyAfterEffectsTextDocument(doc) {
  if (!doc) return null;
  return {
    text: String(adobepySafeValue(doc, "text") || ""),
    font: adobepyStringOrNull(adobepySafeValue(doc, "font")),
    fontSize: adobepyNumberOrNull(adobepySafeValue(doc, "fontSize")),
    fillColor: adobepySafeValue(doc, "fillColor"),
    strokeColor: adobepySafeValue(doc, "strokeColor"),
    tracking: adobepySafeValue(doc, "tracking"),
    justification: adobepyStringOrNull(adobepySafeValue(doc, "justification")),
    typename: "TextDocument"
  };
}

function adobepyAfterEffectsRequireRenderQueue(project) {
  var queue = project ? adobepySafeValue(project, "renderQueue") : null;
  if (!queue) throw new Error("After Effects render queue unavailable");
  return queue;
}

function adobepyAfterEffectsRenderQueue(queue) {
  if (!queue) return null;
  return {
    numItems: adobepyNumberOrNull(adobepySafeValue(queue, "numItems")) || adobepyAfterEffectsRenderQueueItems(queue).length,
    canQueueInAME: adobepyBooleanOrNull(adobepySafeValue(queue, "canQueueInAME")),
    queueNotify: adobepyBooleanOrNull(adobepySafeValue(queue, "queueNotify")),
    rendering: adobepyBooleanOrNull(adobepySafeValue(queue, "rendering")),
    typename: "RenderQueue"
  };
}

function adobepyAfterEffectsRenderQueueItems(queue) {
  var result = [];
  var count = Number(adobepySafeValue(queue, "numItems") || 0);
  for (var index = 1; index <= count; index += 1) {
    var item = adobepyAfterEffectsFindRenderQueueItem(queue, index);
    if (item) result.push(adobepyAfterEffectsRenderQueueItem(item, index));
  }
  return result;
}

function adobepyAfterEffectsFindRenderQueueItem(queue, idOrIndex) {
  if (!queue) return null;
  var directIndex = Number(idOrIndex);
  if (!isNaN(directIndex)) {
    if (typeof queue.item === "function") return queue.item(directIndex);
    var directItems = adobepySafeValue(queue, "items");
    if (directItems && typeof directItems.item === "function") return directItems.item(directIndex);
    if (directItems && directItems[directIndex - 1]) return directItems[directIndex - 1];
  }
  var count = Number(adobepySafeValue(queue, "numItems") || 0);
  for (var index = 1; index <= count; index += 1) {
    var item = adobepyAfterEffectsFindRenderQueueItem(queue, index);
    var comp = adobepySafeValue(item, "comp");
    var values = [adobepySafeValue(item, "id"), adobepySafeValue(item, "index"), comp ? adobepySafeValue(comp, "id") : null, comp ? adobepySafeValue(comp, "name") : null];
    for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (String(values[valueIndex]) === String(idOrIndex)) return item;
    }
  }
  return null;
}

function adobepyAfterEffectsRequireRenderQueueItem(queue, idOrIndex) {
  var item = adobepyAfterEffectsFindRenderQueueItem(queue, idOrIndex);
  if (!item) throw new Error("After Effects render queue item unavailable");
  return item;
}

function adobepyAfterEffectsRenderQueueItem(item, index) {
  if (!item) return null;
  var comp = adobepySafeValue(item, "comp");
  return {
    id: adobepySafeValue(item, "id") || index,
    index: adobepyNumberOrNull(adobepySafeValue(item, "index")) || adobepyNumberOrNull(index),
    compId: comp ? adobepySafeValue(comp, "id") : null,
    compName: comp ? String(adobepySafeValue(comp, "name") || "") : null,
    status: adobepyStringOrNull(adobepySafeValue(item, "status")),
    elapsedSeconds: adobepyNumberOrNull(adobepySafeValue(item, "elapsedSeconds")),
    render: adobepyBooleanOrNull(adobepySafeValue(item, "render")),
    skipFrames: adobepyNumberOrNull(adobepySafeValue(item, "skipFrames")),
    queueItemNotify: adobepyBooleanOrNull(adobepySafeValue(item, "queueItemNotify")),
    timeSpanStart: adobepyNumberOrNull(adobepySafeValue(item, "timeSpanStart")),
    timeSpanDuration: adobepyNumberOrNull(adobepySafeValue(item, "timeSpanDuration")),
    numOutputModules: adobepyAfterEffectsOutputModuleCount(item),
    templates: adobepyArrayOfStrings(adobepySafeValue(item, "templates")),
    settings: adobepyAfterEffectsGetSettings(item, "STRING"),
    typename: "RenderQueueItem"
  };
}

function adobepyAfterEffectsAddCompositionToRenderQueue(project, payload) {
  var queue = adobepyAfterEffectsRequireRenderQueue(project);
  var compKey = adobepySafeValue(payload, "comp") || adobepySafeValue(payload, "compId") || adobepySafeValue(payload, "compName") || adobepySafeValue(payload, "id") || payload;
  var comp = adobepyAfterEffectsRequireComp(project, compKey);
  var items = adobepySafeValue(queue, "items");
  if (!items || typeof items.add !== "function") throw new Error("After Effects render queue items.add unavailable");
  var item = items.add(comp);
  adobepyAfterEffectsConfigureRenderQueueItem(item, payload);
  return adobepyAfterEffectsRenderQueueItem(item, adobepyAfterEffectsRenderQueueItemIndex(queue, item));
}

function adobepyAfterEffectsQueueSelectedCompositions(project, payload) {
  var queue = adobepyAfterEffectsRequireRenderQueue(project);
  var items = adobepySafeValue(queue, "items");
  if (!items || typeof items.add !== "function") throw new Error("After Effects render queue items.add unavailable");
  var result = [];
  if (!project) return result;
  for (var index = 1; index <= Number(project.numItems || 0); index += 1) {
    var item = project.item(index);
    if (adobepyAfterEffectsItemType(item) === "composition" && Boolean(adobepySafeValue(item, "selected"))) {
      var queued = items.add(item);
      adobepyAfterEffectsConfigureRenderQueueItem(queued, payload);
      result.push(adobepyAfterEffectsRenderQueueItem(queued, adobepyAfterEffectsRenderQueueItemIndex(queue, queued)));
    }
  }
  return result;
}

function adobepyAfterEffectsConfigureRenderQueueItem(item, payload) {
  if (!item || !payload) return;
  var renderTemplate = adobepySafeValue(payload, "renderSettingsTemplate") || adobepySafeValue(payload, "render_settings_template");
  if (renderTemplate && typeof item.applyTemplate === "function") item.applyTemplate(String(renderTemplate));
  var settings = adobepySafeValue(payload, "settings");
  if (settings && typeof item.setSettings === "function") item.setSettings(settings);
  var outputModuleTemplate = adobepySafeValue(payload, "outputModuleTemplate") || adobepySafeValue(payload, "output_module_template");
  var outputPath = adobepySafeValue(payload, "outputPath") || adobepySafeValue(payload, "output_path");
  var outputDirectory = adobepySafeValue(payload, "outputDirectory") || adobepySafeValue(payload, "output_directory");
  var outputModule = adobepyAfterEffectsFindOutputModule(item, 1);
  if (outputModuleTemplate && outputModule && typeof outputModule.applyTemplate === "function") outputModule.applyTemplate(String(outputModuleTemplate));
  if (outputPath && outputModule) adobepyAfterEffectsAssignOutputModulePath(outputModule, String(outputPath));
  if (!outputPath && outputDirectory && outputModule) adobepyAfterEffectsAssignOutputModuleDirectory(outputModule, String(outputDirectory));
}

function adobepyAfterEffectsRenderQueueItemIndex(queue, item) {
  var count = Number(adobepySafeValue(queue, "numItems") || 0);
  for (var index = 1; index <= count; index += 1) {
    if (adobepyAfterEffectsFindRenderQueueItem(queue, index) === item) return index;
  }
  return null;
}

function adobepyAfterEffectsApplyRenderQueueItemTemplate(queue, itemKey, templateName) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  if (!templateName || typeof item.applyTemplate !== "function") throw new Error("After Effects RenderQueueItem.applyTemplate unavailable");
  item.applyTemplate(templateName);
  return adobepyAfterEffectsRenderQueueItem(item, itemKey);
}

function adobepyAfterEffectsSetRenderQueueItemSettings(queue, itemKey, settings) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  if (typeof item.setSettings !== "function") throw new Error("After Effects RenderQueueItem.setSettings unavailable");
  item.setSettings(settings || {});
  return adobepyAfterEffectsRenderQueueItem(item, itemKey);
}

function adobepyAfterEffectsOutputModules(item) {
  var result = [];
  var count = adobepyAfterEffectsOutputModuleCount(item);
  for (var index = 1; index <= count; index += 1) {
    var outputModule = adobepyAfterEffectsFindOutputModule(item, index);
    if (outputModule) result.push(adobepyAfterEffectsOutputModule(outputModule, item, adobepySafeValue(item, "index") || null, index));
  }
  return result;
}

function adobepyAfterEffectsOutputModuleCount(item) {
  var direct = adobepyNumberOrNull(adobepySafeValue(item, "numOutputModules"));
  if (direct !== null) return direct;
  return adobepyCollectionLength(adobepySafeValue(item, "outputModules"));
}

function adobepyAfterEffectsFindOutputModule(item, index) {
  if (!item) return null;
  var number = Number(index || 1);
  if (typeof item.outputModule === "function") return item.outputModule(number);
  var modules = adobepySafeValue(item, "outputModules");
  if (modules && typeof modules.item === "function") return modules.item(number);
  if (modules && modules[number - 1]) return modules[number - 1];
  return null;
}

function adobepyAfterEffectsRequireOutputModule(item, index) {
  var outputModule = adobepyAfterEffectsFindOutputModule(item, index);
  if (!outputModule) throw new Error("After Effects output module unavailable");
  return outputModule;
}

function adobepyAfterEffectsOutputModule(outputModule, item, itemIndex, index) {
  if (!outputModule) return null;
  var file = adobepySafeValue(outputModule, "file");
  var filePath = file ? String(adobepySafeValue(file, "fsName") || adobepySafeValue(file, "fullName") || "") : null;
  return {
    itemIndex: adobepyNumberOrNull(itemIndex) || adobepyNumberOrNull(adobepySafeValue(item, "index")),
    index: adobepyNumberOrNull(index),
    name: String(adobepySafeValue(outputModule, "name") || ""),
    filePath: filePath,
    outputPath: filePath,
    includeSourceXMP: adobepyBooleanOrNull(adobepySafeValue(outputModule, "includeSourceXMP")),
    postRenderAction: adobepyStringOrNull(adobepySafeValue(outputModule, "postRenderAction")),
    templates: adobepyArrayOfStrings(adobepySafeValue(outputModule, "templates")),
    settings: adobepyAfterEffectsGetSettings(outputModule, "STRING"),
    typename: "OutputModule"
  };
}

function adobepyAfterEffectsApplyOutputModuleTemplate(queue, itemKey, outputModuleIndex, templateName) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  var outputModule = adobepyAfterEffectsRequireOutputModule(item, outputModuleIndex);
  if (!templateName || typeof outputModule.applyTemplate !== "function") throw new Error("After Effects OutputModule.applyTemplate unavailable");
  outputModule.applyTemplate(templateName);
  return adobepyAfterEffectsOutputModule(adobepyAfterEffectsFindOutputModule(item, outputModuleIndex), item, itemKey, outputModuleIndex);
}

function adobepyAfterEffectsSetOutputModuleSettings(queue, itemKey, outputModuleIndex, settings) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  var outputModule = adobepyAfterEffectsRequireOutputModule(item, outputModuleIndex);
  if (typeof outputModule.setSettings !== "function") throw new Error("After Effects OutputModule.setSettings unavailable");
  outputModule.setSettings(settings || {});
  return adobepyAfterEffectsOutputModule(adobepyAfterEffectsFindOutputModule(item, outputModuleIndex), item, itemKey, outputModuleIndex);
}

function adobepyAfterEffectsSetOutputModulePath(queue, itemKey, outputModuleIndex, path) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  var outputModule = adobepyAfterEffectsRequireOutputModule(item, outputModuleIndex);
  adobepyAfterEffectsAssignOutputModulePath(outputModule, path);
  return adobepyAfterEffectsOutputModule(adobepyAfterEffectsFindOutputModule(item, outputModuleIndex), item, itemKey, outputModuleIndex);
}

function adobepyAfterEffectsSaveOutputModuleTemplate(queue, itemKey, outputModuleIndex, templateName) {
  var item = adobepyAfterEffectsRequireRenderQueueItem(queue, itemKey);
  var outputModule = adobepyAfterEffectsRequireOutputModule(item, outputModuleIndex);
  if (!templateName || typeof outputModule.saveAsTemplate !== "function") throw new Error("After Effects OutputModule.saveAsTemplate unavailable");
  outputModule.saveAsTemplate(templateName);
  return adobepyAfterEffectsOutputModule(adobepyAfterEffectsFindOutputModule(item, outputModuleIndex), item, itemKey, outputModuleIndex);
}

function adobepyAfterEffectsAssignOutputModulePath(outputModule, path) {
  if (!path) return;
  if (typeof File === "function") {
    outputModule.file = new File(path);
  } else {
    outputModule.file = { fsName: path, fullName: path, name: adobepyBasename(path) };
  }
}

function adobepyAfterEffectsAssignOutputModuleDirectory(outputModule, directory) {
  var file = adobepySafeValue(outputModule, "file");
  var name = file ? String(adobepySafeValue(file, "name") || adobepyBasename(String(adobepySafeValue(file, "fsName") || ""))) : "";
  if (!name) return;
  var separator = directory.indexOf("\\") >= 0 ? "\\" : "/";
  var path = directory.replace(/[\\\/]$/, "") + separator + name;
  adobepyAfterEffectsAssignOutputModulePath(outputModule, path);
}

function adobepyAfterEffectsGetSettings(object, formatName) {
  if (!object || typeof object.getSettings !== "function") return null;
  try {
    return object.getSettings(adobepyAfterEffectsSettingsFormat(formatName));
  } catch (error) {
    try {
      return object.getSettings();
    } catch (ignored) {
      return null;
    }
  }
}

function adobepyAfterEffectsSettingsFormat(formatName) {
  var name = String(formatName || "STRING");
  if (typeof GetSettingsFormat !== "undefined" && typeof GetSettingsFormat[name] !== "undefined") return GetSettingsFormat[name];
  return name;
}

function adobepyPropertyGroup(object, name) {
  if (!object || typeof object.property !== "function") return null;
  try {
    return object.property(name);
  } catch (error) {
    return null;
  }
}

function adobepyPropertyValue(group, name) {
  var property = adobepyPropertyGroup(group, name);
  if (!property) return null;
  return adobepySafeValue(property, "value");
}

function adobepyCopyTextDocumentField(target, source, key) {
  if (typeof adobepySafeValue(source, key) !== "undefined") target[key] = adobepySafeValue(source, key);
}

function adobepyAssignTextDocumentField(target, source, key) {
  if (typeof adobepySafeValue(source, key) !== "undefined") target[key] = adobepySafeValue(source, key);
}

function adobepySafeValue(object, key) {
  try {
    return object ? object[key] : undefined;
  } catch (error) {
    return undefined;
  }
}

function adobepyNumberOrNull(value) {
  return typeof value === "undefined" || value === null || isNaN(Number(value)) ? null : Number(value);
}

function adobepyBooleanOrNull(value) {
  if (typeof value === "undefined" || value === null) return null;
  return Boolean(value);
}

function adobepyStringOrNull(value) {
  if (typeof value === "undefined" || value === null) return null;
  return String(value);
}

function adobepyArrayOfStrings(value) {
  if (!value) return [];
  var result = [];
  var length = adobepyCollectionLength(value);
  for (var index = 0; index < length; index += 1) {
    var item = value[index];
    if (typeof item === "undefined" && typeof value.item === "function") item = value.item(index + 1);
    if (typeof item !== "undefined" && item !== null) result.push(String(item));
  }
  return result;
}

function adobepyCollectionLength(value) {
  if (!value) return 0;
  var direct = adobepyNumberOrNull(adobepySafeValue(value, "length"));
  if (direct !== null) return direct;
  direct = adobepyNumberOrNull(adobepySafeValue(value, "numItems"));
  if (direct !== null) return direct;
  direct = adobepyNumberOrNull(adobepySafeValue(value, "numProperties"));
  if (direct !== null) return direct;
  return 0;
}

function adobepyBasename(path) {
  var normalized = String(path || "").replace(/\\/g, "/");
  var parts = normalized.split("/");
  return parts.length ? parts[parts.length - 1] : normalized;
}

function adobepyResult(id, value) {
  return JSON.stringify({ jsonrpc: "2.0", id: id, result: typeof value === "undefined" ? null : value });
}

function adobepyError(id, code, message, data) {
  var response = { jsonrpc: "2.0", id: id, error: { code: code, message: message } };
  if (data) response.error.data = data;
  return JSON.stringify(response);
}
