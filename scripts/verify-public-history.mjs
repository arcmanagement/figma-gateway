#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const forbiddenTerms = (process.env.RELEASE_PROHIBITED_TERMS || "")
  .split(/[\n,]/)
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
if (forbiddenTerms.length === 0) {
  throw new Error("RELEASE_PROHIBITED_TERMS must contain the private publication denylist");
}

const approvedRoot = (process.env.PUBLIC_HISTORY_ROOT || "").trim().toLowerCase();
if (!/^[0-9a-f]{40}$/.test(approvedRoot)) {
  throw new Error("PUBLIC_HISTORY_ROOT must contain the approved 40-character initial public commit ID");
}

const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", ...options });
try { git(["cat-file", "-e", `${approvedRoot}^{commit}`]); } catch {
  throw new Error("PUBLIC_HISTORY_ROOT does not resolve to a commit");
}
const roots = git(["rev-list", "--max-parents=0", "--all"]).trim().toLowerCase().split("\n").filter(Boolean);
if (roots.length !== 1 || roots[0] !== approvedRoot) {
  throw new Error("Git history does not have exactly the approved public root");
}

const commits = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
const failures = [];
const inspectedBlobs = new Map();
for (const commit of commits) {
  const metadata = git(["show", "-s", "--format=%B%n%D", commit]).toLowerCase();
  if (forbiddenTerms.some((term) => metadata.includes(term))) {
    failures.push(`${commit}: forbidden commit metadata`);
  }
  const entries = git(["ls-tree", "-rz", commit], { encoding: "buffer" }).toString("utf8").split("\0").filter(Boolean);
  for (const entry of entries) {
    const match = entry.match(/^\d+ blob ([0-9a-f]{40})\t([\s\S]+)$/);
    if (!match) continue;
    const [, objectId, filePath] = match;
    const lowerPath = filePath.toLowerCase();
    if (forbiddenTerms.some((term) => lowerPath.includes(term))) {
      failures.push(`${commit}: forbidden historical path`);
    }
    let result = inspectedBlobs.get(objectId);
    if (!result) {
      const bytes = execFileSync("git", ["cat-file", "blob", objectId]);
      result = bytes.includes(0)
        ? "binary"
        : forbiddenTerms.some((term) => bytes.toString("utf8").toLowerCase().includes(term))
          ? "forbidden"
          : "ok";
      inspectedBlobs.set(objectId, result);
    }
    if (result === "binary") failures.push(`${commit}: binary historical source is not allowed`);
    if (result === "forbidden") failures.push(`${commit}: forbidden historical content`);
  }
}

if (failures.length > 0) {
  throw new Error(`Public history verification failed:\n${[...new Set(failures)].join("\n")}`);
}
process.stdout.write(`Verified ${commits.length} commits from approved public root ${approvedRoot}.\n`);
