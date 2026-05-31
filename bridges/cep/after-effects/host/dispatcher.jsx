function adobepyDispatch(payload) {
  var request = JSON.parse(payload);
  try {
    if (request.namespace === "app" && request.method === "getVersion") {
      return adobepyResult(request.id, String(app.version || ""));
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

function adobepyResult(id, value) {
  return JSON.stringify({ jsonrpc: "2.0", id: id, result: typeof value === "undefined" ? null : value });
}

function adobepyError(id, code, message, data) {
  var response = { jsonrpc: "2.0", id: id, error: { code: code, message: message } };
  if (data) response.error.data = data;
  return JSON.stringify(response);
}
