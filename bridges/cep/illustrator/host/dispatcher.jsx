function adobepyDispatch(payload) {
  var request = JSON.parse(payload);
  try {
    if (request.namespace === "app" && request.method === "getVersion") {
      return adobepyResult(request.id, String(app.version || ""));
    }
    if (request.namespace === "document" && request.method === "getActive") {
      return adobepyResult(request.id, adobepyIllustratorDocument());
    }
    if (request.namespace === "artboard" && request.method === "getArtboards") {
      return adobepyResult(request.id, adobepyIllustratorArtboards(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "artboard" && request.method === "getActive") {
      return adobepyResult(request.id, adobepyIllustratorActiveArtboard(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "artboard" && request.method === "getActiveIndex") {
      return adobepyResult(request.id, adobepyIllustratorActiveArtboardIndex(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "layer" && request.method === "getLayers") {
      return adobepyResult(request.id, adobepyIllustratorLayers(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "layer" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorLayerByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "layer" && request.method === "getChildren") {
      return adobepyResult(request.id, adobepyIllustratorLayerChildren(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "pageItem" && request.method === "getPageItems") {
      return adobepyResult(request.id, adobepyIllustratorPageItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "pageItem" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyIllustratorSelectedPageItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "pageItem" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorPageItemByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "pageItem" && request.method === "getLayerItems") {
      return adobepyResult(request.id, adobepyIllustratorLayerPageItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "pathItem" && request.method === "getPathItems") {
      return adobepyResult(request.id, adobepyIllustratorPathItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "pathItem" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyIllustratorSelectedPathItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "pathItem" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorPathItemByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "pathItem" && request.method === "getLayerItems") {
      return adobepyResult(request.id, adobepyIllustratorLayerPathItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "compoundPath" && request.method === "getCompoundPathItems") {
      return adobepyResult(request.id, adobepyIllustratorCompoundPathItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "compoundPath" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyIllustratorSelectedCompoundPathItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "compoundPath" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorCompoundPathItemByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "compoundPath" && request.method === "getLayerItems") {
      return adobepyResult(request.id, adobepyIllustratorLayerCompoundPathItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "compoundPath" && request.method === "getPathItems") {
      return adobepyResult(request.id, adobepyIllustratorCompoundPathPathItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "placedItem" && request.method === "getPlacedItems") {
      return adobepyResult(request.id, adobepyIllustratorPlacedItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "placedItem" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyIllustratorSelectedPlacedItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "placedItem" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorPlacedItemByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "placedItem" && request.method === "getLayerItems") {
      return adobepyResult(request.id, adobepyIllustratorLayerPlacedItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
    }
    if (request.namespace === "rasterItem" && request.method === "getRasterItems") {
      return adobepyResult(request.id, adobepyIllustratorRasterItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "rasterItem" && request.method === "getSelected") {
      return adobepyResult(request.id, adobepyIllustratorSelectedRasterItems(adobepyIllustratorActiveDocument()));
    }
    if (request.namespace === "rasterItem" && request.method === "getByName") {
      return adobepyResult(request.id, adobepyIllustratorRasterItemByName(adobepyIllustratorActiveDocument(), String((request.args || [])[0] || "")));
    }
    if (request.namespace === "rasterItem" && request.method === "getLayerItems") {
      return adobepyResult(request.id, adobepyIllustratorLayerRasterItems(adobepyIllustratorActiveDocument(), (request.args || [])[0]));
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

function adobepyIllustratorDocument() {
  var document = adobepyIllustratorActiveDocument();
  if (!document) return null;
  var path = null;
  try {
    path = document.fullName ? String(document.fullName.fsName || document.fullName) : null;
  } catch (_) {
    path = null;
  }
  return {
    name: String(document.name || ""),
    path: path,
    width: Number(document.width || 0),
    height: Number(document.height || 0),
    artboardCount: adobepyCollectionLength(document.artboards),
    layerCount: adobepyCollectionLength(document.layers),
    pageItemCount: adobepyCollectionLength(document.pageItems),
    pathItemCount: adobepyCollectionLength(document.pathItems),
    compoundPathItemCount: adobepyCollectionLength(document.compoundPathItems),
    placedItemCount: adobepyCollectionLength(document.placedItems),
    rasterItemCount: adobepyCollectionLength(document.rasterItems),
    selectionCount: adobepyIllustratorSelectedPageItems(document).length,
    typename: "Document"
  };
}

function adobepyIllustratorActiveDocument() {
  if (!app.documents || app.documents.length === 0) return null;
  return app.activeDocument;
}

function adobepyIllustratorArtboards(document) {
  var result = [];
  var artboards = document ? document.artboards : null;
  var count = adobepyCollectionLength(artboards);
  for (var index = 0; index < count; index += 1) {
    result.push(adobepyIllustratorArtboard(adobepyCollectionItem(artboards, index), index));
  }
  return result;
}

function adobepyIllustratorActiveArtboard(document) {
  if (!document) return null;
  var index = adobepyIllustratorActiveArtboardIndex(document);
  var artboards = document.artboards;
  return index === null ? null : adobepyIllustratorArtboard(adobepyCollectionItem(artboards, index), index);
}

function adobepyIllustratorActiveArtboardIndex(document) {
  if (!document || !document.artboards) return null;
  try {
    if (typeof document.artboards.getActiveArtboardIndex === "function") return Number(document.artboards.getActiveArtboardIndex());
  } catch (_) {
    return null;
  }
  return 0;
}

function adobepyIllustratorArtboard(artboard, index) {
  if (!artboard) return null;
  return {
    index: index,
    name: adobepyStringOrNull(adobepySafeValue(artboard, "name")),
    artboardRect: adobepyArrayValue(adobepySafeValue(artboard, "artboardRect")),
    rulerOrigin: adobepyArrayValue(adobepySafeValue(artboard, "rulerOrigin")),
    rulerPAR: adobepySafeValue(artboard, "rulerPAR"),
    showCenter: adobepyBooleanOrNull(adobepySafeValue(artboard, "showCenter")),
    showCrossHairs: adobepyBooleanOrNull(adobepySafeValue(artboard, "showCrossHairs")),
    showSafeAreas: adobepyBooleanOrNull(adobepySafeValue(artboard, "showSafeAreas")),
    typename: "Artboard"
  };
}

function adobepyIllustratorLayers(document) {
  return adobepyIllustratorLayerCollection(document ? document.layers : null, null);
}

function adobepyIllustratorLayerChildren(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorLayerCollection(layer ? layer.layers : null, layer);
}

function adobepyIllustratorLayerCollection(layers, parent) {
  var result = [];
  var count = adobepyCollectionLength(layers);
  for (var index = 0; index < count; index += 1) {
    result.push(adobepyIllustratorLayer(adobepyCollectionItem(layers, index), index, parent));
  }
  return result;
}

function adobepyIllustratorLayerByName(document, name) {
  return adobepyIllustratorLayer(adobepyIllustratorFindLayer(document, name), null, null);
}

function adobepyIllustratorFindLayer(document, key) {
  if (!document) return null;
  var queue = [];
  var topLayers = document.layers;
  var topCount = adobepyCollectionLength(topLayers);
  for (var index = 0; index < topCount; index += 1) queue.push(adobepyCollectionItem(topLayers, index));
  while (queue.length > 0) {
    var layer = queue.shift();
    if (!layer) continue;
    var values = [adobepySafeValue(layer, "id"), adobepySafeValue(layer, "name"), adobepySafeValue(layer, "zOrderPosition")];
    for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      if (String(values[valueIndex]) === String(key)) return layer;
    }
    var children = adobepySafeValue(layer, "layers");
    var childCount = adobepyCollectionLength(children);
    for (var childIndex = 0; childIndex < childCount; childIndex += 1) queue.push(adobepyCollectionItem(children, childIndex));
  }
  return null;
}

function adobepyIllustratorLayer(layer, index, parent) {
  if (!layer) return null;
  var actualParent = parent || adobepySafeValue(layer, "parent");
  return {
    id: adobepySafeValue(layer, "id") || adobepySafeValue(layer, "uuid") || adobepySafeValue(layer, "name") || index,
    index: typeof index === "number" ? index : adobepyNumberOrNull(adobepySafeValue(layer, "zOrderPosition")),
    name: adobepyStringOrNull(adobepySafeValue(layer, "name")),
    visible: adobepyBooleanOrNull(adobepySafeValue(layer, "visible")),
    locked: adobepyBooleanOrNull(adobepySafeValue(layer, "locked")),
    printable: adobepyBooleanOrNull(adobepySafeValue(layer, "printable")),
    preview: adobepyBooleanOrNull(adobepySafeValue(layer, "preview")),
    opacity: adobepyNumberOrNull(adobepySafeValue(layer, "opacity")),
    hasSelectedArtwork: adobepyBooleanOrNull(adobepySafeValue(layer, "hasSelectedArtwork")),
    parentName: actualParent ? adobepyStringOrNull(adobepySafeValue(actualParent, "name")) : null,
    parentTypename: actualParent ? adobepyStringOrNull(adobepySafeValue(actualParent, "typename")) : null,
    layerCount: adobepyCollectionLength(adobepySafeValue(layer, "layers")),
    pageItemCount: adobepyCollectionLength(adobepySafeValue(layer, "pageItems")),
    typename: "Layer"
  };
}

function adobepyIllustratorPageItems(document) {
  return adobepyIllustratorPageItemCollection(document ? document.pageItems : null);
}

function adobepyIllustratorSelectedPageItems(document) {
  return adobepyIllustratorPageItemCollection(document ? document.selection : null);
}

function adobepyIllustratorLayerPageItems(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorPageItemCollection(layer ? layer.pageItems : null);
}

function adobepyIllustratorPageItemByName(document, name) {
  var items = adobepyIllustratorPageItems(document);
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].name === name) return items[index];
  }
  return null;
}

function adobepyIllustratorPageItemCollection(items) {
  var result = [];
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (item) result.push(adobepyIllustratorPageItem(item, index));
  }
  return result;
}

function adobepyIllustratorPageItem(item, index) {
  if (!item) return null;
  var parent = adobepySafeValue(item, "parent");
  var layer = adobepySafeValue(item, "layer");
  return {
    id: adobepySafeValue(item, "uuid") || adobepySafeValue(item, "id") || adobepySafeValue(item, "name") || index,
    index: index,
    name: adobepyStringOrNull(adobepySafeValue(item, "name")),
    itemType: adobepyStringOrNull(adobepySafeValue(item, "typename")),
    hidden: adobepyBooleanOrNull(adobepySafeValue(item, "hidden")),
    locked: adobepyBooleanOrNull(adobepySafeValue(item, "locked")),
    selected: adobepyBooleanOrNull(adobepySafeValue(item, "selected")),
    editable: adobepyBooleanOrNull(adobepySafeValue(item, "editable")),
    sliced: adobepyBooleanOrNull(adobepySafeValue(item, "sliced")),
    position: adobepyArrayValue(adobepySafeValue(item, "position")),
    geometricBounds: adobepyArrayValue(adobepySafeValue(item, "geometricBounds")),
    visibleBounds: adobepyArrayValue(adobepySafeValue(item, "visibleBounds")),
    controlBounds: adobepyArrayValue(adobepySafeValue(item, "controlBounds")),
    width: adobepySafeValue(item, "width"),
    height: adobepySafeValue(item, "height"),
    opacity: adobepyNumberOrNull(adobepySafeValue(item, "opacity")),
    parentName: parent ? adobepyStringOrNull(adobepySafeValue(parent, "name")) : null,
    parentTypename: parent ? adobepyStringOrNull(adobepySafeValue(parent, "typename")) : null,
    layerName: layer ? adobepyStringOrNull(adobepySafeValue(layer, "name")) : null,
    note: adobepyStringOrNull(adobepySafeValue(item, "note")),
    url: adobepyStringOrNull(adobepySafeValue(item, "uRL") || adobepySafeValue(item, "url")),
    typename: adobepyStringOrNull(adobepySafeValue(item, "typename")) || "PageItem"
  };
}

function adobepyIllustratorPathItems(document) {
  return adobepyIllustratorPathItemCollection(document ? document.pathItems : null);
}

function adobepyIllustratorSelectedPathItems(document) {
  return adobepyIllustratorPathItemCollection(adobepyIllustratorFilteredSelection(document, ["PathItem"]));
}

function adobepyIllustratorLayerPathItems(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorPathItemCollection(layer ? layer.pathItems : null);
}

function adobepyIllustratorPathItemByName(document, name) {
  return adobepyIllustratorFindSerializedByName(adobepyIllustratorPathItems(document), name);
}

function adobepyIllustratorPathItemCollection(items) {
  var result = [];
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (item) result.push(adobepyIllustratorPathItem(item, index));
  }
  return result;
}

function adobepyIllustratorPathItem(item, index) {
  var payload = adobepyIllustratorPageItem(item, index);
  if (!payload) return null;
  payload.area = adobepyNumberOrNull(adobepySafeValue(item, "area"));
  payload.closed = adobepyBooleanOrNull(adobepySafeValue(item, "closed"));
  payload.clipping = adobepyBooleanOrNull(adobepySafeValue(item, "clipping"));
  payload.evenodd = adobepyBooleanOrNull(adobepySafeValue(item, "evenodd"));
  payload.filled = adobepyBooleanOrNull(adobepySafeValue(item, "filled"));
  payload.fillColor = adobepyIllustratorColor(adobepySafeValue(item, "fillColor"));
  payload.fillOverprint = adobepyBooleanOrNull(adobepySafeValue(item, "fillOverprint"));
  payload.stroked = adobepyBooleanOrNull(adobepySafeValue(item, "stroked"));
  payload.strokeColor = adobepyIllustratorColor(adobepySafeValue(item, "strokeColor"));
  payload.strokeWidth = adobepyNumberOrNull(adobepySafeValue(item, "strokeWidth"));
  payload.strokeCap = adobepySerializableValue(adobepySafeValue(item, "strokeCap"));
  payload.strokeJoin = adobepySerializableValue(adobepySafeValue(item, "strokeJoin"));
  payload.strokeDashes = adobepyArrayValue(adobepySafeValue(item, "strokeDashes"));
  payload.strokeDashOffset = adobepyNumberOrNull(adobepySafeValue(item, "strokeDashOffset"));
  payload.strokeMiterLimit = adobepyNumberOrNull(adobepySafeValue(item, "strokeMiterLimit"));
  payload.strokeOverprint = adobepyBooleanOrNull(adobepySafeValue(item, "strokeOverprint"));
  payload.guides = adobepyBooleanOrNull(adobepySafeValue(item, "guides"));
  payload.length = adobepyNumberOrNull(adobepySafeValue(item, "length"));
  payload.pathPointCount = adobepyCollectionLength(adobepySafeValue(item, "pathPoints"));
  payload.selectedPathPointCount = adobepyCollectionLength(adobepySafeValue(item, "selectedPathPoints"));
  payload.pixelAligned = adobepyBooleanOrNull(adobepySafeValue(item, "pixelAligned"));
  payload.polarity = adobepySerializableValue(adobepySafeValue(item, "polarity"));
  payload.typename = "PathItem";
  return payload;
}

function adobepyIllustratorCompoundPathItems(document) {
  return adobepyIllustratorCompoundPathItemCollection(document ? document.compoundPathItems : null);
}

function adobepyIllustratorSelectedCompoundPathItems(document) {
  return adobepyIllustratorCompoundPathItemCollection(adobepyIllustratorFilteredSelection(document, ["CompoundPathItem"]));
}

function adobepyIllustratorLayerCompoundPathItems(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorCompoundPathItemCollection(layer ? layer.compoundPathItems : null);
}

function adobepyIllustratorCompoundPathItemByName(document, name) {
  return adobepyIllustratorFindSerializedByName(adobepyIllustratorCompoundPathItems(document), name);
}

function adobepyIllustratorCompoundPathPathItems(document, compoundKey) {
  var item = adobepyIllustratorFindCompoundPathItem(document, compoundKey);
  return adobepyIllustratorPathItemCollection(item ? item.pathItems : null);
}

function adobepyIllustratorCompoundPathItemCollection(items) {
  var result = [];
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (item) result.push(adobepyIllustratorCompoundPathItem(item, index));
  }
  return result;
}

function adobepyIllustratorCompoundPathItem(item, index) {
  var payload = adobepyIllustratorPageItem(item, index);
  if (!payload) return null;
  payload.pathItemCount = adobepyCollectionLength(adobepySafeValue(item, "pathItems"));
  payload.typename = "CompoundPathItem";
  return payload;
}

function adobepyIllustratorFindCompoundPathItem(document, key) {
  var items = document ? document.compoundPathItems : null;
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (adobepyIllustratorMatchesItemKey(item, key, index)) return item;
  }
  return null;
}

function adobepyIllustratorPlacedItems(document) {
  return adobepyIllustratorPlacedItemCollection(document ? document.placedItems : null);
}

function adobepyIllustratorSelectedPlacedItems(document) {
  return adobepyIllustratorPlacedItemCollection(adobepyIllustratorFilteredSelection(document, ["PlacedItem"]));
}

function adobepyIllustratorLayerPlacedItems(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorPlacedItemCollection(layer ? layer.placedItems : null);
}

function adobepyIllustratorPlacedItemByName(document, name) {
  return adobepyIllustratorFindSerializedByName(adobepyIllustratorPlacedItems(document), name);
}

function adobepyIllustratorPlacedItemCollection(items) {
  var result = [];
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (item) result.push(adobepyIllustratorPlacedItem(item, index));
  }
  return result;
}

function adobepyIllustratorPlacedItem(item, index) {
  var payload = adobepyIllustratorPageItem(item, index);
  if (!payload) return null;
  var file = adobepyIllustratorFile(adobepySafeValue(item, "file"));
  payload.filePath = file.path;
  payload.fileName = file.name;
  payload.boundingBox = adobepyArrayValue(adobepySafeValue(item, "boundingBox"));
  payload.matrix = adobepyIllustratorMatrix(adobepySafeValue(item, "matrix"));
  payload.typename = "PlacedItem";
  return payload;
}

function adobepyIllustratorRasterItems(document) {
  return adobepyIllustratorRasterItemCollection(document ? document.rasterItems : null);
}

function adobepyIllustratorSelectedRasterItems(document) {
  return adobepyIllustratorRasterItemCollection(adobepyIllustratorFilteredSelection(document, ["RasterItem"]));
}

function adobepyIllustratorLayerRasterItems(document, layerKey) {
  var layer = adobepyIllustratorFindLayer(document, layerKey);
  return adobepyIllustratorRasterItemCollection(layer ? layer.rasterItems : null);
}

function adobepyIllustratorRasterItemByName(document, name) {
  return adobepyIllustratorFindSerializedByName(adobepyIllustratorRasterItems(document), name);
}

function adobepyIllustratorRasterItemCollection(items) {
  var result = [];
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    if (item) result.push(adobepyIllustratorRasterItem(item, index));
  }
  return result;
}

function adobepyIllustratorRasterItem(item, index) {
  var payload = adobepyIllustratorPageItem(item, index);
  if (!payload) return null;
  var file = adobepyIllustratorFile(adobepySafeValue(item, "file"));
  payload.filePath = file.path;
  payload.fileName = file.name;
  payload.boundingBox = adobepyArrayValue(adobepySafeValue(item, "boundingBox"));
  payload.matrix = adobepyIllustratorMatrix(adobepySafeValue(item, "matrix"));
  payload.embedded = adobepyBooleanOrNull(adobepySafeValue(item, "embedded"));
  payload.bitsPerChannel = adobepyNumberOrNull(adobepySafeValue(item, "bitsPerChannel"));
  payload.channels = adobepyNumberOrNull(adobepySafeValue(item, "channels"));
  payload.colorants = adobepyArrayValue(adobepySafeValue(item, "colorants"));
  payload.colorizedGrayscale = adobepyBooleanOrNull(adobepySafeValue(item, "colorizedGrayscale"));
  payload.imageColorSpace = adobepySerializableValue(adobepySafeValue(item, "imageColorSpace"));
  payload.overprint = adobepyBooleanOrNull(adobepySafeValue(item, "overprint"));
  payload.typename = "RasterItem";
  return payload;
}

function adobepyIllustratorFilteredSelection(document, typenames) {
  var result = [];
  var items = document ? document.selection : null;
  var count = adobepyCollectionLength(items);
  for (var index = 0; index < count; index += 1) {
    var item = adobepyCollectionItem(items, index);
    var typename = adobepyStringOrNull(adobepySafeValue(item, "typename"));
    for (var typeIndex = 0; typeIndex < typenames.length; typeIndex += 1) {
      if (typename === typenames[typeIndex]) result.push(item);
    }
  }
  return result;
}

function adobepyIllustratorFindSerializedByName(items, name) {
  for (var index = 0; index < items.length; index += 1) {
    if (items[index].name === name) return items[index];
  }
  return null;
}

function adobepyIllustratorMatchesItemKey(item, key, index) {
  if (!item) return false;
  var values = [adobepySafeValue(item, "uuid"), adobepySafeValue(item, "id"), adobepySafeValue(item, "name"), index];
  for (var valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
    if (String(values[valueIndex]) === String(key)) return true;
  }
  return false;
}

function adobepyCollectionLength(value) {
  if (!value) return 0;
  var length = adobepyNumberOrNull(adobepySafeValue(value, "length"));
  if (length !== null) return length;
  return 0;
}

function adobepyCollectionItem(value, index) {
  if (!value) return null;
  if (typeof value[index] !== "undefined") return value[index];
  if (typeof value.item === "function") {
    try {
      return value.item(index);
    } catch (_) {
      try {
        return value.item(index + 1);
      } catch (ignored) {
        return null;
      }
    }
  }
  return null;
}

function adobepySafeValue(object, key) {
  try {
    return object ? object[key] : undefined;
  } catch (_) {
    return undefined;
  }
}

function adobepyArrayValue(value) {
  if (!value) return null;
  var result = [];
  var length = adobepyNumberOrNull(adobepySafeValue(value, "length"));
  if (length === null) return value;
  for (var index = 0; index < length; index += 1) result.push(value[index]);
  return result;
}

function adobepySerializableValue(value) {
  if (typeof value === "undefined" || value === null) return null;
  if (typeof value !== "object") return value;
  var typename = adobepyStringOrNull(adobepySafeValue(value, "typename"));
  if (typename) return typename;
  try {
    return String(value);
  } catch (_) {
    return null;
  }
}

function adobepyIllustratorColor(value) {
  if (typeof value === "undefined" || value === null) return null;
  if (typeof value !== "object") return value;
  var output = {};
  var keys = ["typename", "red", "green", "blue", "cyan", "magenta", "yellow", "black", "gray", "tint", "spot", "pattern", "gradient"];
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    var item = adobepySafeValue(value, key);
    if (typeof item === "undefined" || typeof item === "function") continue;
    output[key] = adobepySerializableValue(item);
  }
  return output;
}

function adobepyIllustratorFile(file) {
  if (!file) return { path: null, name: null };
  return {
    path: adobepyStringOrNull(adobepySafeValue(file, "fsName") || adobepySafeValue(file, "fullName") || file),
    name: adobepyStringOrNull(adobepySafeValue(file, "displayName") || adobepySafeValue(file, "name"))
  };
}

function adobepyIllustratorMatrix(matrix) {
  if (!matrix) return null;
  var output = {};
  var keys = ["mValueA", "mValueB", "mValueC", "mValueD", "mValueTX", "mValueTY"];
  var hasValues = false;
  for (var index = 0; index < keys.length; index += 1) {
    var key = keys[index];
    var value = adobepySafeValue(matrix, key);
    if (typeof value === "undefined" || typeof value === "function") continue;
    output[key] = value;
    hasValues = true;
  }
  return hasValues ? output : adobepySerializableValue(matrix);
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
