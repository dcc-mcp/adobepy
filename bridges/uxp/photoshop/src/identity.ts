import type { BridgeIdentityClaim, HostIdentityClaim } from "../../core/src/protocol";
import { asString, isObject, maybePromise, optionalRequire, property } from "../../core/src/runtime";

type Callable = (...args: unknown[]) => unknown;

let bridgeInstanceId: string | undefined;
const loadedModuleSource = currentModuleSource();

export async function photoshopRuntimeIdentity(): Promise<BridgeIdentityClaim> {
  const pluginRoot = await installedPluginRoot();
  const moduleOrigin = moduleOriginFor(pluginRoot);
  return {
    host: {
      ...externalHostIdentity(),
      hostVersion: photoshopHostVersion()
    },
    bridge: {
      instanceId: runtimeInstanceId(),
      ...(pluginRoot && moduleOrigin
        ? {
            installedPluginRoot: pluginRoot,
            moduleOrigin
          }
        : {})
    }
  };
}

function currentModuleSource(): string | undefined {
  const documentValue = (globalThis as { document?: unknown }).document;
  const currentScript = property(documentValue, "currentScript");
  return asString(property(currentScript, "src"));
}

function moduleOriginFor(pluginRoot: string | undefined): string | undefined {
  const source = loadedModuleSource;
  if (!source) return undefined;
  if (source.startsWith("plugin:/") && pluginRoot) {
    const relativePath = source.slice("plugin:/".length);
    if (!relativePath || relativePath.split("/").some((part) => part === "." || part === "..")) return undefined;
    return absolutePath(`${pluginRoot}/${relativePath}`);
  }
  if (!/^file:\/\//i.test(source)) return absolutePath(source);
  try {
    let path = decodeURI(source).replace(/^file:\/\//i, "");
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    return absolutePath(path);
  } catch {
    return undefined;
  }
}

function externalHostIdentity(): HostIdentityClaim {
  const configured = (globalThis as { __ADOBEPY_HOST_IDENTITY?: unknown }).__ADOBEPY_HOST_IDENTITY;
  if (!isObject(configured)) return {};
  const pid = property(configured, "pid");
  const processStartIdentity = boundedString(property(configured, "processStartIdentity"), 256, /^[A-Za-z0-9:_.-]+$/);
  const executablePath = absolutePath(property(configured, "executablePath"));
  const profileId = boundedString(property(configured, "profileId"), 256);
  return {
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff ? { pid } : {}),
    ...(processStartIdentity ? { processStartIdentity } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(profileId ? { profileId } : {})
  };
}

function photoshopHostVersion(): string | undefined {
  const uxp = optionalRequire("uxp");
  return boundedString(property(property(uxp, "host"), "version"), 64);
}

async function installedPluginRoot(): Promise<string | undefined> {
  const localFileSystem = property(property(optionalRequire("uxp"), "storage"), "localFileSystem");
  const getPluginFolder = property<Callable>(localFileSystem, "getPluginFolder");
  if (!getPluginFolder) return undefined;
  const folder = await maybePromise(getPluginFolder.call(localFileSystem));
  const nativePath = absolutePath(property(folder, "nativePath"));
  if (nativePath) return nativePath;
  const getNativePath = property<Callable>(localFileSystem, "getNativePath");
  return getNativePath ? absolutePath(await maybePromise(getNativePath.call(localFileSystem, folder))) : undefined;
}

function runtimeInstanceId(): string | undefined {
  if (bridgeInstanceId) return bridgeInstanceId;
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  const candidate = cryptoApi?.randomUUID?.();
  if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    bridgeInstanceId = candidate.toLowerCase();
  }
  return bridgeInstanceId;
}

function boundedString(value: unknown, limit: number, pattern?: RegExp): string | undefined {
  const text = asString(value);
  if (!text || text.trim() !== text || utf8Length(text) > limit || /[\u0000-\u001f\u007f]/.test(text)) {
    return undefined;
  }
  return pattern && !pattern.test(text) ? undefined : text;
}

function utf8Length(value: string): number {
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    length += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
  }
  return length;
}

function absolutePath(value: unknown): string | undefined {
  const text = boundedString(value, 32768);
  if (!text) return undefined;
  const normalized = text.replace(/\\/g, "/");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split("/").some((component) => component === "." || component === "..")) return undefined;
  return text.replace(/[\\/]+$/, "");
}
