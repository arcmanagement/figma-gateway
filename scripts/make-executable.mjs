#!/usr/bin/env node
import { chmod } from "node:fs/promises";
import path from "node:path";

if (process.platform !== "win32") {
  await Promise.all([
    chmod(path.resolve("dist/cli/index.js"), 0o755),
    chmod(path.resolve("dist/server/index.js"), 0o755),
  ]);
}
