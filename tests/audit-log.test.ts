import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AuditLogger, defaultAuditLogPath } from "../src/server/audit-log.js";

test("audit log stores operation metadata without request data", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-audit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "audit.jsonl");
  const logger = new AuditLogger(filePath);
  await logger.write({
    event: "rpc_completed",
    tool: "execute_plugin_code",
    success: true,
    durationMs: 12,
  });
  const entry = JSON.parse((await readFile(filePath, "utf8")).trim());
  assert.equal(entry.tool, "execute_plugin_code");
  assert.equal(entry.success, true);
  assert.equal(entry.durationMs, 12);
  assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "event", "success", "timestamp", "tool"]);
});

test("audit log paths stay in per-user state directories", () => {
  assert.equal(
    defaultAuditLogPath("darwin", "/Users/example", {}),
    "/Users/example/Library/Logs/Figma Gateway/audit.jsonl",
  );
  assert.equal(
    defaultAuditLogPath("win32", "C:\\Users\\example", { LOCALAPPDATA: "C:\\Users\\example\\AppData\\Local" }),
    "C:\\Users\\example\\AppData\\Local/FigmaGateway/logs/audit.jsonl",
  );
});
