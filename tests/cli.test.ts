import assert from "node:assert/strict";
import type { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli/index.js";
import { superviseDaemon } from "../src/cli/daemon-supervisor.js";
import { buildScheduledTaskXml } from "../src/cli/windows-service.js";

test("CLI help hides internal Plugin routing overrides", async () => {
  let text = "";
  await runCli(["--help"], (value) => { text += value; });
  assert.doesNotMatch(text, /--port|--instance/);
});

test("CLI reads connected Plugin files for an isolated profile", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "profile-secret";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "http://127.0.0.1:2195/health");
    assert.equal((init?.headers as Record<string, string>)["x-figma-gateway-secret"], "profile-secret");
    return new Response(JSON.stringify({ ok: true, files: [{ instance: "shared", fileKey: "session-1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let text = "";
  await runCli(["--profile", "client-a", "--port", "2195", "plugin", "files"], (value) => { text += value; });
  assert.deepEqual(JSON.parse(text).files[0], { fileKey: "session-1" });
});

test("CLI hides the internal Plugin identity after applying an internal filter", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    files: [
      { instance: "shared", fileKey: "design-session", editorType: "figma" },
      { instance: "shared", fileKey: "figjam-session", editorType: "figjam" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  let text = "";
  await runCli(["plugin", "files", "--instance", "shared"], (value) => { text += value; });
  assert.deepEqual(JSON.parse(text).files, [
    { fileKey: "design-session", editorType: "figma" },
    { fileKey: "figjam-session", editorType: "figjam" },
  ]);
});

test("CLI calls REST directly with the selected profile token", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.FIGMA_ACCESS_TOKEN;
  const originalKind = process.env.FIGMA_TOKEN_KIND;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.FIGMA_ACCESS_TOKEN;
    else process.env.FIGMA_ACCESS_TOKEN = originalToken;
    if (originalKind === undefined) delete process.env.FIGMA_TOKEN_KIND;
    else process.env.FIGMA_TOKEN_KIND = originalKind;
  });
  process.env.FIGMA_ACCESS_TOKEN = "pat-token";
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), "https://api.figma.com/v1/me");
    assert.equal((init?.headers as Record<string, string>)["x-figma-token"], "pat-token");
    return new Response(JSON.stringify({ id: "user-1" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let text = "";
  await runCli(["--profile", "client-a", "--token-kind", "pat", "rest", "GET", "/v1/me"], (value) => { text += value; });
  assert.equal(JSON.parse(text).data.id, "user-1");
});

test("CLI requires explicit confirmation for arbitrary Plugin execution", async () => {
  await assert.rejects(
    runCli(["--profile", "client-a", "plugin", "exec", "session-1", "--code", "return 1"]),
    /requires --confirm/,
  );
});

test("CLI rejects a non-Figma URL before starting the Plugin", async () => {
  await assert.rejects(
    runCli(["--profile", "client-a", "plugin", "start", "--url", "https://example.com/file"]),
    /must be an https:\/\/figma\.com URL/,
  );
});

test("CLI URL launcher requires a new session on the shared gateway port", async (context) => {
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  const calls: Array<{ command: string; args?: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((command: string, args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args, env: options?.env });
    return { status: 0, stdout: command === "bash" ? "connected\n" : "", stderr: "" };
  }) as unknown as typeof spawnSync;

  await runCli([
    "--profile", "example", "--port", "1995", "plugin", "start", "--url",
    "https://www.figma.com/design/abcdefghijklmnopqrstuv/My%20File?node-id=1-2",
  ], () => undefined, { spawnSync: fakeSpawn });

  const launcher = calls.find((call) => call.command === "bash");
  const open = calls.find((call) => call.command === "open");
  assert.deepEqual(open?.args?.slice(0, 2), ["-a", "/Applications/Figma.app"]);
  assert.equal(launcher?.env?.FIGMA_GATEWAY_PORT, "1995");
  assert.equal(launcher?.env?.FIGMA_VARIANT_BRIDGE_PORT, "1995");
  assert.equal(launcher?.env?.FIGMA_APP, "/Applications/Figma.app");
  assert.equal(launcher?.env?.FIGMA_APP_BUNDLE_ID, "com.figma.Desktop");
  assert.equal(launcher?.env?.FIGMA_REQUIRE_NEW_SESSION, "1");
  assert.equal(launcher?.env?.FIGMA_TARGET_FILE_NAME, "My File");
  assert.equal(launcher?.env?.FIGMA_TARGET_EDITOR_TYPE, "figma");
});

test("CLI starts the unified Plugin and waits for a dev session", async (context) => {
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  const calls: Array<{ command: string; env?: NodeJS.ProcessEnv }> = [];
  const fakeSpawn = ((command: string, _args?: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, env: options?.env });
    return { status: 0, stdout: command === "bash" ? "connected\n" : "", stderr: "" };
  }) as unknown as typeof spawnSync;

  await runCli([
    "--profile", "local", "plugin", "start",
    "--mode", "dev", "--window", "Product Workspace",
  ], () => undefined, { spawnSync: fakeSpawn });

  const launcher = calls.find((call) => call.command === "bash");
  assert.equal(launcher?.env?.FIGMA_TARGET_INSTANCE, "shared");
  assert.equal(launcher?.env?.FIGMA_TARGET_EDITOR_TYPE, "dev");
});

test("CLI filters connected files by editor type", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: true,
    files: [
      { instance: "shared", fileKey: "canvas", editorType: "figma" },
      { instance: "shared", fileKey: "dev", editorType: "dev" },
    ],
  }), { status: 200, headers: { "content-type": "application/json" } });
  let text = "";
  await runCli(["plugin", "files", "--editor-type", "dev"], (value) => { text += value; });
  assert.deepEqual(JSON.parse(text).files, [
    { fileKey: "dev", editorType: "dev" },
  ]);
});

test("CLI passes Motion video export settings to the Plugin", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  let request: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ ok: true, result: { succeeded: 1, failed: 0 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  await runCli([
    "plugin", "export", "motion-session", "1:2", "out/animation.mp4",
    "--format", "MP4", "--scale", "1.5", "--fps", "60", "--quality", "high",
  ], () => undefined);
  const rpc = request as { tool?: string; arguments?: { items?: Array<Record<string, unknown>> } };
  assert.equal(rpc.tool, "save_screenshots");
  assert.deepEqual(rpc.arguments?.items?.[0], {
    nodeId: "1:2",
    outputPath: "out/animation.mp4",
    format: "MP4",
    scale: 1.5,
    fps: 60,
    quality: "HIGH",
  });
});

test("CLI lists and focuses Figma Desktop windows", async () => {
  const calls: Array<{ command: string; args?: readonly string[] }> = [];
  const fakeSpawn = ((command: string, args?: readonly string[]) => {
    calls.push({ command, args });
    if (command === "pgrep") return { status: 0, stdout: "12345\n", stderr: "" };
    if (command === "osascript" && args?.includes("Product_v1_ScreenDesign")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "Icon Master\nProduct_v1_ScreenDesign\n", stderr: "" };
  }) as unknown as typeof spawnSync;
  let listed = "";
  await runCli([
    "--profile", "example", "plugin", "windows",
  ], (value) => { listed += value; }, { spawnSync: fakeSpawn });
  assert.equal(JSON.parse(listed).app, "/Applications/Figma.app");
  assert.deepEqual(JSON.parse(listed).windows, ["Icon Master", "Product_v1_ScreenDesign"]);

  let focused = "";
  await runCli([
    "--profile", "example", "plugin", "focus", "Product_v1_ScreenDesign",
  ], (value) => { focused += value; }, { spawnSync: fakeSpawn });
  assert.equal(JSON.parse(focused).app, "/Applications/Figma.app");
  assert.equal(JSON.parse(focused).window, "Product_v1_ScreenDesign");
  assert.equal(calls.filter((call) => call.command === "osascript").length, 2);
});

test("CLI dispatches one operation to multiple Figma sessions concurrently", async (context) => {
  const originalFetch = globalThis.fetch;
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  context.after(() => {
    globalThis.fetch = originalFetch;
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
  });
  process.env.FIGMA_GATEWAY_SECRET = "shared-secret";
  const pending: Array<{
    fileKey: string;
    resolve: (response: Response) => void;
  }> = [];
  globalThis.fetch = async (_input, init) => new Promise<Response>((resolve) => {
    const request = JSON.parse(String(init?.body));
    pending.push({ fileKey: request.arguments.fileKey, resolve });
    if (pending.length === 2) {
      for (const item of pending) {
        item.resolve(new Response(JSON.stringify({
          ok: true,
          result: { file: item.fileKey },
        }), { status: 200, headers: { "content-type": "application/json" } }));
      }
    }
  });

  let text = "";
  await runCli([
    "plugin", "exec-many", "icon-session", "mit-session",
    "--code", "return figma.root.name", "--confirm",
  ], (value) => { text += value; });
  assert.deepEqual(pending.map((item) => item.fileKey), ["icon-session", "mit-session"]);
  assert.deepEqual(JSON.parse(text), {
    concurrent: true,
    results: [
      { success: true, fileKey: "icon-session", result: { file: "icon-session" } },
      { success: true, fileKey: "mit-session", result: { file: "mit-session" } },
    ],
  });
});

test("CLI installs the daemon as a macOS login service without embedding its secret", async (context) => {
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-service-"));
  context.after(async () => {
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
    await rm(homeDir, { recursive: true, force: true });
  });
  process.env.FIGMA_GATEWAY_SECRET = "must-not-appear-in-plist";
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let bootstrapAttempts = 0;
  let loaded = true;
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args });
    if (command === "security") return { status: 0, stdout: "keychain-secret\n", stderr: "" };
    if (command === "launchctl" && args[0] === "bootout") {
      loaded = false;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "launchctl" && args[0] === "bootstrap" && ++bootstrapAttempts === 1) {
      return { status: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
    }
    if (command === "launchctl" && args[0] === "bootstrap") {
      loaded = true;
      return { status: 0, stdout: "", stderr: "" };
    }
    if (command === "launchctl" && args[0] === "print") {
      return loaded
        ? { status: 0, stdout: "state = running\npid = 12345\n", stderr: "" }
        : { status: 113, stdout: "", stderr: "Could not find service" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  let text = "";

  await runCli([
    "--profile", "example", "--port", "2195", "--secret-service", "figma_gateway",
    "daemon", "install",
  ], (value) => { text += value; }, {
    daemonService: {
      spawn: fakeSpawn,
      homeDir,
      uid: 501,
      platform: "darwin",
      nodePath: "/opt/node/bin/node",
      entrypoint: "/opt/figma-gateway/dist/cli/index.js",
      pathValue: "/opt/node/bin:/usr/bin:/bin",
    },
  });

  const status = JSON.parse(text);
  assert.equal(status.installed, true);
  assert.equal(status.loaded, true);
  assert.equal(status.state, "running");
  assert.equal(status.profile, "example");
  assert.equal("port" in status, false);
  assert.equal(status.secretService, "figma_gateway");
  const plist = await readFile(path.join(
    homeDir, "Library", "LaunchAgents", "jp.co.arcm.FigmaGateway.plist",
  ), "utf8");
  const plistStat = await stat(path.join(
    homeDir, "Library", "LaunchAgents", "jp.co.arcm.FigmaGateway.plist",
  ));
  assert.equal(plistStat.mode & 0o777, 0o644);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
  assert.match(plist, /<string>\/opt\/figma-gateway\/dist\/cli\/index\.js<\/string>/);
  assert.match(plist, /<string>example<\/string>/);
  assert.match(plist, /<string>2195<\/string>/);
  assert.match(plist, /<string>figma_gateway<\/string>/);
  assert.match(plist, /<string>daemon<\/string>\s*<string>supervise<\/string>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.doesNotMatch(plist, /must-not-appear-in-plist|keychain-secret/);
  assert.equal(calls.filter((call) => call.command === "launchctl" && call.args[0] === "bootstrap").length, 2);
  assert.ok(calls.some((call) => call.command === "launchctl" && call.args[0] === "kickstart"));

  text = "";
  await runCli([
    "--profile", "local", "--port", "2999", "daemon", "status",
  ], (value) => { text += value; }, {
    daemonService: { spawn: fakeSpawn, homeDir, uid: 501, platform: "darwin" },
  });
  const statusWithDifferentArguments = JSON.parse(text);
  assert.equal(statusWithDifferentArguments.profile, "example");
  assert.equal("port" in statusWithDifferentArguments, false);

  text = "";
  await runCli(["daemon", "stop"], (value) => { text += value; }, {
    daemonService: { spawn: fakeSpawn, homeDir, uid: 501, platform: "darwin" },
  });
  assert.equal(JSON.parse(text).loaded, false);

  text = "";
  await runCli(["daemon", "start"], (value) => { text += value; }, {
    daemonService: { spawn: fakeSpawn, homeDir, uid: 501, platform: "darwin" },
  });
  assert.equal(JSON.parse(text).loaded, true);
});

test("Windows login task restarts the supervisor without embedding the secret", () => {
  const xml = buildScheduledTaskXml({
    profile: {
      name: "local",
      port: 1995,
      app: "Figma",
      tokenKind: "pat",
      tokenService: "figma_token",
      secretService: "figma_gateway",
      secret: "must-not-appear-in-task",
    },
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    entrypoint: "C:\\Program Files\\Figma Gateway\\dist\\cli\\index.js",
    username: "Example User",
  });
  assert.match(xml, /<LogonTrigger>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<RestartOnFailure><Interval>PT1M<\/Interval><Count>999<\/Count><\/RestartOnFailure>/);
  assert.match(xml, /daemon.*supervise/);
  assert.doesNotMatch(xml, /must-not-appear-in-task/);
});

test("CLI installs and starts the Windows login task", async (context) => {
  const originalSecret = process.env.FIGMA_GATEWAY_SECRET;
  const localAppData = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-windows-service-"));
  context.after(async () => {
    if (originalSecret === undefined) delete process.env.FIGMA_GATEWAY_SECRET;
    else process.env.FIGMA_GATEWAY_SECRET = originalSecret;
    await rm(localAppData, { recursive: true, force: true });
  });
  process.env.FIGMA_GATEWAY_SECRET = "must-not-appear-in-task";
  let registered = false;
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  const fakeSpawn = ((command: string, args: readonly string[] = []) => {
    calls.push({ command, args });
    if (args[0] === "/Query") return { status: registered ? 0 : 1, stdout: "", stderr: "" };
    if (args[0] === "/Create") registered = true;
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  let text = "";
  await runCli(["--profile", "local", "daemon", "install"], (value) => { text += value; }, {
    daemonService: {
      platform: "win32",
      spawn: fakeSpawn,
      localAppData,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entrypoint: "C:\\Program Files\\Figma Gateway\\dist\\cli\\index.js",
      username: "Example User",
    },
  });
  assert.equal(JSON.parse(text).installed, true);
  const taskPath = path.join(localAppData, "FigmaGateway", "service", "task.xml");
  const task = await readFile(taskPath, "utf16le");
  assert.match(task, /daemon.*supervise/);
  assert.doesNotMatch(task, /must-not-appear-in-task/);
  assert.ok(calls.some((call) => call.args[0] === "/Create"));
  assert.ok(calls.some((call) => call.args[0] === "/Run"));

  text = "";
  await runCli(["--profile", "local", "daemon", "install"], (value) => { text += value; }, {
    daemonService: {
      platform: "win32",
      spawn: fakeSpawn,
      localAppData,
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      entrypoint: "C:\\Program Files\\Figma Gateway\\dist\\cli\\index.js",
      username: "Example User",
    },
  });
  const secondCreate = calls.findLastIndex((call) => call.args[0] === "/Create");
  const upgradeStop = calls.findLastIndex((call) => call.args[0] === "/End");
  assert.ok(upgradeStop >= 0 && upgradeStop < secondCreate);
});

test("daemon supervisor restarts a worker after repeated failed health checks", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "figma-gateway-supervisor-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const entrypoint = path.join(directory, "worker.mjs");
  await writeFile(entrypoint, "setInterval(() => undefined, 1000);\n", "utf8");
  const events: string[] = [];
  await superviseDaemon({
    name: "local",
    port: 1995,
    app: "Figma",
    tokenKind: "pat",
    tokenService: "figma_token",
    secretService: "figma_gateway",
    secret: "test-secret",
  }, (value) => events.push(value), {
    nodePath: process.execPath,
    entrypoint,
    fetch: async () => { throw new Error("unhealthy"); },
    healthIntervalMs: 5,
    startupGraceMs: 0,
    unhealthyLimit: 1,
    restartDelayMs: 1,
    maxCycles: 2,
  });
  assert.equal(events.filter((value) => value.includes("worker_started")).length, 2);
  assert.equal(events.filter((value) => value.includes("worker_unhealthy")).length, 2);
  assert.doesNotMatch(events.join(""), /test-secret/);
});

test("CLI requires confirmation before uninstalling the managed daemon", async () => {
  await assert.rejects(
    runCli(["daemon", "uninstall"], () => undefined, {
      daemonService: { platform: "darwin", homeDir: "/tmp", uid: 501 },
    }),
    /requires --confirm/,
  );
});

test("CLI reports an error when launchd does not unload the daemon", async () => {
  const fakeSpawn = ((_command: string, args: readonly string[] = []) => {
    if (args[0] === "print") {
      return { status: 0, stdout: "state = running\npid = 12345\n", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }) as unknown as typeof spawnSync;
  await assert.rejects(
    runCli(["daemon", "stop"], () => undefined, {
      daemonService: {
        spawn: fakeSpawn,
        platform: "darwin",
        homeDir: "/tmp",
        uid: 501,
        waitDelays: [0],
      },
    }),
    /Daemon did not stop \(state: running\)/,
  );
});
