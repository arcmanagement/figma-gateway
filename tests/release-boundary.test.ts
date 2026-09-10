import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

test("Windows launchers use the bundled architecture-specific Node.js runtime", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  for (const launcher of ["figma-gateway.cmd", "figma-gateway-mcp.cmd"]) {
    const text = await readFile(path.join(root, "packaging", "windows", launcher), "utf8");
    assert.match(text, /"%~dp0node\.exe"/);
    assert.doesNotMatch(text, /(?:^|\s)node\s/mi);
  }
});

test("Homebrew Formula defers per-user setup until after the sandboxed install", async (context) => {
  const root = path.resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-homebrew-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const archive = path.join(directory, "figma-gateway.tgz");
  const formula = path.join(directory, "figma-gateway.rb");
  await writeFile(archive, "release archive", "utf8");
  await run(process.execPath, [
    path.join(root, "scripts", "render-release-metadata.mjs"),
    "homebrew",
    archive,
    formula,
  ], { cwd: root });
  const text = await readFile(formula, "utf8");
  assert.doesNotMatch(text, /post_install/);
  assert.match(text, /figma-gateway setup/);
  assert.match(text, /plugin\/dev\/manifest\.json/);
});

test("npm package excludes a locally built credential-bearing Plugin", async (context) => {
  const root = path.resolve(import.meta.dirname, "..");
  const localArtifact = path.join(root, "plugin", "dist", "release-boundary-test");
  context.after(() => rm(path.join(root, "plugin", "dist"), { recursive: true, force: true }));
  await mkdir(localArtifact, { recursive: true });
  await writeFile(path.join(localArtifact, "code.js"), "release-boundary-secret-value", "utf8");
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: root });
  const files = JSON.parse(stdout)[0].files.map((file: { path: string }) => file.path);
  assert.ok(files.includes("plugin/src/code.ts"));
  assert.ok(files.includes("scripts/build-plugin.mjs"));
  assert.ok(!files.some((file: string) => file.startsWith("plugin/dist/")));
  assert.ok(!files.some((file: string) => file.startsWith("tests/")));
});

test("release verification rejects a binary hidden under an allowed directory", async (context) => {
  const root = path.resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-release-binary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", directory], { cwd: root });
  const archive = path.join(directory, JSON.parse(stdout)[0].filename);
  const extracted = path.join(directory, "extracted");
  await mkdir(extracted);
  await run("tar", ["-xzf", archive, "-C", extracted]);
  await writeFile(path.join(extracted, "package", "scripts", "hidden.bin"), Buffer.from([0, 1, 2, 3]));
  const tampered = path.join(directory, "tampered.tgz");
  await run("tar", ["-czf", tampered, "-C", extracted, "package"]);
  await assert.rejects(
    run(process.execPath, [path.join(root, "scripts", "verify-release.mjs"), tampered], {
      cwd: root,
      env: { ...process.env, RELEASE_PROHIBITED_TERMS: "private-example" },
    }),
    /binary release member is not allowed/,
  );
});
