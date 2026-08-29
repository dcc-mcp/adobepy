import type { BridgeIdentityClaim, HostIdentityClaim } from "../../core/src/protocol";

let bridgeInstanceId: string | undefined;

/** Return only bounded, host-observable identity; no commands or JSX are accepted. */
export function afterEffectsRuntimeIdentity(): BridgeIdentityClaim {
  const cep = (globalThis as any).__adobe_cep__;
  const pluginRoot = absolutePath(cep?.getSystemPath?.("extension"));
  const hostVersion = configuredHostVersion();
  return {
    host: { ...externalHostIdentity(), ...(hostVersion ? { hostVersion } : {}) },
    bridge: {
      ...(bridgeInstanceIdValue() ? { instanceId: bridgeInstanceIdValue() } : {}),
      ...(pluginRoot ? { installedPluginRoot: pluginRoot, moduleOrigin: `${pluginRoot}/dist/main.js` } : {})
    }
  };
}

function externalHostIdentity(): HostIdentityClaim {
  const configured = (globalThis as { __ADOBEPY_HOST_IDENTITY?: unknown }).__ADOBEPY_HOST_IDENTITY;
  if (!configured || typeof configured !== "object") return {};
  const value = configured as Record<string, unknown>;
  const pid = value.pid;
  const processStartIdentity = bounded(value.processStartIdentity, 256, /^[A-Za-z0-9:_.-]+$/);
  const executablePath = absolutePath(value.executablePath);
  const profileId = bounded(value.profileId, 256);
  return {
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff ? { pid } : {}),
    ...(processStartIdentity ? { processStartIdentity } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(profileId ? { profileId } : {})
  };
}

function configuredHostVersion(): string | undefined {
  const configured = (globalThis as { __ADOBEPY_HOST_IDENTITY?: unknown }).__ADOBEPY_HOST_IDENTITY;
  if (!configured || typeof configured !== "object") return undefined;
  return bounded((configured as Record<string, unknown>).hostVersion, 64, /^\S+$/);
}

function bridgeInstanceIdValue(): string | undefined {
  if (bridgeInstanceId) return bridgeInstanceId;
  const candidate = (globalThis.crypto as Crypto | undefined)?.randomUUID?.();
  if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) bridgeInstanceId = candidate.toLowerCase();
  return bridgeInstanceId;
}

function bounded(value: unknown, limit: number, pattern?: RegExp): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value || utf8Length(value) > limit || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return !pattern || pattern.test(value) ? value : undefined;
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
  const text = bounded(value, 32768);
  if (!text) return undefined;
  const normalized = text.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split("/").some((component) => component === "." || component === "..")) return undefined;
  return normalized;
}
