import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { GatewayHub } from "../src/server/gateway.js";

const silentAudit = { write: async () => undefined };

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function connectedPlugin(
  port: number,
  secret: string,
  fileKey = "session-1",
  instance = "shared",
  editorType = "figma",
  fileName = "Gateway test",
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
  await new Promise<void>((resolve, reject) => {
    const finish = (callback: () => void) => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      callback();
    };
    const onMessage = (data: WebSocket.RawData) => {
      const message = JSON.parse(data.toString());
      if (message.type !== "connected") return;
      finish(resolve);
    };
    const onError = (error: Error) => finish(() => reject(error));
    const timer = setTimeout(
      () => finish(() => reject(new Error("Plugin connection acknowledgement timed out"))),
      1000,
    );
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.once("open", () => {
      socket.send(JSON.stringify({
        type: "hello",
        secret,
        file: {
          instance,
          fileKey,
          actualFileKey: "actual-1",
          fileName,
          editorType,
          pageId: "0:1",
          pageName: "Page 1",
        },
      }));
    });
  });
  return socket;
}

test("routes plugin reads and writes exported bytes below caller cwd", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const socket = await connectedPlugin(port, "shared-secret");
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    const result = request.operation === "export"
      ? { base64: Buffer.from("image-bytes").toString("base64"), byteLength: 11 }
      : { id: request.payload.nodeId, name: "Node", type: "FRAME" };
    socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(await hub.call("get_node", { fileKey: "session-1", nodeId: "1:2" }), {
    id: "1:2", name: "Node", type: "FRAME",
  });
  const cwd = await mkdtemp(path.join(tmpdir(), "figma-gateway-test-"));
  const exported = await hub.call("save_screenshots", {
    fileKey: "session-1",
    items: [{ nodeId: "1:2", outputPath: "out/node.png", format: "PNG", scale: 2 }],
  }, cwd) as { succeeded: number };
  assert.equal(exported.succeeded, 1);
  assert.equal(await readFile(path.join(cwd, "out/node.png"), "utf8"), "image-bytes");
  const blocked = await hub.call("save_screenshots", {
    fileKey: "session-1",
    items: [{ nodeId: "1:2", outputPath: "../escape.png" }],
  }, cwd) as { failed: number };
  assert.equal(blocked.failed, 1);
  socket.close();
  await hub.close();
});

test("routes typed Plugin API operations and requires confirmation for calls and writes", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const socket = await connectedPlugin(port, "shared-secret");
  const requests: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "ok" }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(await hub.call("plugin_api_get", {
    fileKey: "session-1", path: "editorType",
  }), "ok");
  await assert.rejects(hub.call("plugin_api_call", {
    fileKey: "session-1", path: "createRectangle",
  }), /requires confirm/);
  assert.equal(await hub.call("plugin_api_call", {
    fileKey: "session-1", path: "getNodeByIdAsync", args: ["1:2"], confirm: true,
  }), "ok");
  assert.equal(await hub.call("plugin_api_set", {
    fileKey: "session-1", path: "currentPage.selection", value: [], confirm: true,
  }), "ok");
  assert.equal(await hub.call("plugin_api_callback", {
    fileKey: "session-1", code: "return [];", confirm: true,
  }), "ok");
  assert.deepEqual(requests.map((request) => request.payload.action), ["get", "call", "set", "callback"]);

  socket.close();
  await hub.close();
});

test("routes exact catalog commands without accepting an arbitrary API path", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const socket = await connectedPlugin(port, "shared-secret");
  const requests: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    requests.push(request);
    socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: "ok" }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  await assert.rejects(hub.call("plugin_api_invoke", {
    fileKey: "session-1", apiId: "figma.not-a-real-api", confirm: true,
  }), /Unknown Plugin API command/);
  await assert.rejects(hub.call("plugin_api_invoke", {
    fileKey: "session-1", apiId: "figma.create-rectangle",
  }), /requires --confirm/);
  assert.equal(await hub.call("plugin_api_invoke", {
    fileKey: "session-1",
    apiId: "figma.variables.create-variable",
    params: { name: "Spacing", collectionId: "VariableCollectionId:1:2", resolvedType: "FLOAT" },
    confirm: true,
  }), "ok");
  assert.deepEqual(requests[0], {
    type: "request",
    id: requests[0]?.id,
    operation: "api",
    payload: {
      action: "call",
      path: "variables.createVariable",
      args: ["Spacing", "VariableCollectionId:1:2", "FLOAT"],
    },
  });

  socket.close();
  await hub.close();
});

test("follower RPC requires and forwards the shared secret", async () => {
  const port = await freePort();
  const leader = new GatewayHub(port, "secret", silentAudit);
  const follower = new GatewayHub(port, "secret", silentAudit);
  assert.equal(await leader.start(), true);
  assert.equal(await follower.start(), false);
  const socket = await connectedPlugin(port, "secret");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const files = await follower.call("list_files", {}) as Array<{ fileName: string }>;
  assert.equal(files[0]?.fileName, "Gateway test");
  socket.close();
  await leader.close();
});

test("health only exposes connected file metadata to an authenticated caller", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "secret", silentAudit);
  assert.equal(await hub.start(), true);
  const socket = await connectedPlugin(port, "secret");
  await new Promise((resolve) => setTimeout(resolve, 20));

  const anonymous = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json()) as {
    files: unknown[];
  };
  assert.deepEqual(anonymous.files, []);
  const authenticated = await fetch(`http://127.0.0.1:${port}/health`, {
    headers: { "X-Figma-Gateway-Secret": "secret" },
  }).then((response) => response.json()) as { files: Array<{ fileName: string }> };
  assert.equal(authenticated.files[0]?.fileName, "Gateway test");

  socket.close();
  await hub.close();
});

test("one gateway routes the shared Plugin across app and editor sessions", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const example = await connectedPlugin(
    port, "shared-secret", "example-dev-session", "shared", "dev", "Example dev",
  );
  const standard = await connectedPlugin(
    port, "shared-secret", "standard-design-session", "shared", "figma", "Standard design",
  );
  const received: Array<{ socket: WebSocket; name: string; request: { id: string } }> = [];
  for (const [socket, name] of [[example, "Example node"], [standard, "Standard node"]] as const) {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      received.push({ socket, name, request });
      if (received.length === 2) {
        for (const item of received) {
          item.socket.send(JSON.stringify({
            type: "response",
            id: item.request.id,
            ok: true,
            result: { name: item.name },
          }));
        }
      }
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(hub.listFiles().map((file) => [file.instance, file.fileKey, file.editorType]).sort(), [
    ["shared", "example-dev-session", "dev"],
    ["shared", "standard-design-session", "figma"],
  ]);
  const [exampleNode, standardNode] = await Promise.all([
    hub.call("get_node", { fileKey: "example-dev-session", nodeId: "1:2" }),
    hub.call("get_node", { fileKey: "standard-design-session", nodeId: "1:2" }),
  ]);
  assert.deepEqual(exampleNode, { name: "Example node" });
  assert.deepEqual(standardNode, { name: "Standard node" });
  assert.equal(received.length, 2);
  example.close();
  standard.close();
  await hub.close();
});

test("one Plugin instance can expose and route multiple file sessions", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const first = await connectedPlugin(port, "shared-secret", "shared-first", "shared");
  const second = await connectedPlugin(port, "shared-secret", "shared-second", "shared");
  for (const [socket, session] of [[first, "first"], [second, "second"]] as const) {
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString());
      socket.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { session } }));
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(hub.listFiles().map((file) => file.fileKey).sort(), ["shared-first", "shared-second"]);
  assert.deepEqual(await hub.call("get_node", { fileKey: "shared-second", nodeId: "1:2" }), {
    session: "second",
  });
  first.close();
  second.close();
  await hub.close();
});

test("only the authenticated target Plugin socket can resolve its pending request", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const target = await connectedPlugin(port, "shared-secret", "target-session", "shared");
  const impostor = new WebSocket(`ws://127.0.0.1:${port}/plugin`);
  await new Promise<void>((resolve, reject) => {
    impostor.once("open", resolve);
    impostor.once("error", reject);
  });
  target.on("message", (data) => {
    const request = JSON.parse(data.toString());
    impostor.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { name: "Impostor" } }));
    setTimeout(() => {
      target.send(JSON.stringify({ type: "response", id: request.id, ok: true, result: { name: "Target" } }));
    }, 10);
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(await hub.call("get_node", { fileKey: "target-session", nodeId: "1:2" }), {
    name: "Target",
  });
  impostor.close();
  target.close();
  await hub.close();
});

test("screenshot output rejects a symlink that escapes caller cwd", async () => {
  const port = await freePort();
  const hub = new GatewayHub(port, "shared-secret", silentAudit);
  assert.equal(await hub.start(), true);
  const socket = await connectedPlugin(port, "shared-secret");
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString());
    socket.send(JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result: { base64: Buffer.from("image-bytes").toString("base64"), byteLength: 11 },
    }));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const cwd = await mkdtemp(path.join(tmpdir(), "figma-gateway-cwd-"));
  const outside = await mkdtemp(path.join(tmpdir(), "figma-gateway-outside-"));
  await symlink(outside, path.join(cwd, "escape"), "dir");
  const result = await hub.call("save_screenshots", {
    fileKey: "session-1",
    items: [{ nodeId: "1:2", outputPath: "escape/node.png" }],
  }, cwd) as { failed: number; results: Array<{ error: string }> };
  assert.equal(result.failed, 1);
  assert.match(result.results[0]?.error || "", /symbolic link/);
  await assert.rejects(readFile(path.join(outside, "node.png")));

  socket.close();
  await hub.close();
});
