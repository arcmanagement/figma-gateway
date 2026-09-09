import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("public source and history checks reject binary publication inputs", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-public-boundary-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "scripts"));
  await copyFile(path.join(root, "scripts", "verify-public-source.mjs"), path.join(directory, "scripts", "verify-public-source.mjs"));
  await copyFile(path.join(root, "scripts", "verify-public-history.mjs"), path.join(directory, "scripts", "verify-public-history.mjs"));
  await writeFile(path.join(directory, "README.md"), "Safe public source\n", "utf8");
  await writeFile(path.join(directory, "archive.bin"), Buffer.from([0, 1, 2, 3]));
  await run("git", ["init", "-b", "main"], { cwd: directory });

  await assert.rejects(
    run(process.execPath, ["scripts/verify-public-source.mjs"], {
      cwd: directory,
      env: { ...process.env, RELEASE_PROHIBITED_TERMS: "private-example" },
    }),
    /binary public source is not allowed/,
  );

  await run("git", ["add", "."], { cwd: directory });
  await run("git", ["-c", "user.name=Release Test", "-c", "user.email=release-test@example.invalid", "commit", "-m", "Initial public source"], { cwd: directory });
  const { stdout } = await run("git", ["rev-parse", "HEAD"], { cwd: directory });
  await assert.rejects(
    run(process.execPath, ["scripts/verify-public-history.mjs"], {
      cwd: directory,
      env: {
        ...process.env,
        RELEASE_PROHIBITED_TERMS: "private-example",
        PUBLIC_HISTORY_ROOT: stdout.trim(),
      },
    }),
    /binary historical source is not allowed/,
  );
});
