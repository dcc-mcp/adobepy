import { methodNotFound, unavailable } from "../../core/src/errors";
import type { HostAdapter } from "../../core/src/host-adapter";
import type { RpcRequest } from "../../core/src/protocol";
import { asArray, asNumber, asString, evalJavaScript, isObject, maybePromise, optionalRequire, property } from "../../core/src/runtime";

type Callable = (...args: unknown[]) => unknown;

export const premiereAdapter: HostAdapter = {
  capabilities() {
    return {
      host: "premiere",
      bridgeKind: "uxp",
      bridgeVersion: "0.1.0",
      hostVersion: premiereVersion(),
      namespaces: ["app", "project", "sequence", "track", "clip", "projectItem", "bin", "marker", "raw"],
      features: ["project", "sequence", "track", "clip", "projectItem", "bin", "marker"],
      methods: {
        app: ["getVersion"],
        project: ["getActive", "getSequences", "getActiveSequence", "getRootItem", "importFiles"],
        sequence: ["getVideoTracks", "getAudioTracks"],
        track: ["getClips"],
        clip: ["getSelected"],
        projectItem: ["getChildren", "getSelected", "findByMediaPath"],
        bin: ["create"],
        marker: ["getMarkers", "create"],
        raw: ["evalJs"]
      }
    };
  },
  async dispatch(request: RpcRequest) {
    if (request.namespace === "app" && request.method === "getVersion") return premiereVersion();
    if (request.namespace === "project" && request.method === "getActive") return serializeProject(await activeProject());
    if (request.namespace === "project" && request.method === "getSequences") return serializeSequences(await projectSequences(await activeProject()));
    if (request.namespace === "project" && request.method === "getActiveSequence") return serializeSequence(await activeSequence());
    if (request.namespace === "project" && request.method === "getRootItem") return serializeProjectItem(await rootProjectItem());
    if (request.namespace === "project" && request.method === "importFiles") return importFiles(request);
    if (request.namespace === "sequence" && request.method === "getVideoTracks") {
      return serializeTracks(sequenceTracks(await requireSequence(request.args?.[0]), "video"), "video");
    }
    if (request.namespace === "sequence" && request.method === "getAudioTracks") {
      return serializeTracks(sequenceTracks(await requireSequence(request.args?.[0]), "audio"), "audio");
    }
    if (request.namespace === "track" && request.method === "getClips") return trackClips(request);
    if (request.namespace === "clip" && request.method === "getSelected") return selectedClips(await requireSequence(request.args?.[0]));
    if (request.namespace === "projectItem" && request.method === "getChildren") return projectItemChildren(request);
    if (request.namespace === "projectItem" && request.method === "getSelected") return selectedProjectItems();
    if (request.namespace === "projectItem" && request.method === "findByMediaPath") return projectItemsByMediaPath(request);
    if (request.namespace === "bin" && request.method === "create") return createBin(request);
    if (request.namespace === "marker" && request.method === "getMarkers") return sequenceMarkers(await requireSequence(request.args?.[0]));
    if (request.namespace === "marker" && request.method === "create") return createMarker(request);
    if (request.namespace === "raw" && request.method === "evalJs") return evalJavaScript(asString(request.args?.[0]) ?? "", request.args?.slice(1) ?? []);
    methodNotFound(request.namespace, request.method);
  }
};

function premiereModule() {
  return optionalRequire("premierepro") ?? (globalThis as { premierepro?: Record<string, unknown> }).premierepro ?? {};
}

function uxpModule() {
  return optionalRequire("uxp") ?? (globalThis as { uxp?: Record<string, unknown> }).uxp ?? {};
}

function premiereVersion(): string {
  const premiere = premiereModule();
  const host = property(uxpModule(), "host");
  return asString(property(premiere, "version")) ?? asString(property(host, "version")) ?? "unknown";
}

async function activeProject() {
  const premiere = premiereModule();
  const projectApi = property(premiere, "Project");
  const getActiveProject = property<Callable>(projectApi, "getActiveProject") ?? property<Callable>(projectApi, "getActive");
  if (getActiveProject) return await maybePromise(getActiveProject.call(projectApi));
  return property(premiere, "project") ?? property(property(premiere, "app"), "project");
}

async function projectSequences(project: unknown): Promise<unknown[]> {
  if (!project) return [];
  const getSequences = property<Callable>(project, "getSequences");
  if (getSequences) return collectionItems(await maybePromise(getSequences.call(project)));
  const sequences = property(project, "sequences") ?? property(project, "sequenceCollection");
  return collectionItems(sequences);
}

async function activeSequence() {
  const project = await activeProject();
  const direct = property(project, "activeSequence") ?? property(project, "active_sequence");
  if (direct) return direct;
  const getActiveSequence = property<Callable>(project, "getActiveSequence") ?? property<Callable>(project, "getActiveSequenceProjectItem");
  if (getActiveSequence) return await maybePromise(getActiveSequence.call(project));
  const premiere = premiereModule();
  return property(premiere, "activeSequence") ?? property(property(premiere, "app"), "activeSequence");
}

async function findSequence(idOrName: unknown) {
  const active = await activeSequence();
  if (sequenceMatches(active, idOrName) || idOrName === undefined || idOrName === null) return active;
  const sequences = await projectSequences(await activeProject());
  return sequences.find((sequence) => sequenceMatches(sequence, idOrName));
}

async function requireSequence(idOrName: unknown) {
  const sequence = await findSequence(idOrName);
  if (!sequence) unavailable("Premiere sequence");
  return sequence;
}

function sequenceMatches(sequence: unknown, idOrName: unknown): boolean {
  if (!isObject(sequence)) return false;
  if (idOrName === undefined || idOrName === null) return true;
  const values = [
    property(sequence, "id"),
    property(sequence, "guid"),
    property(sequence, "sequenceId"),
    property(sequence, "sequenceID"),
    property(sequence, "name")
  ];
  return values.some((value) => value !== undefined && String(value) === String(idOrName));
}

function serializeProject(project: unknown) {
  if (!isObject(project)) return null;
  return {
    id: property(project, "guid") ?? property(project, "id"),
    guid: property(project, "guid"),
    name: asString(property(project, "name")),
    path: asString(property(project, "path")),
    itemCount: asNumber(property(project, "itemCount")) ?? asNumber(property(project, "numItems"))
  };
}

async function rootProjectItem(project?: unknown) {
  project = project ?? (await activeProject());
  const getRootItem = property<Callable>(project, "getRootItem");
  if (getRootItem) return await maybePromise(getRootItem.call(project));
  return property(project, "rootItem") ?? property(project, "root") ?? property(project, "rootProjectItem");
}

async function requireProjectItem(idOrName: unknown) {
  const project = await activeProject();
  const root = await rootProjectItem(project);
  const item = findProjectItem(root, idOrName);
  if (!item) unavailable("Premiere project item");
  return item;
}

async function importFiles(request: RpcRequest) {
  const project = await activeProject();
  if (!project) unavailable("Premiere project");
  const payload = isObject(request.args?.[0]) ? request.args?.[0] : { filePaths: request.args?.[0] };
  const filePaths = normalizeFilePaths(property(payload, "filePaths") ?? property(payload, "paths") ?? property(payload, "path"));
  if (filePaths.length === 0) unavailable("Premiere import file paths");
  const targetBinId = property(payload, "targetBin") ?? property(payload, "target_bin") ?? property(payload, "targetBinId") ?? property(payload, "target_bin_id");
  const targetBin = targetBinId === undefined || targetBinId === null ? await rootProjectItem(project) : await requireProjectItem(targetBinId);
  const importProjectFiles = property<Callable>(project, "importFiles");
  if (!importProjectFiles) unavailable("Premiere project.importFiles");
  const suppressUI = booleanValue(property(payload, "suppressUI") ?? property(payload, "suppress_ui")) ?? true;
  const asNumberedStills = booleanValue(property(payload, "asNumberedStills") ?? property(payload, "as_numbered_stills")) ?? false;
  const result = await maybePromise(importProjectFiles.call(project, filePaths, suppressUI, targetBin, asNumberedStills));
  const resultItems = collectionItems(result);
  if (resultItems.length > 0) return serializeProjectItems(resultItems);
  return serializeProjectItems(findImportedProjectItems(filePaths, targetBin ?? (await rootProjectItem(project))));
}

async function projectItemChildren(request: RpcRequest) {
  const item = request.args?.[0] === undefined || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
  return serializeProjectItems(projectItemChildObjects(item));
}

async function selectedProjectItems() {
  const premiere = premiereModule();
  const project = await activeProject();
  const projectUtils = property(premiere, "ProjectUtils") ?? property(premiere, "projectUtils");
  const getSelection = property<Callable>(projectUtils, "getSelection");
  if (getSelection) return serializeProjectItems(collectionItems(await maybePromise(getSelection.call(projectUtils, project))));
  const selection = property(project, "selection") ?? property(premiere, "selection");
  return serializeProjectItems(collectionItems(selection));
}

async function projectItemsByMediaPath(request: RpcRequest) {
  const root = request.args?.[0] === undefined || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
  const matchString = asString(request.args?.[1]) ?? "";
  const ignoreSubclips = booleanValue(request.args?.[2]) ?? false;
  if (!matchString) unavailable("Premiere media path match");
  const directFind = property<Callable>(root, "findItemsMatchingMediaPath");
  if (directFind) return serializeProjectItems(collectionItems(await maybePromise(directFind.call(root, matchString, ignoreSubclips))));
  return serializeProjectItems(findProjectItemsMatchingMediaPath(root, matchString));
}

async function createBin(request: RpcRequest) {
  const project = await activeProject();
  const payload = isObject(request.args?.[0]) ? request.args?.[0] : { parentId: request.args?.[0], name: request.args?.[1] };
  const name = asString(property(payload, "name"));
  if (!name) unavailable("Premiere bin name");
  const parentId = property(payload, "parentId") ?? property(payload, "parent_id");
  const parent = parentId === undefined || parentId === null ? await rootProjectItem(project) : await requireProjectItem(parentId);
  if (!parent) unavailable("Premiere parent bin");
  const makeUnique = booleanValue(property(payload, "makeUnique") ?? property(payload, "make_unique")) ?? true;
  const createDirect = property<Callable>(parent, "createBin");
  if (createDirect) {
    const created = await maybePromise(createDirect.call(parent, name, makeUnique));
    return serializeProjectItem(isObject(created) ? created : findProjectItem(parent, name));
  }
  const createAction = property<Callable>(parent, "createBinAction");
  const executeTransaction = property<Callable>(project, "executeTransaction");
  if (createAction && executeTransaction) {
    await maybePromise(
      executeTransaction.call(
        project,
        (compoundAction: unknown) => {
          const action = createAction.call(parent, name, makeUnique);
          const addAction = property<Callable>(compoundAction, "addAction") ?? property<Callable>(compoundAction, "add");
          if (addAction) addAction.call(compoundAction, action);
        },
        asString(request.options?.commandName) ?? "Create bin"
      )
    );
    return serializeProjectItem(findProjectItem(parent, name));
  }
  unavailable("Premiere bin.create");
}

function serializeSequences(sequences: unknown[]) {
  return sequences.map(serializeSequence).filter((sequence) => sequence !== null);
}

function serializeSequence(sequence: unknown) {
  if (!isObject(sequence)) return null;
  return {
    id: property(sequence, "id") ?? property(sequence, "guid") ?? property(sequence, "sequenceId") ?? property(sequence, "sequenceID"),
    guid: property(sequence, "guid"),
    sequenceId: property(sequence, "sequenceId") ?? property(sequence, "sequenceID"),
    name: asString(property(sequence, "name")),
    duration: serializeTime(property(sequence, "duration") ?? property(sequence, "end")),
    timebase: property(sequence, "timebase") ?? property(sequence, "videoDisplayFormat"),
    typename: asString(property(sequence, "typename")) ?? asString(property(sequence, "typeName"))
  };
}

function sequenceTracks(sequence: unknown, mediaType: "video" | "audio"): unknown[] {
  const propertyName = mediaType === "video" ? "videoTracks" : "audioTracks";
  return collectionItems(property(sequence, propertyName));
}

function serializeTracks(tracks: unknown[], mediaType: "video" | "audio") {
  return tracks.map((track, index) => serializeTrack(track, index, mediaType)).filter((track) => track !== null);
}

function serializeTrack(track: unknown, index: number, mediaType: "video" | "audio") {
  if (!isObject(track)) return null;
  return {
    id: property(track, "id") ?? property(track, "trackID") ?? property(track, "trackId") ?? index,
    name: asString(property(track, "name")),
    index: asNumber(property(track, "index")) ?? index,
    mediaType,
    isLocked: booleanValue(property(track, "isLocked") ?? property(track, "locked")),
    isMuted: booleanValue(property(track, "isMuted") ?? property(track, "muted")),
    isTargeted: booleanValue(property(track, "isTargeted") ?? property(track, "targeted")),
    typename: asString(property(track, "typename")) ?? asString(property(track, "typeName"))
  };
}

async function trackClips(request: RpcRequest) {
  const sequence = await requireSequence(request.args?.[0]);
  const mediaType = normalizeMediaType(request.args?.[1]);
  const track = findTrack(sequence, mediaType, request.args?.[2]);
  if (!track) unavailable("Premiere track");
  return collectionItems(property(track, "clips")).map(serializeClip).filter((clip) => clip !== null);
}

function selectedClips(sequence: unknown) {
  const clips = [
    ...sequenceTracks(sequence, "video").flatMap((track) => collectionItems(property(track, "clips"))),
    ...sequenceTracks(sequence, "audio").flatMap((track) => collectionItems(property(track, "clips")))
  ];
  return clips.filter((clip) => booleanValue(property(clip, "isSelected") ?? property(clip, "selected")) === true).map(serializeClip).filter((clip) => clip !== null);
}

function findTrack(sequence: unknown, mediaType: "video" | "audio", idOrIndex: unknown) {
  const tracks = sequenceTracks(sequence, mediaType);
  if (idOrIndex === undefined || idOrIndex === null) return tracks[0];
  return tracks.find((track, index) => {
    const values = [property(track, "id"), property(track, "trackID"), property(track, "trackId"), property(track, "name"), property(track, "index"), index];
    return values.some((value) => value !== undefined && String(value) === String(idOrIndex));
  });
}

function serializeClip(clip: unknown) {
  if (!isObject(clip)) return null;
  const projectItem = property(clip, "projectItem");
  return {
    id: property(clip, "id") ?? property(clip, "nodeId") ?? property(clip, "nodeID"),
    name: asString(property(clip, "name")) ?? asString(property(projectItem, "name")),
    projectItemId: property(projectItem, "id") ?? property(projectItem, "nodeId") ?? property(projectItem, "nodeID"),
    mediaPath: asString(property(clip, "mediaPath")) ?? asString(property(projectItem, "mediaPath")) ?? asString(property(projectItem, "treePath")),
    start: serializeTime(property(clip, "start")),
    end: serializeTime(property(clip, "end")),
    inPoint: serializeTime(property(clip, "inPoint")),
    outPoint: serializeTime(property(clip, "outPoint")),
    duration: serializeTime(property(clip, "duration")),
    isEnabled: booleanValue(property(clip, "isEnabled") ?? property(clip, "enabled")),
    isSelected: booleanValue(property(clip, "isSelected") ?? property(clip, "selected")),
    typename: asString(property(clip, "typename")) ?? asString(property(clip, "typeName"))
  };
}

async function sequenceMarkers(sequence: unknown) {
  const markers = property(sequence, "markers") ?? property(sequence, "markerCollection");
  const getMarkers = property<Callable>(markers, "getMarkers") ?? property<Callable>(sequence, "getMarkers");
  if (getMarkers) return collectionItems(await maybePromise(getMarkers.call(markers ?? sequence))).map(serializeMarker).filter((marker) => marker !== null);
  return markerItems(markers).map(serializeMarker).filter((marker) => marker !== null);
}

async function createMarker(request: RpcRequest) {
  const sequence = await requireSequence(request.args?.[0]);
  const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
  const markers = property(sequence, "markers") ?? property(sequence, "markerCollection");
  const create = property<Callable>(markers, "createMarker") ?? property<Callable>(sequence, "createMarker");
  if (!create) unavailable("Premiere marker.createMarker");
  const start = property(payload, "start") ?? property(payload, "time") ?? 0;
  const marker = await maybePromise(create.call(markers ?? sequence, start));
  if (isObject(marker)) applyMarkerPayload(marker, payload);
  return serializeMarker(marker);
}

function applyMarkerPayload(marker: Record<string, unknown>, payload: Record<string, unknown>) {
  const assignments: Array<[string, unknown]> = [
    ["name", property(payload, "name")],
    ["comments", property(payload, "comments") ?? property(payload, "comment")],
    ["end", property(payload, "end")],
    ["duration", property(payload, "duration")],
    ["markerType", property(payload, "markerType") ?? property(payload, "marker_type")]
  ];
  for (const [key, value] of assignments) {
    if (value !== undefined) marker[key] = value;
  }
}

function markerItems(markers: unknown): unknown[] {
  const direct = collectionItems(markers);
  if (direct.length > 0) return direct;
  const getFirstMarker = property<Callable>(markers, "getFirstMarker");
  const getNextMarker = property<Callable>(markers, "getNextMarker");
  if (getFirstMarker && getNextMarker) {
    const result: unknown[] = [];
    let current = getFirstMarker.call(markers);
    for (let guard = 0; current && guard < 10000; guard += 1) {
      result.push(current);
      current = getNextMarker.call(markers, current);
    }
    return result;
  }
  return [];
}

function serializeMarker(marker: unknown) {
  if (!isObject(marker)) return null;
  return {
    id: property(marker, "id") ?? property(marker, "guid") ?? property(marker, "markerID") ?? property(marker, "markerId"),
    name: asString(property(marker, "name")),
    comments: asString(property(marker, "comments")) ?? asString(property(marker, "comment")),
    start: serializeTime(property(marker, "start") ?? property(marker, "time")),
    end: serializeTime(property(marker, "end")),
    duration: serializeTime(property(marker, "duration")),
    markerType: asString(property(marker, "markerType")) ?? asString(property(marker, "marker_type")),
    typename: asString(property(marker, "typename")) ?? asString(property(marker, "typeName"))
  };
}

function serializeProjectItems(items: unknown[]) {
  return items.map(serializeProjectItem).filter((item) => item !== null);
}

function serializeProjectItem(item: unknown) {
  if (!isObject(item)) return null;
  const children = projectItemChildObjects(item);
  const typename = asString(property(item, "typename")) ?? asString(property(item, "typeName"));
  const mediaPath = asString(property(item, "mediaPath")) ?? asString(safeCall(item, "getMediaFilePath"));
  const treePath = asString(property(item, "treePath")) ?? asString(property(item, "path"));
  const itemType = projectItemType(item, children, typename, mediaPath);
  return {
    id: projectItemId(item),
    name: asString(property(item, "name")),
    type: property(item, "type"),
    itemType,
    path: treePath ?? mediaPath,
    mediaPath,
    treePath,
    parentId: projectItemId(property(item, "parent")),
    childCount: children.length,
    isBin: itemType === "bin",
    isClip: itemType === "clip",
    isSequence: itemType === "sequence",
    canProxy: booleanValue(property(item, "canProxy")) ?? booleanValue(safeCall(item, "canProxy")),
    hasProxy: booleanValue(property(item, "hasProxy")) ?? booleanValue(safeCall(item, "hasProxy")),
    isOffline: booleanValue(property(item, "isOffline")) ?? booleanValue(safeCall(item, "isOffline")),
    typename
  };
}

function projectItemType(item: unknown, children: unknown[], typename?: string, mediaPath?: string): string | undefined {
  const explicit = asString(property(item, "itemType")) ?? asString(property(item, "kind"));
  if (explicit) return explicit;
  const normalizedTypename = typename?.toLowerCase() ?? "";
  if (normalizedTypename.includes("folder") || normalizedTypename.includes("bin")) return "bin";
  if (booleanValue(property(item, "isBin")) === true || children.length > 0) return "bin";
  if (booleanValue(property(item, "isSequence")) === true || normalizedTypename.includes("sequence")) return "sequence";
  if (mediaPath || normalizedTypename.includes("clip")) return "clip";
  const type = property(item, "type");
  return type === undefined ? undefined : String(type);
}

function projectItemId(item: unknown) {
  return property(item, "id") ?? property(item, "guid") ?? property(item, "nodeId") ?? property(item, "nodeID");
}

function projectItemChildObjects(item: unknown): unknown[] {
  const direct = collectionItems(property(item, "children") ?? property(item, "items"));
  if (direct.length > 0) return direct;
  return collectionItems(safeCall(item, "getItems") ?? safeCall(item, "getChildren"));
}

function findProjectItem(root: unknown, idOrName: unknown): unknown {
  if (idOrName === undefined || idOrName === null) return root;
  return collectProjectItems(root).find((item) => projectItemMatches(item, idOrName));
}

function collectProjectItems(root: unknown): unknown[] {
  const result: unknown[] = [];
  const queue: unknown[] = root ? [root] : [];
  const seen = new Set<unknown>();
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
    queue.push(...projectItemChildObjects(item));
  }
  return result;
}

function projectItemMatches(item: unknown, idOrName: unknown): boolean {
  if (!isObject(item)) return false;
  const mediaPath = asString(property(item, "mediaPath")) ?? asString(safeCall(item, "getMediaFilePath"));
  const values = [
    projectItemId(item),
    property(item, "name"),
    property(item, "treePath"),
    property(item, "path"),
    mediaPath
  ];
  return values.some((value) => value !== undefined && String(value) === String(idOrName));
}

function findProjectItemsMatchingMediaPath(root: unknown, matchString: string): unknown[] {
  return collectProjectItems(root).filter((item) => {
    const mediaPath = asString(property(item, "mediaPath")) ?? asString(safeCall(item, "getMediaFilePath"));
    return mediaPath?.includes(matchString) || asString(property(item, "name"))?.includes(matchString);
  });
}

function findImportedProjectItems(filePaths: string[], root: unknown): unknown[] {
  const candidates = collectProjectItems(root);
  return filePaths
    .map((filePath) => {
      const fileName = filePath.split(/[\\/]/).filter(Boolean).pop() ?? filePath;
      return candidates.find((item) => {
        const mediaPath = asString(property(item, "mediaPath")) ?? asString(safeCall(item, "getMediaFilePath"));
        return mediaPath === filePath || asString(property(item, "name")) === fileName;
      });
    })
    .filter((item) => item !== undefined);
}

function normalizeFilePaths(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => asString(item)).filter((item) => item !== undefined);
}

function safeCall(receiver: unknown, method: string, ...args: unknown[]): unknown {
  const fn = property<Callable>(receiver, method);
  if (!fn) return undefined;
  try {
    return fn.apply(receiver, args);
  } catch {
    return undefined;
  }
}

function collectionItems(value: unknown): unknown[] {
  const direct = asArray(value);
  if (direct.length > 0) return direct;
  const count = asNumber(property(value, "numItems")) ?? asNumber(property(value, "numTracks")) ?? asNumber(property(value, "numMarkers")) ?? asNumber(property(value, "length"));
  if (count === undefined || count <= 0) return [];
  const at = property<Callable>(value, "at") ?? property<Callable>(value, "getAt") ?? property<Callable>(value, "item");
  if (!at) return [];
  const result: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = at.call(value, index);
    if (item !== undefined && item !== null) result.push(item);
  }
  return result;
}

function normalizeMediaType(value: unknown): "video" | "audio" {
  return asString(value)?.toLowerCase() === "audio" ? "audio" : "video";
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function serializeTime(value: unknown): unknown {
  if (!isObject(value)) return asNumber(value) ?? asString(value) ?? value;
  const seconds = asNumber(property(value, "seconds"));
  const ticks = asString(property(value, "ticks")) ?? asString(property(value, "ticksPerSecond"));
  if (seconds !== undefined && ticks !== undefined) return { seconds, ticks };
  if (seconds !== undefined) return seconds;
  if (ticks !== undefined) return ticks;
  return asNumber(value) ?? value;
}
