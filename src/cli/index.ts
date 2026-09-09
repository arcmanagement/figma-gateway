#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyRestProfile, requireSecret, resolveProfile, type GlobalOptions } from "./config.js";
import { runDaemonService, type DaemonServiceDependencies } from "./daemon-service.js";
import { superviseDaemon } from "./daemon-supervisor.js";
import { buildLocalPlugin } from "./plugin-build.js";
import { ensureGatewaySecret } from "./secret-store.js";
import { GatewayHub } from "../server/gateway.js";
import { credentialStatus, figmaRestRequest, type RestRequest } from "../server/rest.js";
import { focusFigmaWindow, listFigmaWindows } from "./windows.js";

type Writer = (value: string) => void;
type Parsed = { positionals: string[]; options: Map<string, string | true> };

const HELP = `figma-gateway — CLI + Figma Plugin gateway

Usage:
  figma-gateway [global options] setup
  figma-gateway [global options] status
  figma-gateway [global options] daemon
  figma-gateway [global options] daemon supervise
  figma-gateway [global options] daemon install
  figma-gateway [global options] daemon start|stop|restart|status
  figma-gateway [global options] daemon uninstall --confirm
  figma-gateway [global options] plugin build
  figma-gateway [global options] plugin windows
  figma-gateway [global options] plugin focus <file-name>
  figma-gateway [global options] plugin start [--url FIGMA_URL] [--window FILE_NAME] [--mode auto|design|dev|figjam|slides|buzz|motion] [--reload]
  figma-gateway [global options] plugin files [--editor-type TYPE]
  figma-gateway [global options] plugin node <session-key> <node-id> [--depth N]
  figma-gateway [global options] plugin exec <session-key> (--code JS | --code-file PATH) [--args JSON] --confirm
  figma-gateway [global options] plugin exec-many <session-key>... (--code JS | --code-file PATH) [--args JSON] --confirm
  figma-gateway [global options] plugin export <session-key> <node-id> <output> [--format PNG|JPG|SVG|PDF|MP4|GIF|WEBM] [--scale N] [--fps N] [--quality LEVEL] [--loop-count N]
  figma-gateway [global options] rest <METHOD> <PATH> [--query JSON] [--body JSON|@FILE] [--save PATH] [--confirm]
  figma-gateway [global options] auth status
  figma-gateway [global options] auth store <oauth|pat|plan>
  figma-gateway [global options] auth remove <oauth|pat|plan> --confirm

Global options:
  --profile NAME         REST credential profile
  --token-kind KIND      oauth, pat, or plan (default: environment or pat)
  --token-service NAME   REST credential Keychain service
  --secret-service NAME  Plugin gateway credential service
`;

function parseGlobal(argv: string[]): { options: GlobalOptions; remaining: string[] } {
  const options: GlobalOptions = {};
  const names: Record<string, keyof GlobalOptions> = {
    "--profile": "profile",
    "--port": "port",
    "--token-kind": "tokenKind",
    "--token-service": "tokenService",
    "--secret-service": "secretService",
  };
  let index = 0;
  while (index < argv.length && argv[index]?.startsWith("--")) {
    const name = argv[index]!;
    if (name === "--help") return { options, remaining: ["help"] };
    const key = names[name];
    if (!key) throw new Error(`Unknown global option: ${name}`);
    const value = argv[index + 1];
    if (!value) throw new Error(`${name} requires a value`);
    options[key] = value;
    index += 2;
  }
  return { options, remaining: argv.slice(index) };
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    if (["--confirm", "--reload"].includes(value)) {
      options.set(value, true);
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined) throw new Error(`${value} requires a value`);
    options.set(value, next);
    index += 1;
  }
  return { positionals, options };
}

async function jsonArgument(value: string | true | undefined, label: string): Promise<unknown> {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const raw = value.startsWith("@") ? await readFile(value.slice(1), "utf8") : value;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function output(writer: Writer, value: unknown): void {
  writer(`${JSON.stringify(value, null, 2)}\n`);
}

async function pluginHealth(profile: ReturnType<typeof resolveProfile>): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${profile.port}/health`, {
    headers: { "x-figma-gateway-secret": requireSecret(profile) },
  });
  if (!response.ok) throw new Error(`Plugin gateway health failed: ${response.status}`);
  return response.json();
}

function publicPluginHealth(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const health = value as Record<string, unknown>;
  if (!Array.isArray(health.files)) return health;
  return {
    ...health,
    files: health.files.map((file) => {
      if (!file || typeof file !== "object") return file;
      const { instance: _instance, ...visible } = file as Record<string, unknown>;
      return visible;
    }),
  };
}

async function pluginRpc(
  profile: ReturnType<typeof resolveProfile>,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${profile.port}/rpc`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-figma-gateway-secret": requireSecret(profile),
    },
    body: JSON.stringify({ tool, arguments: args, cwd: process.cwd() }),
  });
  const value = await response.json() as { ok?: boolean; result?: unknown; error?: string };
  if (!response.ok || !value.ok) throw new Error(value.error || `Plugin gateway RPC failed: ${response.status}`);
  return value.result;
}

async function runDaemon(profile: ReturnType<typeof resolveProfile>, writer: Writer): Promise<void> {
  const hub = new GatewayHub(profile.port, requireSecret(profile));
  if (!await hub.start()) throw new Error(`Port ${profile.port} is already in use`);
  output(writer, { ok: true });
  await new Promise<void>((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
  await hub.close();
}

async function runPlugin(
  profile: ReturnType<typeof resolveProfile>,
  argv: string[],
  writer: Writer,
  spawn: typeof spawnSync = spawnSync,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const action = argv[0];
  const parsed = parse(argv.slice(1));
  if (action === "build") {
    return output(writer, { ok: true, manifest: buildLocalPlugin(profile), manualImportRequired: true });
  }
  if (action === "windows") {
    if (platform !== "darwin") throw new Error("Figma window listing is supported on macOS only");
    return output(writer, { app: profile.app, windows: listFigmaWindows(profile.app, spawn) });
  }
  if (action === "focus") {
    if (platform !== "darwin") throw new Error("Figma window focus is supported on macOS only");
    const fileName = parsed.positionals.join(" ");
    focusFigmaWindow(profile.app, fileName, spawn);
    return output(writer, { ok: true, app: profile.app, window: fileName });
  }
  if (action === "start") {
    if (platform !== "darwin") {
      throw new Error("Automatic Plugin start is supported on macOS only. Start Figma Gateway from Plugins > Development.");
    }
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const urlValue = parsed.options.get("--url");
    let targetFileName = typeof parsed.options.get("--window") === "string"
      ? String(parsed.options.get("--window"))
      : "";
    const requestedMode = String(parsed.options.get("--mode") || "auto");
    const modes = ["auto", "canvas", "design", "dev", "figjam", "slides", "buzz", "motion"];
    if (!modes.includes(requestedMode)) {
      throw new Error("--mode must be auto, design, dev, figjam, slides, buzz, or motion");
    }
    const explicitEditorTypes: Record<string, string> = {
      canvas: "figma",
      design: "figma",
      dev: "dev",
      figjam: "figjam",
      slides: "slides",
      buzz: "buzz",
      motion: "figma",
    };
    let targetEditorType = explicitEditorTypes[requestedMode] || "";
    if (typeof urlValue === "string") {
      const url = new URL(urlValue);
      if (url.protocol !== "https:" || !["figma.com", "www.figma.com"].includes(url.hostname)) {
        throw new Error("--url must be an https://figma.com URL");
      }
      if (requestedMode === "auto") {
        if (url.pathname.startsWith("/board/")) targetEditorType = "figjam";
        else if (url.pathname.startsWith("/slides/")) targetEditorType = "slides";
        else if (url.pathname.startsWith("/buzz/")) targetEditorType = "buzz";
        else targetEditorType = "figma";
      }
      targetFileName ||= decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "");
      const opened = spawn("open", ["-a", profile.app, url.href], { encoding: "utf8" });
      if (opened.status !== 0) throw new Error((opened.stderr || "Could not open Figma URL").trim());
    }
    const result = spawn("bash", [path.join(root, "scripts", "start-plugin.sh"), ...(parsed.options.has("--reload") ? ["--reload"] : [])], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FIGMA_CONFIG_FILE: "/dev/null",
        FIGMA_VARIANT: profile.name,
        FIGMA_APP: profile.app,
        FIGMA_APP_BUNDLE_ID: "com.figma.Desktop",
        FIGMA_VARIANT_BRIDGE_PORT: String(profile.port),
        FIGMA_BRIDGE_PORT: String(profile.port),
        FIGMA_GATEWAY_PORT: String(profile.port),
        FIGMA_GATEWAY_SECRET: requireSecret(profile),
        FIGMA_TOKEN_KIND: profile.tokenKind,
        FIGMA_TOKEN_KEYCHAIN_ITEM: profile.tokenService,
        FIGMA_TARGET_INSTANCE: "shared",
        FIGMA_TARGET_FILE_NAME: targetFileName,
        FIGMA_TARGET_EDITOR_TYPE: targetEditorType,
        FIGMA_REQUIRE_NEW_SESSION: targetFileName ? "1" : "0",
      },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error((result.stderr || result.stdout || "Plugin start failed").trim());
    writer(result.stdout);
    return;
  }
  if (action === "files") {
    const health = await pluginHealth(profile) as {
      ok?: boolean;
      files?: Array<{ instance?: string; editorType?: string }>;
    };
    const instance = parsed.options.get("--instance");
    const editorType = parsed.options.get("--editor-type");
    if (typeof instance === "string") {
      health.files = (health.files || []).filter((file) => file.instance === instance);
    }
    if (typeof editorType === "string") {
      health.files = (health.files || []).filter((file) => file.editorType === editorType);
    }
    return output(writer, publicPluginHealth(health));
  }
  const fileKey = parsed.positionals[0];
  if (!fileKey) throw new Error(`${action || "plugin command"} requires a session key`);
  if (action === "node") {
    const nodeId = parsed.positionals[1];
    if (!nodeId) throw new Error("plugin node requires a node ID");
    const depthValue = parsed.options.get("--depth");
    const depth = typeof depthValue === "string" ? Number(depthValue) : undefined;
    if (depth !== undefined && (!Number.isInteger(depth) || depth < 0)) {
      throw new Error("--depth must be a non-negative integer");
    }
    return output(writer, await pluginRpc(profile, "get_node", {
      fileKey,
      nodeId,
      ...(depth !== undefined ? { depth } : {}),
    }));
  }
  if (action === "exec") {
    if (!parsed.options.has("--confirm")) throw new Error("plugin exec requires --confirm");
    const codeValue = parsed.options.get("--code");
    const codeFile = parsed.options.get("--code-file");
    if ((typeof codeValue === "string") === (typeof codeFile === "string")) {
      throw new Error("plugin exec requires exactly one of --code or --code-file");
    }
    const code = typeof codeValue === "string" ? codeValue : await readFile(String(codeFile), "utf8");
    const args = parsed.options.has("--args") ? await jsonArgument(parsed.options.get("--args"), "--args") : {};
    return output(writer, await pluginRpc(profile, "execute_plugin_code", { fileKey, code, args, confirm: true }));
  }
  if (action === "exec-many") {
    if (!parsed.options.has("--confirm")) throw new Error("plugin exec-many requires --confirm");
    const codeValue = parsed.options.get("--code");
    const codeFile = parsed.options.get("--code-file");
    if ((typeof codeValue === "string") === (typeof codeFile === "string")) {
      throw new Error("plugin exec-many requires exactly one of --code or --code-file");
    }
    const code = typeof codeValue === "string" ? codeValue : await readFile(String(codeFile), "utf8");
    const args = parsed.options.has("--args") ? await jsonArgument(parsed.options.get("--args"), "--args") : {};
    const settled = await Promise.allSettled(parsed.positionals.map(async (sessionKey) => ({
      fileKey: sessionKey,
      result: await pluginRpc(profile, "execute_plugin_code", {
        fileKey: sessionKey,
        code,
        args,
        confirm: true,
      }),
    })));
    return output(writer, {
      concurrent: true,
      results: settled.map((result, index) => result.status === "fulfilled"
        ? { success: true, ...result.value }
        : {
            success: false,
            fileKey: parsed.positionals[index],
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          }),
    });
  }
  if (action === "export") {
    const [nodeId, outputPath] = parsed.positionals.slice(1);
    if (!nodeId || !outputPath) throw new Error("plugin export requires node ID and output path");
    const format = String(parsed.options.get("--format") || "PNG").toUpperCase();
    const scale = Number(parsed.options.get("--scale") || 1);
    if (!["PNG", "JPG", "SVG", "PDF", "MP4", "GIF", "WEBM"].includes(format)) {
      throw new Error(`Unsupported format: ${format}`);
    }
    if (!Number.isFinite(scale) || scale <= 0) throw new Error("--scale must be a positive number");
    const fpsValue = parsed.options.get("--fps");
    const qualityValue = parsed.options.get("--quality");
    const loopCountValue = parsed.options.get("--loop-count");
    const fps = typeof fpsValue === "string" ? Number(fpsValue) : undefined;
    const quality = typeof qualityValue === "string" ? qualityValue.toUpperCase() : undefined;
    const loopCount = typeof loopCountValue === "string" ? Number(loopCountValue) : undefined;
    if (fps !== undefined && (!Number.isInteger(fps) || fps <= 0)) {
      throw new Error("--fps must be a positive integer");
    }
    if (quality !== undefined && !["LOW", "MEDIUM", "HIGH"].includes(quality)) {
      throw new Error("--quality must be LOW, MEDIUM, or HIGH");
    }
    if (loopCount !== undefined && (!Number.isInteger(loopCount) || loopCount < 0 || loopCount > 1000)) {
      throw new Error("--loop-count must be an integer from 0 to 1000");
    }
    return output(writer, await pluginRpc(profile, "save_screenshots", {
      fileKey,
      items: [{
        nodeId,
        outputPath,
        format,
        scale,
        ...(fps !== undefined ? { fps } : {}),
        ...(quality !== undefined ? { quality } : {}),
        ...(loopCount !== undefined ? { loopCount } : {}),
      }],
    }));
  }
  throw new Error(`Unknown plugin command: ${action || ""}`);
}

async function runRest(profile: ReturnType<typeof resolveProfile>, argv: string[], writer: Writer): Promise<void> {
  const parsed = parse(argv);
  const methodValue = (parsed.positionals[0] || "GET").toUpperCase();
  const requestPath = parsed.positionals[1];
  if (!requestPath) throw new Error("rest requires METHOD and PATH");
  if (!(["GET", "POST", "PUT", "PATCH", "DELETE"] as string[]).includes(methodValue)) {
    throw new Error(`Unsupported REST method: ${methodValue}`);
  }
  const method = methodValue as NonNullable<RestRequest["method"]>;
  applyRestProfile(profile);
  const query = parsed.options.has("--query") ? await jsonArgument(parsed.options.get("--query"), "--query") : undefined;
  const body = parsed.options.has("--body") ? await jsonArgument(parsed.options.get("--body"), "--body") : undefined;
  output(writer, await figmaRestRequest({
    method,
    path: requestPath,
    query: query as RestRequest["query"],
    body,
    saveTo: typeof parsed.options.get("--save") === "string" ? String(parsed.options.get("--save")) : undefined,
    confirm: parsed.options.has("--confirm"),
  }));
}

async function runAuth(
  global: GlobalOptions,
  argv: string[],
  writer: Writer,
): Promise<void> {
  const action = argv[0] || "status";
  const kind = argv[1] || global.tokenKind || process.env.FIGMA_TOKEN_KIND || "pat";
  const name = global.profile || process.env.FIGMA_VARIANT || "local";
  const tokenService = global.tokenService || (argv[1] ? `figma_token_${name}_${kind}` : undefined);
  const profile = resolveProfile({ ...global, tokenKind: kind, tokenService });
  applyRestProfile(profile);
  if (action === "status") return output(writer, await credentialStatus());
  if (!["store", "remove"].includes(action)) throw new Error(`Unknown auth command: ${action}`);
  if (process.platform === "win32") {
    throw new Error("Persistent REST credential commands are supported on macOS only. Set FIGMA_ACCESS_TOKEN for the current Windows session.");
  }
  const parsed = parse(argv.slice(2));
  if (action === "remove" && !parsed.options.has("--confirm")) throw new Error("auth remove requires --confirm");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const result = spawnSync("python3", [
    path.join(root, "scripts", "figma-auth.py"), action,
    "--kind", profile.tokenKind,
    "--service", profile.tokenService,
  ], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error(`auth ${action} failed with status ${result.status}`);
}

export async function runCli(
  argv: string[],
  writer: Writer = (value) => process.stdout.write(value),
  dependencies: {
    spawnSync?: typeof spawnSync;
    daemonService?: DaemonServiceDependencies;
    platform?: NodeJS.Platform;
  } = {},
): Promise<void> {
  const { options: global, remaining } = parseGlobal(argv);
  const command = remaining[0];
  if (!command || command === "help") {
    writer(HELP);
    return;
  }
  if (command === "auth") return runAuth(global, remaining.slice(1), writer);
  const profile = resolveProfile(global);
  if (!profile.secret && (command === "setup" || (command === "daemon" && remaining[1] === "install"))) {
    profile.secret = ensureGatewaySecret(profile.secretService);
  }
  if (!profile.secret && command === "plugin" && remaining[1] === "build") {
    profile.secret = ensureGatewaySecret(profile.secretService);
  }
  if (command === "status") {
    applyRestProfile(profile);
    let plugin: unknown;
    try { plugin = await pluginHealth(profile); } catch (error) {
      plugin = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    output(writer, {
      profile: profile.name,
      plugin: publicPluginHealth(plugin),
      rest: await credentialStatus(),
    });
    return;
  }
  if (command === "setup") {
    const manifest = buildLocalPlugin(profile);
    let daemonText = "";
    await runDaemonService(profile, ["install"], (value) => { daemonText += value; }, {
      ...dependencies.daemonService,
      spawn: dependencies.daemonService?.spawn || dependencies.spawnSync,
    });
    output(writer, {
      ok: true,
      manifest,
      manualImportRequired: true,
      daemon: JSON.parse(daemonText),
    });
    return;
  }
  if (command === "daemon") {
    if (remaining.length === 1) return runDaemon(profile, writer);
    if (remaining[1] === "supervise") return superviseDaemon(profile, writer);
    return runDaemonService(profile, remaining.slice(1), writer, {
      ...dependencies.daemonService,
      spawn: dependencies.daemonService?.spawn || dependencies.spawnSync,
    });
  }
  if (command === "plugin") {
    return runPlugin(profile, remaining.slice(1), writer, dependencies.spawnSync, dependencies.platform);
  }
  if (command === "rest") return runRest(profile, remaining.slice(1), writer);
  throw new Error(`Unknown command: ${command}`);
}

async function isEntrypoint(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  }
}

if (await isEntrypoint()) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`ERROR: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
