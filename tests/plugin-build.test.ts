import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
test("Plugin build exposes all surfaces through compatible manifests and one gateway instance", async (context) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-build-"));
  context.after(async () => {
    await rm(fixture, { recursive: true, force: true });
  });
  await cp(path.join(root, "plugin"), path.join(fixture, "plugin"), { recursive: true });
  const legacyDevManifest = path.join(
    fixture, "plugin", "dist", "shared", "manifest.dev.json",
  );
  await mkdir(path.dirname(legacyDevManifest), { recursive: true });
  await writeFile(legacyDevManifest, "{}", "utf8");

  await execFileAsync(process.execPath, [path.join(root, "scripts", "build-plugin.mjs")], {
    cwd: fixture,
    env: { ...process.env, FIGMA_GATEWAY_SECRET: "test-secret" },
  });

  const manifest = JSON.parse(await readFile(
    path.join(fixture, "plugin", "dist", "shared", "manifest.json"),
    "utf8",
  ));
  const devManifest = JSON.parse(await readFile(
    path.join(fixture, "plugin", "dist", "shared", "dev", "manifest.json"),
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
  const devUiPath = path.join(fixture, "plugin", "dist", "shared", "dev", "ui.html");
  const devCodePath = path.join(fixture, "plugin", "dist", "shared", "dev", "code.js");
  const devUi = await readFile(devUiPath, "utf8");
  const devCode = await readFile(devCodePath, "utf8");
  assert.equal(manifest.name, "Figma Gateway");
  assert.equal(manifest.id, "figma-gateway-shared-design");
  assert.deepEqual(manifest.editorType, ["figma", "figjam", "slides", "buzz"]);
  assert.deepEqual(manifest.capabilities, ["textreview"]);
  assert.deepEqual(manifest.permissions, [
    "currentuser", "activeusers", "fileusers", "payments", "teamlibrary",
  ]);
  assert.equal(manifest.enableProposedApi, true);
  assert.equal(manifest.enablePrivatePluginApi, true);
  assert.equal(devManifest.name, "Figma Gateway");
  assert.equal(devManifest.id, "figma-gateway-shared-dev");
  assert.deepEqual(devManifest.editorType, ["dev"]);
  assert.deepEqual(devManifest.capabilities, ["inspect", "codegen", "vscode"]);
  assert.deepEqual(devManifest.codegenLanguages, [{ label: "JSON", value: "json" }]);
  assert.equal(devUi, ui);
  assert.equal(devCode, code);
  assert.equal((await lstat(devUiPath)).isSymbolicLink(), false);
  assert.equal((await lstat(devCodePath)).isSymbolicLink(), false);
  await assert.rejects(access(legacyDevManifest));
  assert.match(code, /codegen\.on\("generate"/);
  assert.match(code, /typeof __uiFiles__ === "undefined"/);
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
