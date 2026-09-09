import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { GatewayHub } from "./gateway.js";
import { credentialStatus, figmaRestRequest } from "./rest.js";

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
