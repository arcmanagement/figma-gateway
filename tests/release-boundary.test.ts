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

test("Homebrew Cask installs signed macOS entrypoints and starts per-user setup", async (context) => {
  const root = path.resolve(import.meta.dirname, "..");
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-cask-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const arm64Archive = path.join(directory, "arm64.zip");
  const x64Archive = path.join(directory, "x64.zip");
  const cask = path.join(directory, "figma-gateway.rb");
  await writeFile(arm64Archive, "arm64 release", "utf8");
  await writeFile(x64Archive, "x64 release", "utf8");
  await run(process.execPath, [
    path.join(root, "scripts", "render-release-metadata.mjs"),
    "cask",
    arm64Archive,
    x64Archive,
    cask,
  ], { cwd: root });
  const text = await readFile(cask, "utf8");
  assert.match(text, /arch arm: "arm64", intel: "x64"/);
  assert.match(text, /Developer ID signed/);
  assert.match(text, /Contents\/MacOS\/figma-gateway"/);
  assert.match(text, /Contents\/MacOS\/figma-gateway-mcp"/);
  assert.match(text, /args:\s+\["setup"\]/);
  assert.match(text, /sudo:\s+:if_needed/);
  assert.doesNotMatch(text, /^\s*(?:postflight|uninstall_preflight) do/m);
  assert.doesNotMatch(text, /__[A-Z0-9_]+__/);
});

test("release stays draft until signed macOS artifacts are attached", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const releaseWorkflow = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const metadataWorkflow = await readFile(
    path.join(root, ".github", "workflows", "publish-homebrew.yml"),
    "utf8",
  );
  const publishWorkflow = await readFile(
    path.join(root, ".github", "workflows", "publish-release.yml"),
    "utf8",
  );
  assert.match(releaseWorkflow, /gh release create[\s\S]*--draft/);
  assert.doesNotMatch(releaseWorkflow, /git push origin HEAD:main/);
  assert.match(metadataWorkflow, /types: \[published\]/);
  assert.match(metadataWorkflow, /--pattern FigmaGatewayCask\.rb/);
  assert.match(metadataWorkflow, /git push origin HEAD:main/);
  assert.match(publishWorkflow, /workflow_dispatch:/);
  assert.match(publishWorkflow, /figma-gateway-\$version-macos-arm64\.zip/);
  assert.match(publishWorkflow, /figma-gateway-\$version-macos-x64\.zip/);
  assert.match(publishWorkflow, /sha256sum --check/);
  assert.match(publishWorkflow, /gh release edit "\$tag" --repo "\$REPOSITORY" --draft=false/);
});

test("macOS public distribution requires Developer ID signing and notarization", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const script = await readFile(path.join(root, "scripts", "dist-macos.sh"), "utf8");
  assert.match(script, /SIGN_IDENTITY and NOTARY_PROFILE are required/);
  assert.match(script, /codesign --force --options runtime --timestamp/);
  assert.match(script, /--entitlements packaging\/macos\/Node\.entitlements/);
  assert.match(script, /notarytool submit/);
  assert.match(script, /stapler staple/);
  assert.match(script, /spctl --assess --type execute/);
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git describe --tags --exact-match HEAD/);
  assert.match(script, /--norsrc/);
  assert.doesNotMatch(script, /skip signing|skip notarization/i);
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
