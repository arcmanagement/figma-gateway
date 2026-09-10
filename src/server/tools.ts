import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GatewayHub } from "./gateway.js";
import { credentialStatus, figmaRestRequest } from "./rest.js";
import {
  listPluginApiEntries,
  pluginApiEntry,
  PLUGIN_API_COMMAND_COUNT,
  PLUGIN_API_DECLARATION_COUNT,
  PLUGIN_API_INTERFACE_COUNT,
  PLUGIN_API_GLOBAL_COUNT,
  PLUGIN_API_TYPINGS_VERSION,
} from "../shared/plugin-api-catalog.js";

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const queryValue = z.union([
  z.string(), z.number(), z.boolean(),
  z.array(z.union([z.string(), z.number(), z.boolean()])),
  z.null(),
]);

export function registerTools(server: McpServer, hub: GatewayHub): void {
  server.registerTool("list_files", {
    description: "List Figma files currently connected through the original local gateway plugin.",
    inputSchema: {},
  }, async () => text(await hub.call("list_files", {})));

  server.registerTool("get_node", {
    description: "Read and serialize a node from a connected Figma file without using REST rate limits.",
    inputSchema: {
      fileKey: z.string().min(1),
      nodeId: z.string().min(1),
      depth: z.number().int().min(0).optional(),
    },
  }, async (args) => text(await hub.call("get_node", args)));

  server.registerTool("save_screenshots", {
    description: "Export one or more Figma nodes with Plugin API exportAsync. Supports still images, PDFs, and Motion video formats.",
    inputSchema: {
      fileKey: z.string().min(1),
      items: z.array(z.object({
        nodeId: z.string().min(1),
        outputPath: z.string().min(1),
        format: z.enum(["PNG", "JPG", "SVG", "PDF", "MP4", "GIF", "WEBM"]).default("PNG"),
        scale: z.number().positive().optional(),
        fps: z.number().int().positive().optional(),
        quality: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
        loopCount: z.number().int().min(0).max(1000).optional(),
      })).min(1),
    },
  }, async (args) => text(await hub.call("save_screenshots", args)));

  server.registerTool("execute_plugin_code", {
    description: "Execute original JavaScript against the complete Figma Plugin API in a connected file. The code receives figma, args, and serialize. Mutating or arbitrary execution always requires confirm=true.",
    inputSchema: {
      fileKey: z.string().min(1),
      code: z.string().min(1),
      args: z.record(z.unknown()).optional(),
      confirm: z.literal(true),
    },
  }, async (args) => text(await hub.call("execute_plugin_code", args)));

  server.registerTool("plugin_api_get", {
    description: "Read any serializable property from the Figma Plugin API by path.",
    inputSchema: {
      fileKey: z.string().min(1),
      path: z.string().min(1),
      target: z.unknown().optional(),
    },
  }, async (args) => text(await hub.call("plugin_api_get", args)));

  server.registerTool("plugin_api_call", {
    description: "Call any Figma Plugin API method by path. Live Plugin objects can be passed as {$node: id} or {$figma: path}, and bytes as {$base64: value}.",
    inputSchema: {
      fileKey: z.string().min(1),
      path: z.string().min(1),
      args: z.array(z.unknown()).optional(),
      target: z.unknown().optional(),
      confirm: z.literal(true),
    },
  }, async (args) => text(await hub.call("plugin_api_call", args)));

  server.registerTool("plugin_api_set", {
    description: "Set any writable Figma Plugin API property by path. Live Plugin objects can be passed as {$node: id} or {$figma: path}.",
    inputSchema: {
      fileKey: z.string().min(1),
      path: z.string().min(1),
      value: z.unknown(),
      target: z.unknown().optional(),
      confirm: z.literal(true),
    },
  }, async (args) => text(await hub.call("plugin_api_set", args)));

  server.registerTool("plugin_api_callback", {
    description: "Create a persistent callback handle for event-based Figma Plugin APIs. The callback receives figma, event, args, and serialize.",
    inputSchema: {
      fileKey: z.string().min(1),
      code: z.string().min(1),
      confirm: z.literal(true),
    },
  }, async (args) => text(await hub.call("plugin_api_callback", args)));

  server.registerTool("plugin_api_list", {
    description: "List the generated one-to-one CLI command catalog for the official Figma Plugin API typings.",
    inputSchema: {
      interface: z.string().optional(),
      search: z.string().optional(),
    },
  }, async (filters) => text({
    typingsVersion: PLUGIN_API_TYPINGS_VERSION,
    interfaceCount: PLUGIN_API_INTERFACE_COUNT,
    globalCount: PLUGIN_API_GLOBAL_COUNT,
    declarationCount: PLUGIN_API_DECLARATION_COUNT,
    commandCount: PLUGIN_API_COMMAND_COUNT,
    commands: listPluginApiEntries(filters),
  }));

  server.registerTool("plugin_api_describe", {
    description: "Describe one exact Figma Plugin API CLI command, including overloads and named parameters.",
    inputSchema: { apiId: z.string().min(1) },
  }, async ({ apiId }) => text(pluginApiEntry(apiId)));

  server.registerTool("plugin_api_invoke", {
    description: "Invoke one exact command ID from the generated official Figma Plugin API catalog without evaluating JavaScript.",
    inputSchema: {
      fileKey: z.string().min(1),
      apiId: z.string().min(1),
      params: z.record(z.unknown()).optional(),
      args: z.array(z.unknown()).optional(),
      target: z.unknown().optional(),
      value: z.unknown().optional(),
      key: z.string().optional(),
      overload: z.number().int().positive().optional(),
      confirm: z.boolean().optional(),
    },
  }, async (args) => text(await hub.call("plugin_api_invoke", args)));

  server.registerTool("plugin_callback_create", {
    description: "Create a persistent, code-free callback handle that records calls and returns a fixed JSON value.",
    inputSchema: {
      fileKey: z.string().min(1),
      returnValue: z.unknown().optional(),
    },
  }, async (args) => text(await hub.call("plugin_callback_create", args)));

  server.registerTool("plugin_callback_events", {
    description: "Read recorded calls for a code-free Plugin API callback handle.",
    inputSchema: {
      fileKey: z.string().min(1),
      callbackHandle: z.string().min(1),
      clear: z.boolean().optional(),
    },
  }, async (args) => text(await hub.call("plugin_callback_events", args)));

  server.registerTool("figma_rest_request", {
    description: "Call any official Figma REST v1/v2 endpoint. Non-GET methods require confirm=true. OAuth, personal, and plan access tokens are supported.",
    inputSchema: {
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      path: z.string().startsWith("/v"),
      query: z.record(queryValue).optional(),
      body: z.unknown().optional(),
      confirm: z.boolean().optional(),
      saveTo: z.string().min(1).optional(),
    },
  }, async (args) => text(await figmaRestRequest(args, process.cwd())));

  server.registerTool("figma_auth_status", {
    description: "Report whether Figma REST authentication is configured without exposing token values.",
    inputSchema: {},
  }, async () => text(await credentialStatus()));

  server.registerTool("get_comments", {
    description: "Read all comments in a Figma file through the official REST API and optionally select one comment ID.",
    inputSchema: {
      fileKey: z.string().min(1),
      commentId: z.string().min(1).optional(),
      asMarkdown: z.boolean().optional(),
    },
  }, async ({ fileKey, commentId, asMarkdown }) => {
    const response = await figmaRestRequest({
      path: `/v1/files/${encodeURIComponent(fileKey)}/comments`,
      query: asMarkdown === undefined ? undefined : { as_md: asMarkdown },
    }) as { data: { comments?: Array<Record<string, unknown>> } };
    const comments = response.data.comments || [];
    if (!commentId) return text(response);
    const comment = comments.find((item) => String(item.id) === commentId);
    if (!comment) throw new Error(`Comment not found in file: ${commentId}`);
    return text(comment);
  });

  server.registerTool("get_file_meta", {
    description: "Read Figma file metadata without fetching the full document tree.",
    inputSchema: { fileKey: z.string().min(1) },
  }, async ({ fileKey }) => text(await figmaRestRequest({
    path: `/v1/files/${encodeURIComponent(fileKey)}/meta`,
  })));

  server.registerTool("get_file_versions", {
    description: "Read the saved version history for a Figma file.",
    inputSchema: {
      fileKey: z.string().min(1),
      pageSize: z.number().int().positive().max(100).optional(),
      before: z.number().int().positive().optional(),
      after: z.number().int().positive().optional(),
    },
  }, async ({ fileKey, pageSize, before, after }) => text(await figmaRestRequest({
    path: `/v1/files/${encodeURIComponent(fileKey)}/versions`,
    query: { page_size: pageSize, before, after },
  })));
}
