import { toSerializable } from "./serialize";

type PluginApiAction = "get" | "call" | "set" | "indexGet" | "indexSet" | "globalGet" | "callback" | "callbackEvents";
type PluginApiPayload = {
  action: PluginApiAction;
  path?: string;
  args?: unknown[];
  value?: unknown;
  target?: unknown;
  code?: string;
  returnValue?: unknown;
  callbackHandle?: string;
  clear?: boolean;
};

const BLOCKED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function segments(path: string): string[] {
  const normalized = path.startsWith("figma.") ? path.slice("figma.".length) : path;
  const values = normalized.split(".").filter(Boolean);
  if (values.length === 0) throw new Error("Plugin API path is required");
  if (values.some((value) => BLOCKED_SEGMENTS.has(value))) {
    throw new Error("Plugin API path contains a forbidden segment");
  }
  return values;
}

function resolvePath(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of segments(path)) {
    if (current === null || current === undefined) {
      throw new Error(`Plugin API path is unavailable: ${path}`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveOwner(root: unknown, path: string): { owner: Record<string, unknown>; key: string } {
  const values = segments(path);
  const key = values.pop()!;
  let owner = root;
  for (const segment of values) {
    if (owner === null || owner === undefined) {
      throw new Error(`Plugin API path is unavailable: ${path}`);
    }
    owner = (owner as Record<string, unknown>)[segment];
  }
  if ((typeof owner !== "object" && typeof owner !== "function") || owner === null) {
    throw new Error(`Plugin API path has no callable owner: ${path}`);
  }
  return { owner: owner as Record<string, unknown>, key };
}

export class PluginApiDispatcher {
  private readonly handles = new Map<string, unknown>();
  private readonly handleIds = new WeakMap<object, string>();
  private nextHandle = 1;
  private readonly callbackEvents = new Map<string, unknown[][]>();

  constructor(
    private readonly root: PluginAPI,
    private readonly globals: Record<string, unknown> = {},
  ) {}

  private remember(value: object): string {
    const existing = this.handleIds.get(value);
    if (existing && this.handles.has(existing)) return existing;
    const id = `h${this.nextHandle++}`;
    this.handles.set(id, value);
    this.handleIds.set(value, id);
    return id;
  }

  private serialize(value: unknown, seen = new Set<unknown>(), depth = 0): unknown {
    if (value === null || value === undefined || typeof value === "string" ||
        typeof value === "number" || typeof value === "boolean") return value ?? null;
    if (typeof value === "symbol") return value === this.root.mixed ? { $figma: "mixed" } : String(value);
    if (typeof value === "function") {
      return { $handle: this.remember(value), $type: "function" };
    }
    if (depth > 40) return "[max-depth]";
    const object = value as object;
    const handle = this.remember(object);
    if (value instanceof Uint8Array) {
      return { ...toSerializable(value) as Record<string, unknown>, $handle: handle };
    }
    if (seen.has(value)) return { $handle: handle };
    seen.add(value);
    if (Array.isArray(value)) {
      const result = value.map((item) => this.serialize(item, seen, depth + 1));
      seen.delete(value);
      return result;
    }
    const result: Record<string, unknown> = { $handle: handle };
    for (const key of Object.keys(value as Record<string, unknown>)) {
      try {
        const item = this.serialize((value as Record<string, unknown>)[key], seen, depth + 1);
        if (item !== undefined) result[key] = item;
      } catch {
        // Some host object getters are unavailable in the current editor or mode.
      }
    }
    seen.delete(value);
    return result;
  }

  private async resolveValue(value: unknown): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => this.resolveValue(item)));
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && typeof record.$handle === "string") {
      if (!this.handles.has(record.$handle)) {
        throw new Error(`Unknown or expired Plugin API handle: ${record.$handle}`);
      }
      return this.handles.get(record.$handle);
    }
    if (keys.length === 1 && typeof record.$figma === "string") {
      return resolvePath(this.root, record.$figma);
    }
    if (keys.length === 1 && typeof record.$node === "string") {
      const node = await this.root.getNodeByIdAsync(record.$node);
      if (!node) throw new Error(`Node not found: ${record.$node}`);
      return node;
    }
    if (keys.length === 1 && typeof record.$base64 === "string") {
      return this.root.base64Decode(record.$base64);
    }
    if (keys.length === 1 && record.$undefined === true) return undefined;
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(record)) resolved[key] = await this.resolveValue(item);
    return resolved;
  }

  async dispatch(payload: PluginApiPayload): Promise<unknown> {
    if (payload.action === "callback") {
      let callback: (...args: unknown[]) => unknown;
      if (payload.code) {
        const factory = new Function(
          "figma", "event", "args", "serialize", `"use strict";\n${payload.code}`,
        ) as (figmaApi: PluginAPI, event: unknown, args: unknown[], serialize: typeof toSerializable) => unknown;
        callback = (...args: unknown[]) => factory(this.root, args[0], args, toSerializable);
      } else {
        callback = (...args: unknown[]) => {
          const id = this.handleIds.get(callback);
          if (id) this.callbackEvents.get(id)?.push(args);
          return payload.returnValue;
        };
      }
      const serialized = this.serialize(callback) as { $handle: string };
      this.callbackEvents.set(serialized.$handle, []);
      return serialized;
    }
    if (payload.action === "callbackEvents") {
      const id = String(payload.callbackHandle || "");
      if (!this.handles.has(id) || !this.callbackEvents.has(id)) throw new Error(`Unknown callback handle: ${id}`);
      const events = this.callbackEvents.get(id)!;
      const result = events.map((args) => this.serialize(args));
      if (payload.clear !== false) events.length = 0;
      return result;
    }

    const path = String(payload.path || "");
    if (payload.action === "globalGet") return this.serialize(resolvePath(this.globals, path));
    const target = payload.target === undefined ? this.root : await this.resolveValue(payload.target);
    if (payload.action === "indexGet" || payload.action === "indexSet") {
      if ((typeof target !== "object" && typeof target !== "function") || target === null) {
        throw new Error("Plugin API index target is not an object");
      }
      const key = String(payload.path || "");
      if (!key || BLOCKED_SEGMENTS.has(key)) throw new Error("Plugin API index key is missing or forbidden");
      const record = target as Record<string, unknown>;
      if (payload.action === "indexGet") return this.serialize(record[key]);
      record[key] = await this.resolveValue(payload.value);
      return this.serialize(record[key]);
    }
    if (payload.action === "get") return this.serialize(resolvePath(target, path));

    const { owner, key } = resolveOwner(target, path);
    if (payload.action === "call") {
      const method = owner[key];
      if (typeof method !== "function") throw new Error(`Plugin API path is not callable: ${path}`);
      const args = await this.resolveValue(payload.args || []) as unknown[];
      return this.serialize(await method.apply(owner, args));
    }

    if (payload.action === "set") {
      owner[key] = await this.resolveValue(payload.value);
      return this.serialize(owner[key]);
    }

    throw new Error(`Unsupported Plugin API action: ${String(payload.action)}`);
  }
}
