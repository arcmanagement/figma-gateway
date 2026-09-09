#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const archive = process.argv[2];
if (!archive) throw new Error("Usage: verify-release.mjs <package.tgz>");

const forbiddenTerms = (process.env.RELEASE_PROHIBITED_TERMS || "")
  .split(/[\n,]/)
  .map((value) => value.trim())
  .filter(Boolean);
if (forbiddenTerms.length === 0) {
  throw new Error("RELEASE_PROHIBITED_TERMS must contain the private publication denylist");
}

const allowedFiles = new Set(["LICENSE", "README.md", "SECURITY.md", "package.json", "npm-shrinkwrap.json"]);
const allowedPrefixes = ["dist/", "plugin/src/", "scripts/"];
const allowedPluginFiles = new Set(["plugin/manifest.template.json", "plugin/tsconfig.json"]);
const allowedPackagingFiles = new Set([
  "packaging/windows/figma-gateway.cmd",
  "packaging/windows/figma-gateway-mcp.cmd",
]);
const requiredFiles = [
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "package.json",
  "npm-shrinkwrap.json",
  "dist/cli/index.js",
  "dist/server/index.js",
  "plugin/src/code.ts",
  "scripts/build-plugin.mjs",
];

const members = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map((entry) => entry.replace(/^package\//, "").replace(/\/$/, ""))
  .filter(Boolean);
const failures = [];
for (const member of members) {
  const allowed = allowedFiles.has(member) || allowedPluginFiles.has(member) || allowedPackagingFiles.has(member) ||
    allowedPrefixes.some((prefix) => member.startsWith(prefix));
  if (!allowed) failures.push(`${member}: outside package allowlist`);
  if (member.startsWith("plugin/dist/") || member.startsWith("tests/") ||
      member.startsWith(".github/") || /\.(?:png|jpe?g|gif|webp|mp4|mov)$/i.test(member)) {
    failures.push(`${member}: forbidden release member`);
  }
}
for (const required of requiredFiles) {
  if (!members.includes(required)) failures.push(`${required}: required release member is missing`);
}

const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-release-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", directory]);
  for (const member of members) {
    const filePath = path.join(directory, "package", member);
    let bytes;
    try { bytes = await readFile(filePath); } catch { continue; }
    if (bytes.includes(0)) {
      failures.push(`${member}: binary release member is not allowed`);
      continue;
    }
    const text = bytes.toString("utf8");
    if (/[\u3040-\u30ff\u3400-\u9fff]/u.test(text)) {
      failures.push(`${member}: non-English public text`);
    }
    for (const term of forbiddenTerms) {
      if (member.toLowerCase().includes(term.toLowerCase()) || text.toLowerCase().includes(term.toLowerCase())) {
        failures.push(`${member}: forbidden publication term`);
      }
    }
    const localSecret = process.env.FIGMA_GATEWAY_SECRET;
    if (localSecret && localSecret.length >= 16 && text.includes(localSecret)) {
      failures.push(`${member}: contains the current local gateway secret`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

if (failures.length > 0) {
  throw new Error(`Release verification failed:\n${[...new Set(failures)].join("\n")}`);
}
process.stdout.write(`Verified ${members.length} release members in ${archive}.\n`);
