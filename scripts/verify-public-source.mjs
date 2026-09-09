#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";

const forbiddenTerms = (process.env.RELEASE_PROHIBITED_TERMS || "")
  .split(/[\n,]/)
  .map((value) => value.trim())
  .filter(Boolean);

if (forbiddenTerms.length === 0) {
  throw new Error("RELEASE_PROHIBITED_TERMS must contain the private publication denylist");
}

const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const paths = [];
for (const filePath of candidates) {
  try { await access(filePath); paths.push(filePath); } catch { /* deleted working-tree path */ }
}
const failures = [];
const cjk = /[\u3040-\u30ff\u3400-\u9fff]/u;

for (const filePath of paths) {
  const lowerPath = filePath.toLowerCase();
  for (const term of forbiddenTerms) {
    if (lowerPath.includes(term.toLowerCase())) failures.push(`${filePath}: forbidden path term`);
  }
  const bytes = await readFile(filePath);
  if (bytes.includes(0)) {
    failures.push(`${filePath}: binary public source is not allowed`);
    continue;
  }
  const text = bytes.toString("utf8");
  if (cjk.test(text)) failures.push(`${filePath}: non-English public text`);
  for (const term of forbiddenTerms) {
    if (text.toLowerCase().includes(term.toLowerCase())) failures.push(`${filePath}: forbidden content term`);
  }
}

if (failures.length > 0) {
  throw new Error(`Public source verification failed:\n${[...new Set(failures)].join("\n")}`);
}

process.stdout.write(`Verified ${paths.length} public source files.\n`);
