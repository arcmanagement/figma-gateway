import {
  PLUGIN_API_CATALOG,
  PLUGIN_API_COMMAND_COUNT,
  PLUGIN_API_DECLARATION_COUNT,
  PLUGIN_API_INTERFACE_COUNT,
  PLUGIN_API_GLOBAL_COUNT,
  PLUGIN_API_INTERFACE_DECLARATION_COUNT,
  PLUGIN_API_TYPINGS_VERSION,
} from "../generated/plugin-api-catalog.js";
import type { PluginApiCatalogEntry, PluginApiSignature } from "./plugin-api-catalog-types.js";

export {
  PLUGIN_API_CATALOG,
  PLUGIN_API_COMMAND_COUNT,
  PLUGIN_API_DECLARATION_COUNT,
  PLUGIN_API_INTERFACE_COUNT,
  PLUGIN_API_GLOBAL_COUNT,
  PLUGIN_API_INTERFACE_DECLARATION_COUNT,
  PLUGIN_API_TYPINGS_VERSION,
};

const entries = new Map<string, PluginApiCatalogEntry>(
  PLUGIN_API_CATALOG.map((entry) => [entry.id, entry]),
);

export type PluginApiInvocationInput = {
  apiId: string;
  params?: unknown;
  args?: unknown;
  target?: unknown;
  value?: unknown;
  hasValue?: boolean;
  key?: string;
  overload?: number;
  confirm?: boolean;
};

export type PluginApiInvocation = {
  entry: PluginApiCatalogEntry;
  operation: "get" | "call" | "set" | "indexGet" | "indexSet" | "globalGet";
  path: string;
  args?: unknown[];
  target?: unknown;
  value?: unknown;
};

export function pluginApiEntry(apiId: string): PluginApiCatalogEntry {
  const entry = entries.get(apiId);
  if (!entry) throw new Error(`Unknown Plugin API command: ${apiId}. Use \"plugin api list\" to inspect commands.`);
  return entry;
}

function matches(signature: PluginApiSignature, params: Record<string, unknown>): boolean {
  const names = new Set(signature.parameters.map((parameter) => parameter.name));
  if (Object.keys(params).some((name) => !names.has(name))) return false;
  return signature.parameters.every((parameter) => parameter.optional || parameter.rest || parameter.name in params);
}

function namedArguments(entry: PluginApiCatalogEntry, params: unknown, overload?: number): unknown[] {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new Error(`${entry.id} --params must be a JSON object keyed by the documented parameter names`);
  }
  const record = params as Record<string, unknown>;
  let signature: PluginApiSignature | undefined;
  if (overload !== undefined) {
    if (!Number.isInteger(overload) || overload < 1 || overload > entry.signatures.length) {
      throw new Error(`${entry.id} --overload must be between 1 and ${entry.signatures.length}`);
    }
    signature = entry.signatures[overload - 1];
    if (!matches(signature!, record)) throw new Error(`${entry.id} parameters do not match overload ${overload}`);
  } else {
    const candidates = entry.signatures.filter((candidate) => matches(candidate, record));
    if (candidates.length === 0) {
      throw new Error(`${entry.id} parameters do not match any declared overload; use \"plugin api describe ${entry.id}\"`);
    }
    signature = candidates[0];
  }
  const result: unknown[] = [];
  for (const parameter of signature.parameters) {
    if (parameter.rest) {
      const values = record[parameter.name];
      if (values === undefined) continue;
      if (!Array.isArray(values)) throw new Error(`${entry.id} parameter ${parameter.name} must be an array`);
      result.push(...values);
      continue;
    }
    result.push(parameter.name in record ? record[parameter.name] : { $undefined: true });
  }
  while (result.length && isUndefinedMarker(result.at(-1))) result.pop();
  return result;
}

function isUndefinedMarker(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value as object).length === 1 && (value as { $undefined?: unknown }).$undefined === true);
}

export function resolvePluginApiInvocation(input: PluginApiInvocationInput): PluginApiInvocation {
  const entry = pluginApiEntry(input.apiId);
  if (entry.targetRequired && input.target === undefined) {
    throw new Error(`${entry.id} operates on ${entry.interface}; --target with a Plugin API handle is required`);
  }
  if (!entry.targetRequired && input.target !== undefined) {
    throw new Error(`${entry.id} has the fixed receiver ${entry.receiver === "" ? "figma" : entry.receiver}; --target is not accepted`);
  }
  const target = input.target;
  const path = target === undefined ? entry.path : entry.member;
  if (entry.receiver === "$global") {
    if (input.hasValue || input.params !== undefined || input.args !== undefined || input.target !== undefined) {
      throw new Error(`${entry.id} is a readonly global property`);
    }
    return { entry, operation: "globalGet", path };
  }
  if (entry.kind === "method") {
    if (input.hasValue) throw new Error(`${entry.id} is callable and does not accept --value`);
    if (input.confirm !== true) throw new Error(`${entry.id} requires --confirm`);
    let args: unknown[];
    if (input.args !== undefined) {
      if (!Array.isArray(input.args)) throw new Error(`${entry.id} --args must be a JSON array`);
      args = input.args;
    } else {
      args = namedArguments(entry, input.params ?? {}, input.overload);
    }
    return { entry, operation: "call", path, args, ...(target === undefined ? {} : { target }) };
  }
  if (entry.kind === "index") {
    if (!input.key) throw new Error(`${entry.id} requires --key`);
    if (input.hasValue) {
      if (entry.readonly) throw new Error(`${entry.id} is readonly`);
      if (input.confirm !== true) throw new Error(`${entry.id} requires --confirm when setting a value`);
      return { entry, operation: "indexSet", path: input.key, value: input.value, target };
    }
    return { entry, operation: "indexGet", path: input.key, target };
  }
  if (input.hasValue) {
    if (entry.readonly) throw new Error(`${entry.id} is readonly`);
    if (input.confirm !== true) throw new Error(`${entry.id} requires --confirm when setting a value`);
    return { entry, operation: "set", path, value: input.value, ...(target === undefined ? {} : { target }) };
  }
  if (input.params !== undefined || input.args !== undefined) throw new Error(`${entry.id} is a property and does not accept parameters`);
  return { entry, operation: "get", path, ...(target === undefined ? {} : { target }) };
}

export function listPluginApiEntries(filters: { interface?: string; search?: string } = {}): PluginApiCatalogEntry[] {
  const search = filters.search?.toLowerCase();
  return PLUGIN_API_CATALOG
    .filter((entry) => !filters.interface || entry.interface === filters.interface)
    .filter((entry) => !search || entry.id.includes(search) || entry.interface.toLowerCase().includes(search))
    .map((entry) => entry);
}
