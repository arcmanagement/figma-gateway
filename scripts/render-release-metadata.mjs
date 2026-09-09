#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [mode, ...args] = process.argv.slice(2);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const version = packageJson.version;
const hash = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex").toUpperCase();
const render = async (source, destination, replacements) => {
  let text = await readFile(source, "utf8");
  for (const [name, value] of Object.entries(replacements)) text = text.replaceAll(`__${name}__`, value);
  if (/__[A-Z0-9_]+__/.test(text)) throw new Error(`Unresolved placeholder in ${source}`);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, text, "utf8");
};

if (mode === "homebrew") {
  const [archive, output] = args;
  if (!archive || !output) throw new Error("Usage: render-release-metadata.mjs homebrew <archive> <output>");
  await render("packaging/homebrew/figma-gateway.rb.template", output, {
    VERSION: version,
    SHA256: (await hash(archive)).toLowerCase(),
  });
} else {
  throw new Error("Mode must be homebrew");
}
