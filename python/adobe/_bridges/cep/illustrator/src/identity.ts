import type { BridgeIdentityClaim, HostIdentityClaim } from "../../core/src/protocol";

let bridgeInstanceId: string | undefined;

export async function illustratorRuntimeIdentity(): Promise<BridgeIdentityClaim> {
  const cep = (globalThis as any).__adobe_cep__;
  const pluginRoot = absolutePath(cep?.getSystemPath?.("extension"));
  const hostVersion = await illustratorHostVersion(cep);
  const instanceId = runtimeInstanceId();
  return {
    host: {
      ...externalHostIdentity(),
      ...(hostVersion ? { hostVersion } : {})
    },
    bridge: {
      ...(instanceId ? { instanceId } : {}),
      ...(pluginRoot
        ? {
            installedPluginRoot: pluginRoot,
            moduleOrigin: `${pluginRoot}/dist/main.js`
          }
        : {})
    }
  };
}

function externalHostIdentity(): HostIdentityClaim {
  const configured = (globalThis as { __ADOBEPY_HOST_IDENTITY?: unknown }).__ADOBEPY_HOST_IDENTITY;
  if (!isObject(configured)) return {};
  const pid = configured.pid;
  const processStartIdentity = boundedString(configured.processStartIdentity, 256, /^[A-Za-z0-9:_.-]+$/);
  const executablePath = absolutePath(configured.executablePath);
  const profileId = boundedString(configured.profileId, 256);
  return {
    ...(typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && pid <= 0xffffffff ? { pid } : {}),
    ...(processStartIdentity ? { processStartIdentity } : {}),
    ...(executablePath ? { executablePath } : {}),
    ...(profileId ? { profileId } : {})
  };
}

function illustratorHostVersion(cep: any): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    if (!cep || typeof cep.evalScript !== "function") {
      finish(undefined);
      return;
    }
    const timer = setTimeout(() => finish(undefined), 1_000);
    try {
      cep.evalScript('typeof app === "object" ? String(app.version) : ""', (value: unknown) => {
        clearTimeout(timer);
        finish(boundedString(value, 64));
      });
    } catch {
      clearTimeout(timer);
      finish(undefined);
    }
  });
}

function runtimeInstanceId(): string | undefined {
  if (bridgeInstanceId) return bridgeInstanceId;
  const cryptoApi = (globalThis as {
    crypto?: { randomUUID?: () => string; getRandomValues?: (values: Uint8Array) => Uint8Array };
  }).crypto;
  let candidate = cryptoApi?.randomUUID?.();
  if (!candidate && cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    candidate = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  if (candidate && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate)) {
    bridgeInstanceId = candidate.toLowerCase();
  }
  return bridgeInstanceId;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function boundedString(value: unknown, limit: number, pattern?: RegExp): string | undefined {
  if (typeof value !== "string" || !value || value.trim() !== value || utf8Length(value) > limit || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return pattern && !pattern.test(value) ? undefined : value;
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
  const normalized = text.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized)) return undefined;
  if (normalized.split("/").some((component) => component === "." || component === "..")) return undefined;
  return normalized;
}
