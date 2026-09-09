import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureGatewaySecret, readGatewaySecret, windowsSecretPath } from "../src/cli/secret-store.js";

test("Windows secret storage uses a stable per-service DPAPI path", () => {
  const first = windowsSecretPath("figma_gateway", {
    homeDir: "C:\\Users\\Example",
    environment: { LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" },
  });
  const second = windowsSecretPath("figma_gateway", {
    homeDir: "D:\\Other",
    environment: { LOCALAPPDATA: "C:\\Users\\Example\\AppData\\Local" },
  });
  assert.equal(first, second);
  assert.match(first, /FigmaGateway[\\/]secret-[a-f0-9]{16}\.dpapi$/);
  assert.doesNotMatch(first, /figma_gateway/);
});

test("Windows secret reader delegates decryption to the current user's DPAPI context", () => {
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];
  const value = readGatewaySecret("figma_gateway", {
    platform: "win32",
    homeDir: "C:\\Users\\Example",
    environment: { LOCALAPPDATA: "C:\\Local" },
    execFile: ((command, args, options) => {
      calls.push({ command: String(command), args: args || [], options: options as Record<string, unknown> });
      return "decrypted-secret\n";
    }) as typeof import("node:child_process").execFileSync,
  });
  assert.equal(value, "decrypted-secret");
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.command, /powershell/i);
  assert.ok(calls[0]!.args.includes("-NonInteractive"));
  const environment = calls[0]!.options.env as NodeJS.ProcessEnv;
  assert.match(environment.FIGMA_GATEWAY_SECRET_FILE || "", /secret-[a-f0-9]{16}\.dpapi$/);
});

test("Windows secret storage round trips through DPAPI", { skip: process.platform !== "win32" }, async (context) => {
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-dpapi-"));
  context.after(async () => rm(localAppData, { recursive: true, force: true }));
  const dependencies = { platform: "win32" as const, environment: { ...process.env, LOCALAPPDATA: localAppData } };
  const secret = ensureGatewaySecret("figma_gateway_test", dependencies);
  assert.equal(secret.length, 64);
  assert.equal(readGatewaySecret("figma_gateway_test", dependencies), secret);
  const stored = await readFile(windowsSecretPath("figma_gateway_test", dependencies), "utf8");
  assert.doesNotMatch(stored, new RegExp(secret));
});
