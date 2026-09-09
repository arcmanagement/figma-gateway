#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GatewayHub } from "./gateway.js";
import { registerTools } from "./tools.js";

const port = Number(process.env.FIGMA_BRIDGE_PORT || process.env.FIGMA_GATEWAY_PORT || "1995");
const secret = process.env.FIGMA_GATEWAY_SECRET;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write(`ERROR: invalid FIGMA_GATEWAY_PORT/FIGMA_BRIDGE_PORT: ${port}\n`);
  process.exit(1);
}
if (!secret) {
  process.stderr.write("ERROR: FIGMA_GATEWAY_SECRET is required\n");
  process.exit(1);
}

const hub = new GatewayHub(port);
const leader = await hub.start();
process.stderr.write(`[figma-gateway] ${leader ? "leader" : "follower"} on 127.0.0.1:${port}\n`);

if (process.env.FIGMA_GATEWAY_DAEMON !== "1") {
  const server = new McpServer({ name: "figma-gateway", version: "1.0.0" });
  registerTools(server, hub);
  await server.connect(new StdioServerTransport());
}
