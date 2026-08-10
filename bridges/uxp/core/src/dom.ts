import { BridgeRpcError, ERROR_HOST_SCRIPT, methodNotFound } from "./errors";
import type { RpcRequest } from "./protocol";
import { asString, isObject, maybePromise, property } from "./runtime";

const REFERENCE_KEY = "$adobepyRef";
const TYPE_KEY = "$adobepyType";
const BLOCKED_MEMBERS = new Set(["__proto__", "constructor", "prototype"]);

type DomRootResolver = (name: string) => unknown;
type DomMutationRunner = (
  request: RpcRequest,
  defaultCommandName: string,
  operation: () => Promise<unknown>,
) => Promise<unknown>;

export interface DomRuntimeOptions {
  roots: DomRootResolver;
  runMutation?: DomMutationRunner;
}

/**
 * Structured access to an official UXP host object model.
 *
 * The runtime deliberately exchanges opaque object references instead of
 * evaluating caller-provided JavaScript. This keeps the complete, versioned
 * Adobe DOM reachable while preserving JSON-RPC, authentication, target, and
 * command-boundary contracts.
 */
export class DomRuntime {
  private readonly references = new Map<string, unknown>();
  private readonly reverseReferences = new WeakMap<object, string>();
  private nextReference = 1;

  constructor(private readonly options: DomRuntimeOptions) {}

  async dispatch(request: RpcRequest): Promise<unknown> {
    if (request.namespace !== "dom") {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `invalid DOM namespace ${request.namespace}`);
    }

    if (request.method === "root") {
      const name = requiredString(request.args?.[0], "root name");
      const value = this.options.roots(name);
      if (value === undefined || value === null) {
        throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM root '${name}' is unavailable`);
      }
      return this.encode(value);
    }

    if (request.method === "get") {
      const receiver = this.resolve(request.args?.[0]);
      const member = requiredMember(request.args?.[1]);
      return this.encode(await maybePromise(readMember(receiver, member)));
    }

    if (request.method === "set") {
      return this.runMutation(request, "Set official DOM property", async () => {
        const receiver = this.resolve(request.args?.[0]);
        const member = requiredMember(request.args?.[1]);
        const value = this.decode(request.args?.[2]);
        writeMember(receiver, member, value);
        return this.encode(await maybePromise(readMember(receiver, member)));
      });
    }

    if (request.method === "call") {
      const operation = async () => {
        const receiver = this.resolve(request.args?.[0]);
        const member = requiredMember(request.args?.[1]);
        const callable = readMember(receiver, member);
        if (typeof callable !== "function") {
          throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${String(member)}' is not callable`);
        }
        const args = this.decodeArgs(request.args?.[2]);
        return this.encode(await maybePromise(callable.apply(receiver, args)));
      };
      if (request.options?.modal === true || typeof request.options?.commandName === "string") {
        return this.runMutation(request, `Call official DOM method ${String(request.args?.[1] ?? "")}`, operation);
      }
      return operation();
    }

    if (request.method === "construct") {
      return this.runMutation(request, "Construct official DOM object", async () => {
        const receiver = this.resolve(request.args?.[0]);
        const member = requiredMember(request.args?.[1]);
        const constructor = readMember(receiver, member);
        if (typeof constructor !== "function") {
          throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${String(member)}' is not a constructor`);
        }
        return this.encode(Reflect.construct(constructor, this.decodeArgs(request.args?.[2])));
      });
    }

    if (request.method === "keys") {
      return collectKeys(this.resolve(request.args?.[0]));
    }

    if (request.method === "snapshot") {
      const receiver = this.resolve(request.args?.[0]);
      const requested = request.args?.[1];
      const members = Array.isArray(requested)
        ? requested.map(requiredMember)
        : collectSnapshotKeys(receiver);
      const snapshot: Record<string, unknown> = {};
      for (const member of members) {
        try {
          const value = await maybePromise(readMember(receiver, member));
          if (typeof value !== "function") snapshot[String(member)] = this.encode(value);
        } catch (error) {
          snapshot[String(member)] = {
            $adobepyError: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return snapshot;
    }

    if (request.method === "release") {
      const reference = referenceId(request.args?.[0]);
      const value = this.references.get(reference);
      if ((typeof value === "object" && value !== null) || typeof value === "function") {
        this.reverseReferences.delete(value as object);
      }
      return this.references.delete(reference);
    }

    methodNotFound("dom", request.method);
  }

  private async runMutation(
    request: RpcRequest,
    defaultCommandName: string,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.options.runMutation) {
      return this.options.runMutation(request, defaultCommandName, operation);
    }
    return operation();
  }

  private encode(value: unknown): unknown {
    if (value === undefined || value === null) return null;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "symbol") return value.description ?? value.toString();
    if (Array.isArray(value)) return value.map((item) => this.encode(item));

    const objectValue = value as object;
    const existing = this.reverseReferences.get(objectValue);
    if (existing) {
      return {
        [REFERENCE_KEY]: existing,
        [TYPE_KEY]: domTypeName(value),
      };
    }

    const reference = `uxp_${this.nextReference++}`;
    this.references.set(reference, value);
    this.reverseReferences.set(objectValue, reference);
    return {
      [REFERENCE_KEY]: reference,
      [TYPE_KEY]: domTypeName(value),
    };
  }

  private decode(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.decode(item));
    if (!isObject(value)) return value;
    if (typeof value[REFERENCE_KEY] === "string") return this.resolve(value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.decode(item)]));
  }

  private decodeArgs(value: unknown): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, "official DOM call arguments must be an array");
    }
    return value.map((item) => this.decode(item));
  }

  private resolve(value: unknown): unknown {
    const reference = referenceId(value);
    if (!this.references.has(reference)) {
      throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM reference '${reference}' is stale or unknown`);
    }
    return this.references.get(reference);
  }
}

function referenceId(value: unknown): string {
  const reference = isObject(value) ? value[REFERENCE_KEY] : undefined;
  if (typeof reference !== "string" || reference.length === 0) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `expected an object containing '${REFERENCE_KEY}'`);
  }
  return reference;
}

function requiredString(value: unknown, label: string): string {
  const result = asString(value);
  if (!result) throw new BridgeRpcError(ERROR_HOST_SCRIPT, `${label} is required`);
  return result;
}

function requiredMember(value: unknown): string | number {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, "official DOM member must be a string or array index");
  }
  if (typeof value === "string" && BLOCKED_MEMBERS.has(value)) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `official DOM member '${value}' is not accessible`);
  }
  return value;
}

function readMember(receiver: unknown, member: string | number): unknown {
  if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `cannot read '${String(member)}' from a primitive value`);
  }
  return (receiver as Record<string | number, unknown>)[member];
}

function writeMember(receiver: unknown, member: string | number, value: unknown): void {
  if ((typeof receiver !== "object" && typeof receiver !== "function") || receiver === null) {
    throw new BridgeRpcError(ERROR_HOST_SCRIPT, `cannot write '${String(member)}' on a primitive value`);
  }
  (receiver as Record<string | number, unknown>)[member] = value;
}

function collectKeys(value: unknown): string[] {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
  const keys = new Set<string>();
  let current: object | null = value as object;
  for (let depth = 0; current && depth < 8; depth += 1) {
    try {
      for (const key of Object.getOwnPropertyNames(current)) {
        if (!BLOCKED_MEMBERS.has(key) && key !== "constructor") keys.add(key);
      }
      current = Object.getPrototypeOf(current);
    } catch {
      break;
    }
  }
  return Array.from(keys).sort();
}

function collectSnapshotKeys(value: unknown): string[] {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return [];
  try {
    return Object.keys(value).filter((key) => !BLOCKED_MEMBERS.has(key)).sort();
  } catch {
    return [];
  }
}

function domTypeName(value: unknown): string {
  if (typeof value === "function") return value.name || "Function";
  if (!isObject(value)) return typeof value;
  const typename = asString(property(value, "typename")) ?? asString(property(value, "typeName"));
  if (typename) return typename;
  const constructor = property<{ name?: unknown }>(value, "constructor");
  return asString(constructor?.name) ?? "Object";
}
