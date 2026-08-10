var adobepyDomGlobalObject = typeof $ !== "undefined" && $.global ? $.global : this;
var adobepyDomState = { nextReference: 1, values: {}, objects: [], references: [] };

function adobepyDomHasMethod(method) {
  return method === "root" || method === "get" || method === "set" || method === "call" ||
    method === "construct" || method === "keys" || method === "snapshot" || method === "release";
}

function adobepyDomDispatch(request, roots) {
  var args = request.args || [];
  if (request.method === "root") {
    var rootName = adobepyDomRequiredString(args[0], "root name");
    var rootValue = adobepyDomOwn(roots, rootName) ? roots[rootName] : null;
    if (typeof rootValue === "undefined" || rootValue === null) {
      throw new Error("official DOM root '" + rootName + "' is unavailable");
    }
    return adobepyDomEncode(rootValue);
  }

  if (request.method === "get") {
    return adobepyDomEncode(adobepyDomRead(adobepyDomResolve(args[0]), adobepyDomRequiredMember(args[1])));
  }

  if (request.method === "set") {
    return adobepyDomRunMutation(request, roots, "Set official DOM property", function () {
      var receiver = adobepyDomResolve(args[0]);
      var member = adobepyDomRequiredMember(args[1]);
      receiver[member] = adobepyDomDecode(args[2]);
      return adobepyDomEncode(adobepyDomRead(receiver, member));
    });
  }

  if (request.method === "call") {
    var callOperation = function () {
      var receiver = adobepyDomResolve(args[0]);
      var member = adobepyDomRequiredMember(args[1]);
      var callable = adobepyDomRead(receiver, member);
      if (typeof callable !== "function") {
        throw new Error("official DOM member '" + member + "' is not callable");
      }
      return adobepyDomEncode(callable.apply(receiver, adobepyDomDecodeArgs(args[2])));
    };
    if (request.options && (request.options.modal === true || typeof request.options.commandName === "string")) {
      return adobepyDomRunMutation(request, roots, "Call official DOM method " + String(args[1] || ""), callOperation);
    }
    return callOperation();
  }

  if (request.method === "construct") {
    return adobepyDomRunMutation(request, roots, "Construct official DOM object", function () {
      var receiver = adobepyDomResolve(args[0]);
      var member = adobepyDomRequiredMember(args[1]);
      var constructor = adobepyDomRead(receiver, member);
      if (typeof constructor !== "function") {
        throw new Error("official DOM member '" + member + "' is not a constructor");
      }
      return adobepyDomEncode(adobepyDomConstruct(constructor, adobepyDomDecodeArgs(args[2])));
    });
  }

  if (request.method === "keys") {
    return adobepyDomKeys(adobepyDomResolve(args[0]));
  }

  if (request.method === "snapshot") {
    var snapshotReceiver = adobepyDomResolve(args[0]);
    var requested = args[1];
    var members = adobepyDomIsArray(requested) ? requested : adobepyDomKeys(snapshotReceiver);
    var snapshot = {};
    for (var snapshotIndex = 0; snapshotIndex < members.length; snapshotIndex += 1) {
      var snapshotMember = adobepyDomRequiredMember(members[snapshotIndex]);
      try {
        var snapshotValue = adobepyDomRead(snapshotReceiver, snapshotMember);
        if (typeof snapshotValue !== "function") snapshot[String(snapshotMember)] = adobepyDomEncode(snapshotValue);
      } catch (error) {
        snapshot[String(snapshotMember)] = { $adobepyError: adobepyDomErrorMessage(error) };
      }
    }
    return snapshot;
  }

  if (request.method === "release") {
    return adobepyDomRelease(adobepyDomReferenceId(args[0]));
  }

  throw new Error("unsupported DOM method " + request.method);
}

function adobepyDomRunMutation(request, roots, defaultCommandName, operation) {
  var hostApp = roots && roots.app;
  var supportsUndoGroup = hostApp && typeof hostApp.beginUndoGroup === "function" &&
    typeof hostApp.endUndoGroup === "function";
  if (!supportsUndoGroup) return operation();
  var options = request.options || {};
  var commandName = typeof options.commandName === "string" && options.commandName ?
    options.commandName : defaultCommandName;
  hostApp.beginUndoGroup(commandName);
  try {
    return operation();
  } finally {
    hostApp.endUndoGroup();
  }
}

function adobepyDomEncode(value) {
  if (typeof value === "undefined" || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (adobepyDomIsArray(value)) {
    var encoded = [];
    for (var index = 0; index < value.length; index += 1) encoded.push(adobepyDomEncode(value[index]));
    return encoded;
  }

  for (var objectIndex = 0; objectIndex < adobepyDomState.objects.length; objectIndex += 1) {
    if (adobepyDomState.objects[objectIndex] === value) {
      return { $adobepyRef: adobepyDomState.references[objectIndex], $adobepyType: adobepyDomTypeName(value) };
    }
  }

  var reference = "cep_" + adobepyDomState.nextReference;
  adobepyDomState.nextReference += 1;
  adobepyDomState.values[reference] = value;
  adobepyDomState.objects.push(value);
  adobepyDomState.references.push(reference);
  return { $adobepyRef: reference, $adobepyType: adobepyDomTypeName(value) };
}

function adobepyDomDecode(value) {
  if (adobepyDomIsArray(value)) {
    var decoded = [];
    for (var index = 0; index < value.length; index += 1) decoded.push(adobepyDomDecode(value[index]));
    return decoded;
  }
  if (!value || typeof value !== "object") return value;
  if (typeof value.$adobepyRef === "string") return adobepyDomResolve(value);
  var objectValue = {};
  for (var key in value) {
    if (adobepyDomOwn(value, key)) objectValue[key] = adobepyDomDecode(value[key]);
  }
  return objectValue;
}

function adobepyDomDecodeArgs(value) {
  if (typeof value === "undefined") return [];
  if (!adobepyDomIsArray(value)) throw new Error("official DOM call arguments must be an array");
  return adobepyDomDecode(value);
}

function adobepyDomResolve(value) {
  var reference = adobepyDomReferenceId(value);
  if (!adobepyDomOwn(adobepyDomState.values, reference)) {
    throw new Error("official DOM reference '" + reference + "' is stale or unknown");
  }
  return adobepyDomState.values[reference];
}

function adobepyDomReferenceId(value) {
  var reference = value && typeof value === "object" ? value.$adobepyRef : null;
  if (typeof reference !== "string" || !reference) {
    throw new Error("expected an object containing '$adobepyRef'");
  }
  return reference;
}

function adobepyDomRelease(reference) {
  if (!adobepyDomOwn(adobepyDomState.values, reference)) return false;
  delete adobepyDomState.values[reference];
  for (var index = 0; index < adobepyDomState.references.length; index += 1) {
    if (adobepyDomState.references[index] === reference) {
      adobepyDomState.references.splice(index, 1);
      adobepyDomState.objects.splice(index, 1);
      break;
    }
  }
  return true;
}

function adobepyDomRequiredString(value, label) {
  var result = typeof value === "string" ? value : "";
  if (!result) throw new Error(label + " is required");
  return result;
}

function adobepyDomRequiredMember(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("official DOM member must be a string or array index");
  }
  if (typeof value === "string" && adobepyDomBlocked(value)) {
    throw new Error("official DOM member '" + value + "' is not accessible");
  }
  return value;
}

function adobepyDomBlocked(member) {
  return member === "__proto__" || member === "constructor" || member === "prototype" ||
    member === "eval" || member === "evalFile" || member === "Function";
}

function adobepyDomRead(receiver, member) {
  if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) {
    throw new Error("cannot read '" + member + "' from a primitive value");
  }
  return receiver[member];
}

function adobepyDomKeys(value) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
  var keys = [];
  var seen = {};
  var addKey = function (key) {
    key = String(key);
    if (!key || adobepyDomBlocked(key) || seen["$" + key]) return;
    seen["$" + key] = true;
    keys.push(key);
  };
  try {
    for (var key in value) addKey(key);
  } catch (enumerationError) {}
  try {
    var reflection = value.reflect;
    var collections = [reflection.properties || [], reflection.methods || []];
    for (var collectionIndex = 0; collectionIndex < collections.length; collectionIndex += 1) {
      var collection = collections[collectionIndex];
      for (var index = 0; index < collection.length; index += 1) {
        addKey(collection[index] && collection[index].name ? collection[index].name : collection[index]);
      }
    }
  } catch (reflectionError) {}
  return keys.sort();
}

function adobepyDomTypeName(value) {
  try {
    if (value && value.typename) return String(value.typename);
  } catch (typenameError) {}
  try {
    if (value && value.typeName) return String(value.typeName);
  } catch (typeNameError) {}
  try {
    if (value && value.reflect && value.reflect.name) return String(value.reflect.name);
  } catch (reflectionError) {}
  return typeof value === "function" ? "Function" : "Object";
}

function adobepyDomConstruct(constructor, args) {
  if (args.length === 0) return new constructor();
  if (args.length === 1) return new constructor(args[0]);
  if (args.length === 2) return new constructor(args[0], args[1]);
  if (args.length === 3) return new constructor(args[0], args[1], args[2]);
  if (args.length === 4) return new constructor(args[0], args[1], args[2], args[3]);
  if (args.length === 5) return new constructor(args[0], args[1], args[2], args[3], args[4]);
  if (args.length === 6) return new constructor(args[0], args[1], args[2], args[3], args[4], args[5]);
  if (args.length === 7) return new constructor(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
  if (args.length === 8) return new constructor(args[0], args[1], args[2], args[3], args[4], args[5], args[6], args[7]);
  throw new Error("official DOM constructors support at most 8 arguments");
}

function adobepyDomOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function adobepyDomIsArray(value) {
  return value instanceof Array || Object.prototype.toString.call(value) === "[object Array]";
}

function adobepyDomErrorMessage(error) {
  return error && error.message ? String(error.message) : String(error);
}
