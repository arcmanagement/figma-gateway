import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { writeFile } from "node:fs/promises";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  ConnectedFile,
  PluginConnected,
  PluginHello,
  PluginRequest,
  PluginResponse,
  RpcRequest,
  RpcResponse,
} from "../shared/protocol.js";
import { safeOutputPath } from "./safe-path.js";
import { AuditLogger, type AuditWriter } from "./audit-log.js";

type Connection = { file: ConnectedFile; socket: WebSocket };
type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  socket: WebSocket;
};

const AUDIT_TOOLS = new Set([
  "list_files",
  "get_node",
  "execute_plugin_code",
  "save_screenshots",
]);

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 16 * 1024 * 1024) throw new Error("Request body exceeds 16 MiB");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function authorized(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

export class GatewayHub {
  readonly port: number;
  readonly secret: string;
  private leader = false;
  private server: Server | undefined;
  private connections = new Map<string, Connection>();
  private pending = new Map<string, Pending>();
  private audit: AuditWriter;

  constructor(
    port: number,
    secret = process.env.FIGMA_GATEWAY_SECRET || "",
    audit: AuditWriter = new AuditLogger(),
  ) {
    this.port = port;
    this.secret = secret;
    this.audit = audit;
  }

  isLeader(): boolean {
    return this.leader;
  }

  async start(): Promise<boolean> {
    const server = createServer(async (request, response) => {
      try {
        if (request.method === "GET" && request.url === "/health") {
          const hasSecret = authorized(
            String(request.headers["x-figma-gateway-secret"] || ""),
            this.secret,
          );
          json(response, 200, { ok: true, files: hasSecret ? this.listFiles() : [] });
          return;
        }
        if (request.method === "POST" && request.url === "/rpc") {
          if (!authorized(String(request.headers["x-figma-gateway-secret"] || ""), this.secret)) {
            json(response, 401, { ok: false, error: "Invalid gateway secret" } satisfies RpcResponse);
            return;
          }
          const value = (await readJson(request)) as RpcRequest;
          const result = await this.callLocal(value.tool, value.arguments || {}, value.cwd || process.cwd());
          json(response, 200, { ok: true, result } satisfies RpcResponse);
          return;
        }
        json(response, 404, { ok: false, error: "Not found" });
      } catch (error) {
        json(response, 400, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        } satisfies RpcResponse);
      }
    });
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 * 1024 });
    server.on("upgrade", (request, socket, head) => {
      if (request.url !== "/plugin") {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request));
    });
    sockets.on("connection", (socket) => this.acceptPlugin(socket));

    return await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === "EADDRINUSE") {
          this.leader = false;
          resolve(false);
        } else reject(error);
      };
      server.once("error", onError);
      server.listen(this.port, "127.0.0.1", () => {
        server.off("error", onError);
        this.leader = true;
        this.server = server;
        resolve(true);
      });
    });
  }

  listFiles(): ConnectedFile[] {
    return [...this.connections.values()].map(({ file }) => file);
  }

  async call(tool: string, args: Record<string, unknown>, cwd = process.cwd()): Promise<unknown> {
    if (this.leader) return this.callLocal(tool, args, cwd);
    const response = await fetch(`http://127.0.0.1:${this.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-figma-gateway-secret": this.secret,
      },
      body: JSON.stringify({ tool, arguments: args, cwd } satisfies RpcRequest),
    });
    const value = (await response.json()) as RpcResponse;
    if (!response.ok || !value.ok) throw new Error(value.error || `Gateway RPC failed: ${response.status}`);
    return value.result;
  }

  async close(): Promise<void> {
    for (const { socket } of this.connections.values()) socket.close();
    this.connections.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Gateway closed"));
    }
    this.pending.clear();
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => error ? reject(error) : resolve());
    });
    this.server = undefined;
    this.leader = false;
  }

  async callLocal(tool: string, args: Record<string, unknown>, cwd: string): Promise<unknown> {
    const startedAt = performance.now();
    let success = false;
    try {
      let result: unknown;
      if (tool === "list_files") result = this.listFiles();
      else if (tool === "get_node") {
        result = await this.requestPlugin(String(args.fileKey || ""), "get_node", args);
      } else if (tool === "execute_plugin_code") {
        if (args.confirm !== true) throw new Error("execute_plugin_code requires confirm: true");
        result = await this.requestPlugin(String(args.fileKey || ""), "execute", args);
      } else if (tool === "save_screenshots") result = await this.saveScreenshots(args, cwd);
      else throw new Error(`Unknown plugin tool: ${tool}`);
      success = true;
      return result;
    } finally {
      await this.audit.write({
        event: "rpc_completed",
        tool: AUDIT_TOOLS.has(tool) ? tool : "unknown",
        success,
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      }).catch(() => undefined);
    }
  }

  private async saveScreenshots(args: Record<string, unknown>, cwd: string): Promise<unknown> {
    const fileKey = String(args.fileKey || "");
    const items = Array.isArray(args.items) ? args.items : [];
    if (!fileKey || items.length === 0) throw new Error("fileKey and at least one item are required");
    const results: Record<string, unknown>[] = [];
    for (const rawItem of items) {
      const item = rawItem as Record<string, unknown>;
      try {
        const exported = (await this.requestPlugin(fileKey, "export", item)) as {
          base64: string;
          byteLength: number;
        };
        const outputPath = String(item.outputPath || "");
        const target = await safeOutputPath(cwd, outputPath, "outputPath");
        const bytes = Buffer.from(exported.base64, "base64");
        await writeFile(target, bytes);
        results.push({ success: true, nodeId: item.nodeId, outputPath, bytesWritten: bytes.byteLength });
      } catch (error) {
        results.push({
          success: false,
          nodeId: item.nodeId,
          outputPath: item.outputPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const succeeded = results.filter((item) => item.success).length;
    return { succeeded, failed: results.length - succeeded, results };
  }

  private requestPlugin(
    fileKey: string,
    operation: PluginRequest["operation"],
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    const connection = this.connections.get(fileKey);
    if (!connection) throw new Error(`No connected Figma file for fileKey: ${fileKey}`);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Plugin request timed out after 180 seconds: ${operation}`));
      }, 180_000);
      this.pending.set(id, { resolve, reject, timer, socket: connection.socket });
      connection.socket.send(JSON.stringify({ type: "request", id, operation, payload } satisfies PluginRequest));
    });
  }

  private acceptPlugin(socket: WebSocket): void {
    let fileKey = "";
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as PluginHello | PluginResponse | {
          type: "file-updated";
          file: ConnectedFile;
        };
        if (message.type === "hello") {
          if (!authorized(message.secret || "", this.secret)) {
            socket.close(1008, "Invalid gateway secret");
            return;
          }
          fileKey = message.file.fileKey;
          if (!fileKey) throw new Error("Plugin hello is missing fileKey");
          this.connections.set(fileKey, { file: message.file, socket });
          socket.send(JSON.stringify({ type: "connected" } satisfies PluginConnected));
          return;
        }
        if (message.type === "file-updated" && fileKey) {
          this.connections.set(fileKey, { file: message.file, socket });
          return;
        }
        if (message.type === "response") {
          const pending = this.pending.get(message.id);
          if (!fileKey || !pending || pending.socket !== socket) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new Error(message.error || "Plugin request failed"));
        }
      } catch (error) {
        socket.close(1003, error instanceof Error ? error.message.slice(0, 120) : "Invalid message");
      }
    });
    socket.on("close", () => {
      if (fileKey && this.connections.get(fileKey)?.socket === socket) this.connections.delete(fileKey);
    });
  }
}
