import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
test("Plugin build enforces the canonical shared artifact identity and all surfaces", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-build-"));
  context.after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });
  await cp(path.join(root, "plugin"), path.join(fixture, "plugin"), { recursive: true });

  await execFileAsync(process.execPath, [path.join(root, "scripts", "build-plugin.mjs")], {
    cwd: fixture,
    env: { ...process.env, FIGMA_GATEWAY_SECRET: "test-secret" },
  });

  const manifest = JSON.parse(await readFile(
    path.join(fixture, "plugin", "dist", "shared", "manifest.json"),
    "utf8",
  ));
  const ui = await readFile(
    path.join(fixture, "plugin", "dist", "shared", "ui.html"),
    "utf8",
  );
  const code = await readFile(
    path.join(fixture, "plugin", "dist", "shared", "code.js"),
    "utf8",
  );
  assert.equal(manifest.name, "Figma Gateway");
  assert.equal(manifest.id, "figma-gateway-shared-design");
  assert.deepEqual(manifest.editorType, ["figma", "figjam", "slides", "dev", "buzz"]);
  assert.deepEqual(manifest.capabilities, ["inspect"]);
  assert.deepEqual(manifest.permissions, []);
  assert.match(ui, /textContent = "Checking connection…"/);
  assert.match(ui, /message\.type === "connected"/);
  assert.match(ui, /textContent = "Connected"/);
  assert.doesNotMatch(ui, /identity\.file\.instance/);
  assert.match(code, /test-secret/);

  await assert.rejects(
    execFileAsync(process.execPath, [
      path.join(root, "scripts", "build-plugin.mjs"), "--instance", "example",
    ], {
      cwd: fixture,
      env: { ...process.env, FIGMA_GATEWAY_SECRET: "test-secret" },
    }),
    /cannot be overridden/,
  );
});
