export type HostObject = Record<string, unknown>;

declare const require: ((name: string) => unknown) | undefined;

export function optionalRequire(moduleName: string): HostObject | undefined {
  const loader = (globalThis as { require?: (name: string) => unknown }).require ?? require;
  if (typeof loader !== "function") return undefined;
  try {
    const loaded = loader(moduleName);
    return isObject(loaded) ? loaded : undefined;
  } catch {
    return undefined;
  }
}

export function isObject(value: unknown): value is HostObject {
  return typeof value === "object" && value !== null;
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  const iterable = value as unknown as Iterable<unknown>;
  if (typeof iterable[Symbol.iterator] === "function") return Array.from(iterable);
  const length = value.length;
  if (typeof length === "number") {
    return Array.from({ length }, (_, index) => (value as Record<number, unknown>)[index]).filter((item) => item !== undefined);
  }
  return [];
}

export function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (isObject(value) && typeof value.valueOf === "function") {
    const converted = value.valueOf();
    if (typeof converted === "number") return converted;
  }
  return undefined;
}

/**
 * Members that must never be reachable through a host object read. They are the
 * JavaScript prototype-chain escape hatches, not Adobe DOM capabilities.
 */
export const BLOCKED_MEMBERS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Bounded member access for native/host objects. The prototype chain is not a
 * capability surface: blocked names are denied for every receiver, and function
 * receivers are limited to their own properties so `Function.prototype` (and
 * from there `Function`/`Object` constructors) cannot be traversed. Regular
 * object receivers still reach prototype methods, which the UXP DOM legitimately
 * exposes.
 */
export function readMember<T = unknown>(value: unknown, name: string | number): T | undefined {
  if ((!isObject(value) && typeof value !== "function") || BLOCKED_MEMBERS.has(String(name))) {
    return undefined;
  }
  if (typeof value === "function" && !Object.prototype.hasOwnProperty.call(value, name)) {
    return undefined;
  }
  return (value as HostObject)[name as string] as T | undefined;
}

export function property<T = unknown>(value: unknown, name: string): T | undefined {
  return readMember<T>(value, name);
}

export async function maybePromise<T>(value: T | Promise<T>): Promise<T> {
  return await value;
}

export function fileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function toFileUrl(path: string): string {
  if (/^file:\/\//i.test(path)) return path;
  const normalized = path.replace(/\\/g, "/");
  // UXP's FileSystemProvider expects a native file URL string. Percent-encoded
  // segments are treated as literal filename characters by createEntryWithUrl.
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
  if (normalized.startsWith("/")) return `file://${normalized}`;
  return normalized;
}

export async function evalJavaScript(source: string, args: unknown[]): Promise<unknown> {
  try {
    return await (0, eval)(source);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    const fn = new Function("args", source);
    return await fn(args);
  }
}
