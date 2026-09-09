#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
await mkdir(out, { recursive: true, mode: 0o700 });
await writeFile(path.join(out, "code.js"), code, { mode: 0o600 });
await writeFile(path.join(out, "ui.html"), ui, { mode: 0o600 });

const manifest = (await readFile(path.join(root, "plugin", "manifest.template.json"), "utf8"))
  .replaceAll("__GATEWAY_NAME__", baseName)
  .replaceAll("__GATEWAY_ID__", "figma-gateway-shared-design")
  .replaceAll("__GATEWAY_PORT__", String(port));
const manifestData = JSON.parse(manifest);
manifestData.editorType = ["figma", "figjam", "slides", "dev", "buzz"];
manifestData.permissions = [];
manifestData.capabilities = ["inspect"];
await writeFile(
  path.join(out, "manifest.json"),
  `${JSON.stringify(manifestData, null, 2)}\n`,
  { mode: 0o600 },
);
process.stdout.write(`${path.join(out, "manifest.json")}\n`);
