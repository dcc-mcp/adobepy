import { methodNotFound, unavailable } from "../../core/src/errors";
import { DomRuntime } from "../../core/src/dom";
import type { HostAdapter } from "../../core/src/host-adapter";
import type { RpcRequest } from "../../core/src/protocol";
import { asNumber, asString, evalJavaScript, isObject, maybePromise, optionalRequire, property } from "../../core/src/runtime";

type Callable = (...args: unknown[]) => unknown;
const COLLECTION_LIMIT = 10000;

const domRuntime = new DomRuntime({
  roots(name) {
    if (name === "app" || name === "module" || name === "premierepro") return premiereModule();
    if (name === "uxp") return uxpModule();
    return undefined;
  }
});

export const premiereAdapter: HostAdapter = {
  capabilities() {
    return {
      host: "premiere",
      bridgeKind: "uxp",
      bridgeVersion: "0.1.0",
      hostVersion: premiereVersion(),
      namespaces: ["app", "project", "sequence", "track", "clip", "projectItem", "bin", "marker", "encoder", "export", "dom", "raw"],
      features: ["project", "sequence", "track", "clip", "projectItem", "bin", "marker", "encoder", "export", "structuredDom"],
      methods: {
        app: ["getVersion"],
        project: ["getActive", "getSequences", "getActiveSequence", "getRootItem", "save", "saveAs", "createSequence", "importFiles"],
        sequence: ["getVideoTracks", "getAudioTracks", "insertProjectItem", "overwriteProjectItem"],
        track: ["getClips"],
        clip: ["getSelected"],
        projectItem: ["getChildren", "getSelected", "findByMediaPath"],
        bin: ["create"],
        marker: ["getMarkers", "create"],
        encoder: ["getManager", "getPresets", "getExportFileExtension", "encodeFile", "encodeProjectItem", "exportSequence"],
        export: ["getExporter", "exportFrame"],
        dom: ["root", "get", "set", "call", "construct", "keys", "snapshot", "release"],
        raw: ["evalJs"]
      }
    };
  },
  async dispatch(request: RpcRequest) {
    if (request.namespace === "dom") return domRuntime.dispatch(request);
    if (request.namespace === "app" && request.method === "getVersion") return premiereVersion();
    if (request.namespace === "project" && request.method === "getActive") return serializeProject(await activeProject());
    if (request.namespace === "project" && request.method === "getSequences") return serializeSequences(await projectSequences(await activeProject()));
    if (request.namespace === "project" && request.method === "getActiveSequence") return serializeSequence(await activeSequence());
    if (request.namespace === "project" && request.method === "getRootItem") return serializeProjectItem(await rootProjectItem());
    if (request.namespace === "project" && request.method === "save") return saveProject();
    if (request.namespace === "project" && request.method === "saveAs") return saveProjectAs(request);
    if (request.namespace === "project" && request.method === "createSequence") return createSequence(request);
    if (request.namespace === "project" && request.method === "importFiles") return importFiles(request);
    if (request.namespace === "sequence" && request.method === "getVideoTracks") {
      return serializeTracks(await sequenceTracks(await requireSequence(request.args?.[0]), "video"), "video");
    }
    if (request.namespace === "sequence" && request.method === "getAudioTracks") {
      return serializeTracks(await sequenceTracks(await requireSequence(request.args?.[0]), "audio"), "audio");
    }
    if (request.namespace === "sequence" && request.method === "insertProjectItem") return editProjectItem(request, false);
    if (request.namespace === "sequence" && request.method === "overwriteProjectItem") return editProjectItem(request, true);
    if (request.namespace === "track" && request.method === "getClips") return trackClips(request);
    if (request.namespace === "clip" && request.method === "getSelected") return selectedClips(await requireSequence(request.args?.[0]));
    if (request.namespace === "projectItem" && request.method === "getChildren") return projectItemChildren(request);
    if (request.namespace === "projectItem" && request.method === "getSelected") return selectedProjectItems();
    if (request.namespace === "projectItem" && request.method === "findByMediaPath") return projectItemsByMediaPath(request);
    if (request.namespace === "bin" && request.method === "create") return createBin(request);
    if (request.namespace === "marker" && request.method === "getMarkers") return sequenceMarkers(await requireSequence(request.args?.[0]));
    if (request.namespace === "marker" && request.method === "create") return createMarker(request);
    if (request.namespace === "encoder" && request.method === "getManager") return serializeEncoderManager(await encoderManager());
    if (request.namespace === "encoder" && request.method === "getPresets") return encoderPresets();
    if (request.namespace === "encoder" && request.method === "getExportFileExtension") return getExportFileExtension(request);
    if (request.namespace === "encoder" && request.method === "encodeFile") return encodeFile(request);
    if (request.namespace === "encoder" && request.method === "encodeProjectItem") return encodeProjectItem(request);
    if (request.namespace === "encoder" && request.method === "exportSequence") return exportSequence(request);
    if (request.namespace === "export" && request.method === "getExporter") return serializeExporter(await exporterApi());
    if (request.namespace === "export" && request.method === "exportFrame") return exportFrame(request);
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
  if (getSequences) return await collectionItems(await maybePromise(getSequences.call(project)), true);
  const sequences = property(project, "sequences") ?? property(project, "sequenceCollection");
  return await collectionItems(sequences, true);
}

async function saveProject() {
  const project = await activeProject();
  const save = property<Callable>(project, "save");
  if (!save) unavailable("Premiere project save");
  if (await maybePromise(save.call(project)) === false) unavailable("Premiere project save failed");
  return serializeProject(project);
}

async function saveProjectAs(request: RpcRequest) {
  const project = await activeProject();
  const path = asString(request.args?.[0]);
  const saveAs = property<Callable>(project, "saveAs");
  if (!path || !saveAs) unavailable("Premiere project saveAs");
  if (await maybePromise(saveAs.call(project, path)) === false) unavailable("Premiere project saveAs failed");
  return serializeProject(project);
}

async function createSequence(request: RpcRequest) {
  const project = await activeProject();
  const payload = isObject(request.args?.[0]) ? request.args?.[0] : { name: request.args?.[0] };
  const name = asString(property(payload, "name"));
  const presetPath = asString(property(payload, "presetPath") ?? property(payload, "preset_path"));
  if (!name) unavailable("Premiere sequence name");
  const createWithPreset = property<Callable>(project, "createSequenceWithPresetPath");
  const create = property<Callable>(project, "createSequence");
  if (presetPath && createWithPreset) return serializeSequence(await maybePromise(createWithPreset.call(project, name, presetPath)));
  if (!create) unavailable("Premiere project.createSequence");
  return serializeSequence(await maybePromise(create.call(project, name, presetPath)));
}

async function editProjectItem(request: RpcRequest, overwrite: boolean) {
  const sequence = await requireSequence(request.args?.[0]);
  const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
  const item = await requireProjectItem(property(payload, "projectItem") ?? property(payload, "project_item"));
  const time = premiereTickTime(property(payload, "time") ?? 0);
  const videoTrack = asNumber(property(payload, "videoTrack") ?? property(payload, "video_track")) ?? 0;
  const audioTrack = asNumber(property(payload, "audioTrack") ?? property(payload, "audio_track")) ?? 0;
  const premiere = premiereModule();
  const editorType = property(premiere, "SequenceEditor");
  const getEditor = property<Callable>(editorType, "getEditor");
  const editor = getEditor ? getEditor.call(editorType, sequence) : null;
  const method = property<Callable>(editor, overwrite ? "createOverwriteItemAction" : "createInsertProjectItemAction");
  const project = await activeProject();
  if (!method) unavailable(`Premiere SequenceEditor ${overwrite ? "overwrite" : "insert"}`);
  const createAction = () => overwrite
    ? method.call(editor, item, time, videoTrack, audioTrack)
    : method.call(editor, item, time, videoTrack, audioTrack, booleanValue(property(payload, "limitShift") ?? property(payload, "limit_shift")) ?? false);
  await executeProjectAction(project, createAction, asString(request.options?.commandName) ?? (overwrite ? "Overwrite project item" : "Insert project item"));
  return { edited: true, mode: overwrite ? "overwrite" : "insert", sequence: await serializeSequence(sequence), projectItem: await serializeProjectItem(item) };
}

function premiereTickTime(value: unknown) {
  const tickTime = property(premiereModule(), "TickTime");
  const ticks = typeof value === "string" ? value : property(value, "ticks");
  if (ticks !== undefined) {
    const createWithTicks = property<Callable>(tickTime, "createWithTicks");
    if (typeof ticks !== "string" || !/^-?\d+$/.test(ticks) || !createWithTicks) unavailable("Premiere TickTime ticks");
    return createWithTicks.call(tickTime, ticks);
  }
  const seconds = asNumber(isObject(value) ? property(value, "seconds") : value);
  if (seconds === undefined || !Number.isFinite(seconds)) unavailable("Premiere TickTime seconds");
  const createWithSeconds = property<Callable>(tickTime, "createWithSeconds");
  if (!createWithSeconds) unavailable("Premiere TickTime.createWithSeconds");
  return createWithSeconds.call(tickTime, seconds);
}

async function executeProjectAction(project: unknown, createAction: () => unknown, commandName: string) {
  const execute = property<Callable>(project, "executeTransaction");
  if (!execute) unavailable("Premiere project.executeTransaction");
  let result: unknown;
  const run = () => {
    result = execute.call(project, (compound: unknown) => {
      const add = property<Callable>(compound, "addAction") ?? property<Callable>(compound, "add");
      if (!add) unavailable("Premiere compound action");
      add.call(compound, createAction());
    }, commandName);
  };
  const lockedAccess = property<Callable>(project, "lockedAccess");
  if (lockedAccess) await maybePromise(lockedAccess.call(project, run));
  else run();
  if (await maybePromise(result) === false) unavailable("Premiere transaction failed");
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
  const target = String(idOrName);
  const values = [
    property(sequence, "id"),
    property(sequence, "guid"),
    property(sequence, "sequenceId"),
    property(sequence, "sequenceID"),
    property(sequence, "name")
  ];
  return values.some((value) => {
    if (value === undefined || value === null) return false;
    const serialized = serializeId(value);
    // Never let an unserializable ID become the literal string "undefined" and
    // accidentally match a caller that passed the string "undefined".
    return serialized !== undefined && String(serialized) === target;
  });
}

function isThenable(value: unknown): boolean {
  return (isObject(value) || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

function serializeProject(project: unknown) {
  if (!isObject(project)) return null;
  return {
    id: serializeId(property(project, "guid") ?? property(project, "id")),
    guid: serializeId(property(project, "guid")),
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
  const item = await findProjectItem(root, idOrName);
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
  if (result === false) unavailable("Premiere project importFiles failed");
  const resultItems = await collectionItems(result);
  if (resultItems.length > 0) return serializeProjectItems(resultItems);
  return serializeProjectItems(await findImportedProjectItems(filePaths, targetBin ?? (await rootProjectItem(project))));
}

async function projectItemChildren(request: RpcRequest) {
  const item = request.args?.[0] === undefined || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
  return serializeProjectItems(await projectItemChildObjects(item));
}

async function selectedProjectItems() {
  const premiere = premiereModule();
  const project = await activeProject();
  const projectUtils = property(premiere, "ProjectUtils") ?? property(premiere, "projectUtils");
  const getSelection = property<Callable>(projectUtils, "getSelection");
  if (getSelection) {
    const selection = await maybePromise(getSelection.call(projectUtils, project));
    return serializeProjectItems(await collectionItems((await readValue(selection, "getItems")) ?? selection, true));
  }
  const selection = property(project, "selection") ?? property(premiere, "selection");
  return serializeProjectItems(await collectionItems(selection, true));
}

async function projectItemsByMediaPath(request: RpcRequest) {
  const root = request.args?.[0] === undefined || request.args?.[0] === null ? await rootProjectItem() : await requireProjectItem(request.args?.[0]);
  const matchString = asString(request.args?.[1]) ?? "";
  const ignoreSubclips = booleanValue(request.args?.[2]) ?? false;
  if (!matchString) unavailable("Premiere media path match");
  const directFind = property<Callable>(root, "findItemsMatchingMediaPath");
  if (directFind) return serializeProjectItems(await collectionItems(await maybePromise(directFind.call(root, matchString, ignoreSubclips))));
  if (ignoreSubclips) unavailable("Premiere media path search excluding subclips");
  return serializeProjectItems(await findProjectItemsMatchingMediaPath(root, matchString));
}

async function createBin(request: RpcRequest) {
  const project = await activeProject();
  const payload = isObject(request.args?.[0]) ? request.args?.[0] : { parentId: request.args?.[0], name: request.args?.[1] };
  const name = asString(property(payload, "name"));
  if (!name) unavailable("Premiere bin name");
  const parentId = property(payload, "parentId") ?? property(payload, "parent_id");
  const resolvedParent = parentId === undefined || parentId === null ? await rootProjectItem(project) : await requireProjectItem(parentId);
  const parent = await castProjectItem(resolvedParent, "FolderItem") ?? resolvedParent;
  if (!parent) unavailable("Premiere parent bin");
  const existingIds = new Set(await Promise.all((await projectItemChildObjects(parent)).map(projectItemId)));
  const makeUnique = booleanValue(property(payload, "makeUnique") ?? property(payload, "make_unique")) ?? true;
  const createDirect = property<Callable>(parent, "createBin");
  if (createDirect) {
    const created = await maybePromise(createDirect.call(parent, name, makeUnique));
    if (created === false) unavailable("Premiere bin creation failed");
    if (isObject(created)) return serializeProjectItem(created);
  } else {
    const createAction = property<Callable>(parent, "createBinAction");
    if (!createAction) unavailable("Premiere bin.create");
    await executeProjectAction(project, () => createAction.call(parent, name, makeUnique), asString(request.options?.commandName) ?? "Create bin");
  }
  const createdChildren = [];
  for (const child of await projectItemChildObjects(parent)) {
    const id = await projectItemId(child);
    if (id !== undefined && !existingIds.has(id)) createdChildren.push(child);
  }
  if (createdChildren.length !== 1) unavailable("Premiere newly created bin identity");
  return serializeProjectItem(createdChildren[0]);
}

async function serializeSequences(sequences: unknown[]) {
  return (await Promise.all(sequences.map(serializeSequence))).filter((sequence) => sequence !== null);
}

async function serializeSequence(sequence: unknown) {
  if (!isObject(sequence)) return null;
  const id = sequenceId(sequence);
  return {
    id,
    guid: serializeId(property(sequence, "guid")),
    sequenceId: serializeId(property(sequence, "sequenceId") ?? property(sequence, "sequenceID")) ?? id,
    name: asString(property(sequence, "name")),
    duration: serializeTime(await readValue(sequence, "getEndTime", "duration", "end")),
    timebase: await readValue(sequence, "getTimebase", "timebase", "videoDisplayFormat"),
    typename: asString(property(sequence, "typename")) ?? asString(property(sequence, "typeName"))
  };
}

function sequenceId(sequence: unknown) {
  return serializeId(property(sequence, "id") ?? property(sequence, "guid") ?? property(sequence, "sequenceId") ?? property(sequence, "sequenceID"));
}

async function sequenceTracks(sequence: unknown, mediaType: "video" | "audio"): Promise<unknown[]> {
  const prefix = mediaType === "video" ? "Video" : "Audio";
  const getCount = property<Callable>(sequence, `get${prefix}TrackCount`);
  const getTrack = property<Callable>(sequence, `get${prefix}Track`);
  if (getCount || getTrack) {
    if (!getCount || !getTrack) unavailable(`Premiere ${mediaType} track enumeration`);
    const count = await maybePromise(getCount.call(sequence));
    validateCollectionCount(count);
    const tracks: unknown[] = [];
    for (let index = 0; index < count; index += 1) {
      const track = await maybePromise(getTrack.call(sequence, index));
      if (!isObject(track)) unavailable(`Premiere ${mediaType} track at index ${index}`);
      tracks.push(track);
    }
    return tracks;
  }
  const propertyName = mediaType === "video" ? "videoTracks" : "audioTracks";
  return await collectionItems(property(sequence, propertyName), true);
}

async function serializeTracks(tracks: unknown[], mediaType: "video" | "audio") {
  return Promise.all(tracks.map((track, index) => serializeTrack(track, index, mediaType)));
}

async function serializeTrack(track: unknown, index: number, mediaType: "video" | "audio") {
  if (!isObject(track)) unavailable("Premiere track object");
  return {
    id: serializeId(property(track, "id") ?? property(track, "trackID") ?? property(track, "trackId")) ?? index,
    name: asString(property(track, "name")),
    index: asNumber(await readValue(track, "getIndex", "index")) ?? index,
    mediaType,
    isLocked: booleanValue(await readValue(track, "isLocked", "locked")),
    isMuted: booleanValue(await readValue(track, "isMuted", "muted")),
    isTargeted: booleanValue(await readValue(track, "isTargeted", "targeted")),
    typename: asString(property(track, "typename")) ?? asString(property(track, "typeName"))
  };
}

async function trackClips(request: RpcRequest) {
  const sequence = await requireSequence(request.args?.[0]);
  const mediaType = normalizeMediaType(request.args?.[1]);
  const found = await findTrack(sequence, mediaType, request.args?.[2]);
  if (!found) unavailable("Premiere track");
  const clips = await trackClipObjects(found.track);
  return Promise.all(clips.map((clip, index) => serializeClip(clip, sequence, mediaType, found.index, index)));
}

async function selectedClips(sequence: unknown) {
  const selected = [];
  let count = 0;
  for (const mediaType of ["video", "audio"] as const) {
    const tracks = await sequenceTracks(sequence, mediaType);
    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex += 1) {
      const clips = await trackClipObjects(tracks[trackIndex]);
      count += clips.length;
      validateCollectionCount(count);
      for (let index = 0; index < clips.length; index += 1) {
        if (booleanValue(await readValue(clips[index], "getIsSelected", "isSelected", "selected")) === true) {
          selected.push(await serializeClip(clips[index], sequence, mediaType, trackIndex, index));
        }
      }
    }
  }
  return selected;
}

async function findTrack(sequence: unknown, mediaType: "video" | "audio", idOrIndex: unknown) {
  const tracks = await sequenceTracks(sequence, mediaType);
  let index = 0;
  if (idOrIndex !== undefined && idOrIndex !== null) {
    const matches = (value: unknown) => value !== undefined && String(value) === String(idOrIndex);
    index = tracks.findIndex((track) => matches(serializeId(property(track, "id") ?? property(track, "trackID") ?? property(track, "trackId"))));
    if (index < 0) index = tracks.findIndex((track) => matches(property(track, "name")));
    if (index < 0) {
      const indices = await Promise.all(tracks.map((track, position) => readValue(track, "getIndex", "index").then((value) => value ?? position)));
      index = indices.findIndex(matches);
    }
  }
  return index >= 0 && tracks[index] ? { track: tracks[index], index } : undefined;
}

async function trackClipObjects(track: unknown) {
  const getTrackItems = property<Callable>(track, "getTrackItems");
  if (getTrackItems) {
    const constants = property(premiereModule(), "Constants") ?? property(premiereModule(), "constants");
    const clipType = property(property(constants, "TrackItemType"), "CLIP");
    if (clipType === undefined) unavailable("Premiere TrackItemType.CLIP");
    return await collectionItems(await maybePromise(getTrackItems.call(track, clipType, false)), true);
  }
  return await collectionItems(property(track, "clips"), true);
}

async function serializeClip(clip: unknown, sequence: unknown, mediaType: "video" | "audio", trackIndex: number, clipIndex: number) {
  if (!isObject(clip)) unavailable("Premiere clip object");
  const projectItem = await readValue(clip, "getProjectItem", "projectItem");
  const nativeId = serializeId(property(clip, "id") ?? property(clip, "nodeId") ?? property(clip, "nodeID"));
  const parentSequenceId = sequenceId(sequence);
  if (nativeId === undefined && parentSequenceId === undefined) unavailable("Premiere clip sequence ID");
  let isEnabled = booleanValue(await readValue(clip, "isEnabled", "enabled"));
  if (isEnabled === undefined) {
    const disabled = booleanValue(await readValue(clip, "isDisabled"));
    if (disabled !== undefined) isEnabled = !disabled;
  }
  return {
    id: nativeId ?? `${parentSequenceId}/${mediaType}/${trackIndex}/${clipIndex}`,
    idSource: nativeId === undefined ? "derived" : "native",
    name: asString(await readValue(clip, "getName", "name")) ?? asString(property(projectItem, "name")),
    projectItemId: await projectItemId(projectItem),
    mediaPath: asString(property(clip, "mediaPath")) ?? await projectItemMediaPath(projectItem) ?? asString(property(projectItem, "treePath")),
    start: serializeTime(await readValue(clip, "getStartTime", "start")),
    end: serializeTime(await readValue(clip, "getEndTime", "end")),
    inPoint: serializeTime(await readValue(clip, "getInPoint", "inPoint")),
    outPoint: serializeTime(await readValue(clip, "getOutPoint", "outPoint")),
    duration: serializeTime(await readValue(clip, "getDuration", "duration")),
    isEnabled,
    isSelected: booleanValue(await readValue(clip, "getIsSelected", "isSelected", "selected")),
    typename: asString(property(clip, "typename")) ?? asString(property(clip, "typeName"))
  };
}

async function markerCollection(sequence: unknown) {
  const api = property(premiereModule(), "Markers");
  const getMarkers = property<Callable>(api, "getMarkers");
  if (getMarkers) return await maybePromise(getMarkers.call(api, sequence));
  return property(sequence, "markers") ?? property(sequence, "markerCollection");
}

async function sequenceMarkers(sequence: unknown) {
  const markers = await markerCollection(sequence);
  const getMarkers = property<Callable>(markers, "getMarkers") ?? property<Callable>(sequence, "getMarkers");
  const items = getMarkers ? await collectionItems(await maybePromise(getMarkers.call(markers ?? sequence))) : await markerItems(markers);
  return (await Promise.all(items.map(serializeMarker))).filter((marker) => marker !== null);
}

async function createMarker(request: RpcRequest) {
  const sequence = await requireSequence(request.args?.[0]);
  const payload = isObject(request.args?.[1]) ? request.args?.[1] : {};
  const markers = await markerCollection(sequence);
  const createAction = property<Callable>(markers, "createAddMarkerAction");
  if (createAction) {
    const before = new Map<string, number>();
    for (const marker of await sequenceMarkers(sequence)) {
      const key = JSON.stringify(marker);
      before.set(key, (before.get(key) ?? 0) + 1);
    }
    const start = premiereTickTime(property(payload, "start") ?? property(payload, "time") ?? 0);
    const end = property(payload, "end");
    const durationValue = property(payload, "duration");
    let duration = premiereTickTime(durationValue ?? 0);
    if (durationValue === undefined && end !== undefined) {
      const endTime = premiereTickTime(end);
      const subtract = property<Callable>(endTime, "subtract");
      if (!subtract) unavailable("Premiere TickTime.subtract");
      duration = subtract.call(endTime, start);
    }
    if ((asNumber(property(duration, "seconds")) ?? 0) < 0) unavailable("Premiere marker duration");
    const markerType = asString(property(payload, "markerType") ?? property(payload, "marker_type"))
      ?? asString(property(property(premiereModule(), "Marker"), "MARKER_TYPE_COMMENT"));
    if (!markerType) unavailable("Premiere marker type");
    const action = () => createAction.call(markers, asString(property(payload, "name")) ?? "", markerType, start, duration,
      asString(property(payload, "comments") ?? property(payload, "comment")) ?? "");
    await executeProjectAction(await activeProject(), action, asString(request.options?.commandName) ?? "Create marker");
    for (const marker of await sequenceMarkers(sequence)) {
      const key = JSON.stringify(marker);
      const count = before.get(key) ?? 0;
      if (count === 0) return marker;
      before.set(key, count - 1);
    }
    unavailable("Premiere newly created marker");
  }
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

async function markerItems(markers: unknown): Promise<unknown[]> {
  const direct = await collectionItems(markers);
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

async function serializeMarker(marker: unknown) {
  if (!isObject(marker)) return null;
  return {
    id: serializeId(property(marker, "id") ?? property(marker, "guid") ?? property(marker, "markerID") ?? property(marker, "markerId")),
    name: asString(await readValue(marker, "getName", "name")),
    comments: asString(await readValue(marker, "getComments", "comments", "comment")),
    start: serializeTime(await readValue(marker, "getStart", "start", "time")),
    end: serializeTime(property(marker, "end")),
    duration: serializeTime(await readValue(marker, "getDuration", "duration")),
    markerType: asString(await readValue(marker, "getType", "markerType", "marker_type")),
    typename: asString(property(marker, "typename")) ?? asString(property(marker, "typeName"))
  };
}

async function encoderManager() {
  const encoderApi = property(premiereModule(), "EncoderManager") ?? property(premiereModule(), "encoderManager");
  if (!encoderApi) unavailable("Premiere EncoderManager");
  const getManager = property<Callable>(encoderApi, "getManager");
  const manager = getManager ? await maybePromise(getManager.call(encoderApi)) : encoderApi;
  if (!manager) unavailable("Premiere EncoderManager");
  return manager;
}

async function exporterApi() {
  const exporter = property(premiereModule(), "Exporter") ?? property(premiereModule(), "exporter");
  if (!exporter) unavailable("Premiere Exporter");
  return exporter;
}

function serializeEncoderManager(manager: unknown) {
  if (!isObject(manager)) return {};
  return {
    isAMEInstalled: booleanValue(property(manager, "isAMEInstalled")),
    typename: asString(property(manager, "typename")) ?? "EncoderManager"
  };
}

function serializeExporter(exporter: unknown) {
  if (!isObject(exporter)) return {};
  return {
    typename: asString(property(exporter, "typename")) ?? "Exporter"
  };
}

async function encoderPresets() {
  const manager = await encoderManager();
  const getPresets = property<Callable>(manager, "getPresets") ?? property<Callable>(manager, "getPresetList");
  const rawPresets = getPresets ? await maybePromise(getPresets.call(manager)) : property(manager, "presets");
  return (await collectionItems(rawPresets)).map(serializeEncoderPreset);
}

async function getExportFileExtension(request: RpcRequest) {
  const payload = requestPayload(request);
  const presetPath = requiredPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file"), "Premiere encoder preset file");
  const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
  const encoderApi = property(premiereModule(), "EncoderManager") ?? property(premiereModule(), "encoderManager");
  const manager = await encoderManager();
  const staticGetExtension = property<Callable>(encoderApi, "getExportFileExtension");
  const managerGetExtension = property<Callable>(manager, "getExportFileExtension");
  const getExtension = staticGetExtension ?? managerGetExtension;
  if (!getExtension) unavailable("Premiere EncoderManager.getExportFileExtension");
  return await maybePromise(getExtension.call(staticGetExtension ? encoderApi : manager, sequence, presetPath));
}

async function encodeFile(request: RpcRequest) {
  const payload = requestPayload(request);
  const sourcePath = requiredPath(
    property(payload, "sourcePath") ?? property(payload, "source_path") ?? property(payload, "filePath") ?? property(payload, "file_path") ?? property(payload, "inputPath") ?? property(payload, "input_path"),
    "Premiere encode source file"
  );
  const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"), "Premiere encode output file");
  const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
  const manager = await encoderManager();
  const encode = property<Callable>(manager, "encodeFile");
  if (!encode) unavailable("Premiere EncoderManager.encodeFile");
  const outPoint = property(payload, "outPoint") ?? property(payload, "out_point");
  const nativeOutPoint = outPoint === undefined ? property(property(premiereModule(), "TickTime"), "TIME_INVALID") : premiereTickTime(outPoint);
  if (!nativeOutPoint) unavailable("Premiere TickTime.TIME_INVALID");
  const result = await maybePromise(
    encode.call(
      manager,
      sourcePath,
      outputPath,
      presetPath,
      premiereTickTime(property(payload, "inPoint") ?? property(payload, "in_point") ?? 0),
      nativeOutPoint,
      asNumber(property(payload, "workArea") ?? property(payload, "work_area")) ?? 0,
      booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
      booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
    )
  );
  return serializeExportJob(result, { ...payload, sourcePath, outputPath, presetPath }, "encodeFile");
}

async function encodeProjectItem(request: RpcRequest) {
  const payload = requestPayload(request);
  const projectItemId =
    property(payload, "projectItem") ??
    property(payload, "project_item") ??
    property(payload, "projectItemId") ??
    property(payload, "project_item_id") ??
    property(payload, "sourceId") ??
    property(payload, "source_id");
  const projectItem = await castProjectItem(await requireProjectItem(projectItemId), "ClipProjectItem");
  if (!projectItem) unavailable("Premiere ClipProjectItem for encoder");
  const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"), "Premiere encode output file");
  const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
  const manager = await encoderManager();
  const encode = property<Callable>(manager, "encodeProjectItem");
  if (!encode) unavailable("Premiere EncoderManager.encodeProjectItem");
  const result = await maybePromise(
    encode.call(
      manager,
      projectItem,
      outputPath,
      presetPath,
      asNumber(property(payload, "workArea") ?? property(payload, "work_area")) ?? 0,
      booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
      booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
    )
  );
  return serializeExportJob(result, { ...payload, outputPath, presetPath }, "encodeProjectItem", projectItem);
}

async function exportSequence(request: RpcRequest) {
  const payload = requestPayload(request);
  const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
  const outputPath = optionalPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "outputFile") ?? property(payload, "output_file") ?? property(payload, "path"));
  const presetPath = optionalPath(property(payload, "presetPath") ?? property(payload, "preset_path") ?? property(payload, "presetFile") ?? property(payload, "preset_file") ?? property(payload, "preset"));
  const manager = await encoderManager();
  const exportSequenceMethod = property<Callable>(manager, "exportSequence");
  if (!exportSequenceMethod) unavailable("Premiere EncoderManager.exportSequence");
  const exportType = resolveExportType(property(payload, "exportType") ?? property(payload, "export_type"));
  const result = await maybePromise(
    exportSequenceMethod.call(
      manager,
      sequence,
      exportType,
      outputPath,
      presetPath,
      booleanValue(property(payload, "exportFull") ?? property(payload, "export_full")) ?? true,
      booleanValue(property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")) ?? true,
      booleanValue(property(payload, "startQueueImmediately") ?? property(payload, "start_queue_immediately")) ?? true
    )
  );
  return serializeExportJob(result, { ...payload, outputPath, presetPath, exportType: exportTypeName(exportType) }, "exportSequence", sequence);
}

async function exportFrame(request: RpcRequest) {
  const payload = requestPayload(request);
  const sequence = await requireSequence(property(payload, "sequence") ?? property(payload, "sequenceId") ?? property(payload, "sequence_id"));
  const outputPath = requiredPath(property(payload, "outputPath") ?? property(payload, "output_path") ?? property(payload, "filename") ?? property(payload, "path"), "Premiere frame output file");
  const exporter = await exporterApi();
  const exportSequenceFrame = property<Callable>(exporter, "exportSequenceFrame");
  if (!exportSequenceFrame) unavailable("Premiere Exporter.exportSequenceFrame");
  const outputDirectory = asString(property(payload, "filepath")) ?? asString(property(payload, "filePath")) ?? parentDirectory(outputPath);
  const result = await maybePromise(
    exportSequenceFrame.call(
      exporter,
      sequence,
      premiereTickTime(property(payload, "time") ?? property(payload, "tickTime") ?? property(payload, "tick_time") ?? 0),
      outputPath,
      outputDirectory,
      asNumber(property(payload, "width")),
      asNumber(property(payload, "height"))
    )
  );
  return serializeExportJob(result, { ...payload, outputPath }, "exportFrame", sequence);
}

function serializeEncoderPreset(preset: unknown) {
  if (!isObject(preset)) {
    const path = asString(preset);
    return {
      name: path?.split(/[\\/]/).filter(Boolean).pop() ?? path,
      path,
      format: undefined,
      extension: path?.split(".").pop(),
      typename: "EncoderPreset"
    };
  }
  const path = asString(property(preset, "path")) ?? asString(property(preset, "presetPath")) ?? asString(property(preset, "filePath"));
  return {
    name: asString(property(preset, "name")) ?? path?.split(/[\\/]/).filter(Boolean).pop(),
    path,
    format: asString(property(preset, "format")),
    extension: asString(property(preset, "extension")) ?? path?.split(".").pop(),
    typename: asString(property(preset, "typename")) ?? asString(property(preset, "typeName")) ?? "EncoderPreset"
  };
}

async function serializeExportJob(result: unknown, payload: Record<string, unknown>, kind: string, source?: unknown) {
  const resultObject = isObject(result) ? result : {};
  const resultJobId = property(resultObject, "jobId") ?? property(resultObject, "jobID") ?? property(resultObject, "id");
  const jobId = resultJobId ?? (typeof result === "string" || typeof result === "number" ? result : undefined);
  const started = typeof result === "boolean" ? result : booleanValue(property(resultObject, "started") ?? property(resultObject, "success") ?? property(resultObject, "ok"));
  return {
    id: jobId,
    jobId,
    status: asString(property(resultObject, "status")) ?? (started === false ? "failed" : kind === "exportFrame" ? "exported" : "queued"),
    outputPath: asString(property(resultObject, "outputPath")) ?? asString(property(resultObject, "outputFile")) ?? asString(property(payload, "outputPath")),
    presetPath: asString(property(resultObject, "presetPath")) ?? asString(property(resultObject, "presetFile")) ?? asString(property(payload, "presetPath")),
    sourceId: property(resultObject, "sourceId") ?? await projectItemId(source) ?? property(source, "id") ?? property(payload, "sourcePath"),
    sourceName: asString(property(resultObject, "sourceName")) ?? asString(property(source, "name")) ?? asString(property(payload, "sourcePath")),
    exportType: asString(property(resultObject, "exportType")) ?? asString(property(payload, "exportType")),
    removeUponCompletion: booleanValue(property(resultObject, "removeUponCompletion") ?? property(payload, "removeUponCompletion") ?? property(payload, "removeOnCompletion") ?? property(payload, "remove_on_completion")),
    started,
    typename: asString(property(resultObject, "typename")) ?? "ExportJob"
  };
}

function requestPayload(request: RpcRequest): Record<string, unknown> {
  const first = request.args?.[0];
  return isObject(first) ? first : {};
}

function requiredPath(value: unknown, label: string): string {
  const path = asString(value);
  if (!path) unavailable(label);
  return path;
}

function optionalPath(value: unknown): string | undefined {
  return asString(value);
}

function resolveExportType(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const name = asString(value);
  if (!name) return value;
  const exportTypes = property(property(premiereModule(), "constants"), "ExportType");
  return property(exportTypes, name) ?? property(exportTypes, name.toUpperCase()) ?? value;
}

function exportTypeName(value: unknown): string | undefined {
  const raw = asString(value);
  if (raw) return raw;
  if (value === undefined || value === null) return undefined;
  return String(value);
}

function parentDirectory(outputPath: string): string {
  const index = Math.max(outputPath.lastIndexOf("/"), outputPath.lastIndexOf("\\"));
  return index > 0 ? outputPath.slice(0, index + 1) : "";
}

async function serializeProjectItems(items: unknown[]) {
  return (await Promise.all(items.map(serializeProjectItem))).filter((item) => item !== null);
}

async function serializeProjectItem(item: unknown) {
  if (!isObject(item)) return null;
  const children = await projectItemChildObjects(item);
  const typename = asString(property(item, "typename")) ?? asString(property(item, "typeName"));
  const mediaPath = await projectItemMediaPath(item);
  const treePath = asString(property(item, "treePath")) ?? asString(property(item, "path"));
  const folder = await castProjectItem(item, "FolderItem");
  const clip = await castProjectItem(item, "ClipProjectItem");
  const isSequence = booleanValue(await readValue(clip ?? item, "isSequence"));
  const itemType = folder || property<Callable>(item, "getItems") ? "bin" : isSequence ? "sequence" : clip ? "clip" : projectItemType(item, children, typename, mediaPath);
  return {
    id: await projectItemId(item),
    name: asString(property(item, "name")),
    type: property(item, "type"),
    itemType,
    path: treePath ?? mediaPath,
    mediaPath,
    treePath,
    parentId: await projectItemId(await readValue(item, "getParentBin", "parent")),
    childCount: children.length,
    isBin: itemType === "bin",
    isClip: itemType === "clip",
    isSequence: itemType === "sequence",
    canProxy: booleanValue(await readValue(clip ?? item, "canProxy")),
    hasProxy: booleanValue(await readValue(clip ?? item, "hasProxy")),
    isOffline: booleanValue(await readValue(clip ?? item, "isOffline")),
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

async function projectItemId(item: unknown) {
  if (!item) return undefined;
  const direct = await readValue(item, "getId", "id", "guid", "nodeId", "nodeID");
  if (direct !== undefined && direct !== null) return serializeId(direct);
  const base = await castProjectItem(item, "ProjectItem");
  return serializeId(await readValue(base, "getId"));
}

async function projectItemMediaPath(item: unknown) {
  if (!item) return undefined;
  const direct = await readValue(item, "getMediaFilePath", "mediaPath");
  if (direct !== undefined) return asString(direct);
  const clip = await castProjectItem(item, "ClipProjectItem");
  if (!clip) return undefined;
  const getPath = property<Callable>(clip, "getMediaFilePath");
  if (!getPath) unavailable("Premiere ClipProjectItem.getMediaFilePath");
  return asString(await maybePromise(getPath.call(clip)));
}

async function castProjectItem(item: unknown, type: string) {
  const api = property(premiereModule(), type);
  const cast = property<Callable>(api, "cast");
  return cast && item ? await maybePromise(cast.call(api, item)) : undefined;
}

async function projectItemChildObjects(item: unknown): Promise<unknown[]> {
  if (!isObject(item)) unavailable("Premiere project item object");
  const direct = await readValue(item, "getItems", "getChildren", "children", "items");
  if (direct !== undefined && direct !== null) return await collectionItems(direct, true);
  const folder = await castProjectItem(item, "FolderItem");
  if (folder) {
    const getItems = property<Callable>(folder, "getItems");
    if (!getItems) unavailable("Premiere FolderItem.getItems");
    return await collectionItems(await maybePromise(getItems.call(folder)), true);
  }
  const clip = await castProjectItem(item, "ClipProjectItem");
  if (clip || await projectItemMediaPath(item) !== undefined || /clip|sequence/i.test(asString(property(item, "typename")) ?? asString(property(item, "itemType")) ?? "")) return [];
  unavailable("Premiere project item children");
}

async function findProjectItem(root: unknown, idOrName: unknown): Promise<unknown> {
  if (idOrName === undefined || idOrName === null) return root;
  const items = await collectProjectItems(root);
  const target = String(idOrName);
  for (const item of items) {
    const id = await projectItemId(item);
    if (id !== undefined && String(id) === target) return item;
  }
  for (const item of items) {
    const values = [property(item, "name"), property(item, "treePath"), property(item, "path"), await projectItemMediaPath(item)];
    if (values.some((value) => value !== undefined && String(value) === target)) return item;
  }
  return undefined;
}

async function collectProjectItems(root: unknown): Promise<unknown[]> {
  const result: unknown[] = [];
  const queue: unknown[] = root ? [root] : [];
  const seen = new Set<unknown>();
  const seenIds = new Set<string | number>();
  for (let index = 0; index < queue.length; index += 1) {
    const item = queue[index];
    if (!item || seen.has(item)) continue;
    seen.add(item);
    const id = await projectItemId(item);
    if (id !== undefined && seenIds.has(id)) continue;
    if (id !== undefined) seenIds.add(id);
    result.push(item);
    validateCollectionCount(result.length);
    for (const child of await projectItemChildObjects(item)) {
      if (seen.has(child)) continue;
      queue.push(child);
      validateCollectionCount(queue.length);
    }
  }
  return result;
}

async function findProjectItemsMatchingMediaPath(root: unknown, matchString: string): Promise<unknown[]> {
  const matches = [];
  for (const item of await collectProjectItems(root)) {
    const mediaPath = await projectItemMediaPath(item);
    if (mediaPath?.includes(matchString)) matches.push(item);
  }
  return matches;
}

async function findImportedProjectItems(filePaths: string[], root: unknown): Promise<unknown[]> {
  const candidates = await collectProjectItems(root);
  const mediaPaths = await Promise.all(candidates.map(projectItemMediaPath));
  const matches = [];
  for (const filePath of filePaths) {
    const index = mediaPaths.findIndex((path) => path?.replace(/\\/g, "/") === filePath.replace(/\\/g, "/"));
    if (index >= 0) matches.push(candidates[index]);
  }
  return matches;
}

function normalizeFilePaths(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => asString(item)).filter((item) => item !== undefined);
}

async function readValue(receiver: unknown, ...names: string[]): Promise<unknown> {
  for (const name of names) {
    const value = property(receiver, name);
    if (value !== undefined && value !== null) {
      return typeof value === "function" ? await maybePromise(value.call(receiver)) : value;
    }
  }
  return undefined;
}

function serializeId(value: unknown): string | number | undefined {
  if (typeof value === "string" || typeof value === "number") return value;
  if (value === undefined || value === null) return undefined;
  try {
    const toString = property<Callable>(value, "toString");
    if (typeof toString !== "function" || toString === Object.prototype.toString) return undefined;
    const converted = toString.call(value);
    // A native toString may return a Promise/thenable. An ID must be a scalar,
    // so drop it and swallow a possible rejection instead of leaking an
    // unhandled error into the RPC boundary.
    if (isThenable(converted)) {
      Promise.resolve(converted).catch(() => undefined);
      return undefined;
    }
    return typeof converted === "string" && converted.length > 0 && converted !== "[object Object]"
      ? converted
      : undefined;
  } catch {
    // ID is optional metadata. A throwing getter/toString on a native object
    // must be isolated rather than surfacing as an RPC error.
    return undefined;
  }
}

function validateCollectionCount(count: unknown): asserts count is number {
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) unavailable("Premiere collection count");
  if (count > COLLECTION_LIMIT) unavailable(`Premiere collection limit ${COLLECTION_LIMIT}`);
}

/**
 * Normalize a native Premiere collection into an array. UXP 25.6 collections
 * may be Promise/thenable values with asynchronous counts and asynchronous item
 * accessors, so the whole read path is awaited instead of treating a missing
 * synchronous `numItems` as "collection read unavailable".
 */
async function collectionItems(value: unknown, required = false): Promise<unknown[]> {
  return collectItems(await maybePromise(value), required);
}

async function collectItems(value: unknown, required: boolean): Promise<unknown[]> {
  if (Array.isArray(value)) {
    validateCollectionCount(value.length);
    return value;
  }
  const iterator = isObject(value) ? (value as unknown as Iterable<unknown>)[Symbol.iterator] : undefined;
  if (typeof iterator === "function") {
    const result: unknown[] = [];
    for (const item of value as Iterable<unknown>) {
      result.push(item);
      validateCollectionCount(result.length);
    }
    return result;
  }
  const count = await readCollectionCount(value);
  if (count === undefined) {
    if (required) unavailable("Premiere collection read");
    return [];
  }
  validateCollectionCount(count);
  const at = property<Callable>(value, "at") ?? property<Callable>(value, "getAt") ?? property<Callable>(value, "item");
  const result: unknown[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = await maybePromise(at ? at.call(value, index) : property(value, String(index)));
    if ((item === undefined || item === null) && required) unavailable(`Premiere collection item ${index}`);
    if (item !== undefined && item !== null) result.push(item);
  }
  return result;
}

async function readCollectionCount(value: unknown): Promise<number | undefined> {
  const countNames = ["numItems", "numTracks", "numMarkers", "length"];
  const methodNames = ["getNumItems", "getNumTracks", "getNumMarkers", "getItemCount", "getCount", "getLength"];
  try {
    for (const name of countNames) {
      const raw = property(value, name);
      if (raw === undefined || raw === null) continue;
      const resolved = typeof raw === "function"
        ? await maybePromise(raw.call(value))
        : await maybePromise(raw);
      const count = asNumber(resolved);
      if (count !== undefined) return count;
    }
    for (const name of methodNames) {
      const method = property<Callable>(value, name);
      if (typeof method !== "function") continue;
      const count = asNumber(await maybePromise(method.call(value)));
      if (count !== undefined) return count;
    }
  } catch {
    // A rejecting/throw-ing native count getter is not a synchronously readable
    // collection; do not turn it into an unhandled RPC error.
    return undefined;
  }
  return undefined;
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
