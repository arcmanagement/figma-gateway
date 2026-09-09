export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ConnectedFile {
  instance: string;
  fileKey: string;
  actualFileKey?: string;
  fileName: string;
  editorType: string;
  editorMode: string;
  pageId: string;
  pageName: string;
}

export interface PluginHello {
  type: "hello";
  secret: string;
  file: ConnectedFile;
}

export interface PluginConnected {
  type: "connected";
}

export interface PluginRequest {
  type: "request";
  id: string;
  operation: "get_node" | "export" | "execute" | "api";
  payload: Record<string, unknown>;
}

export interface PluginResponse {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface RpcRequest {
  tool: string;
  arguments: Record<string, unknown>;
  cwd: string;
}

export interface RpcResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const PLUGIN_TOOLS = new Set([
  "list_files",
  "get_node",
  "save_screenshots",
  "execute_plugin_code",
  "plugin_api_get",
  "plugin_api_call",
  "plugin_api_set",
  "plugin_api_callback",
  "plugin_api_invoke",
  "plugin_callback_create",
  "plugin_callback_events",
]);
