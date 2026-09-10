#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { build } from "esbuild";

function option(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const removedIdentityOptions = ["--instance", "--mode", "--name"].filter((name) =>
  process.argv.includes(name)
);
if (removedIdentityOptions.length > 0) {
  throw new Error(
    `${removedIdentityOptions.join(", ")} cannot be overridden; ` +
    "the Plugin is always Figma Gateway with instance=shared and all editor surfaces",
  );
}

const instance = "shared";
const port = Number(option(
  "port",
  process.env.FIGMA_BRIDGE_PORT || process.env.FIGMA_GATEWAY_PORT ||
    process.env.FIGMA_VARIANT_BRIDGE_PORT || "1995",
));
const baseName = "Figma Gateway";
const secret = process.env.FIGMA_GATEWAY_SECRET || "";
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`);
if (!secret) {
  throw new Error("FIGMA_GATEWAY_SECRET is required. Run scripts/init-gateway-secret.sh and source scripts/common.sh.");
}

const root = process.cwd();
const runtime = await build({
  entryPoints: [path.join(root, "plugin", "src", "code.ts")],
  bundle: true,
  format: "iife",
  target: "es2020",
  write: false,
  define: {
    __GATEWAY_SECRET__: JSON.stringify(secret),
    __GATEWAY_INSTANCE__: JSON.stringify(instance),
  },
});
const code = runtime.outputFiles[0].contents;
const ui = (await readFile(path.join(root, "plugin", "src", "ui.html"), "utf8"))
  .replaceAll("__GATEWAY_PORT__", String(port));

const configuredOutput = option("out-dir", "");
const out = configuredOutput
  ? path.resolve(configuredOutput)
  : path.join(root, "plugin", "dist", instance);
const devOut = path.join(out, "dev");
await mkdir(out, { recursive: true, mode: 0o700 });
await mkdir(devOut, { recursive: true, mode: 0o700 });
await rm(path.join(out, "manifest.dev.json"), { force: true });
for (const directory of [out, devOut]) {
  await writeFile(path.join(directory, "code.js"), code, { mode: 0o600 });
  await writeFile(path.join(directory, "ui.html"), ui, { mode: 0o600 });
}

const manifestTemplate = await readFile(path.join(root, "plugin", "manifest.template.json"), "utf8");
const permissions = ["currentuser", "activeusers", "fileusers", "payments", "teamlibrary"];

async function writeManifest(directory, id, name, editorType, capabilities, extra = {}) {
  const manifest = manifestTemplate
    .replaceAll("__GATEWAY_NAME__", name)
    .replaceAll("__GATEWAY_ID__", id)
    .replaceAll("__GATEWAY_PORT__", String(port));
  const manifestData = {
    ...JSON.parse(manifest),
    editorType,
    permissions,
    capabilities,
    enableProposedApi: true,
    enablePrivatePluginApi: true,
    ...extra,
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(manifestData, null, 2)}\n`,
    { mode: 0o600 },
  );
}

// Figma rejects a single manifest containing both FigJam and Dev Mode. These two
// registrations share the same runtime, gateway instance, product name, and secret.
await writeManifest(
  out,
  "figma-gateway-shared-design",
  baseName,
  ["figma", "figjam", "slides", "buzz"],
  ["textreview"],
);
await writeManifest(
  devOut,
  "figma-gateway-shared-dev",
  baseName,
  ["dev"],
  ["inspect", "codegen", "vscode"],
  { codegenLanguages: [{ label: "JSON", value: "json" }] },
);
process.stdout.write(`${path.join(out, "manifest.json")}\n${path.join(devOut, "manifest.json")}\n`);
