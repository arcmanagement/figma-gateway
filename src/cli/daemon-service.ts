import { spawnSync } from "node:child_process";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliProfile } from "./config.js";
import { runWindowsDaemonService } from "./windows-service.js";

export const DAEMON_SERVICE_LABEL = "jp.co.arcm.FigmaGateway";

type Writer = (value: string) => void;
type Spawn = typeof spawnSync;

export interface DaemonServiceDependencies {
  spawn?: Spawn;
  homeDir?: string;
  uid?: number;
  platform?: NodeJS.Platform;
  nodePath?: string;
  entrypoint?: string;
  pathValue?: string;
  waitDelays?: number[];
  localAppData?: string;
  username?: string;
}

export interface DaemonServiceConfig {
  profile: CliProfile;
  nodePath: string;
  entrypoint: string;
  logPath: string;
  pathValue: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringEntry(value: string): string {
  return `    <string>${xml(value)}</string>`;
}

function unxml(value: string): string {
  return value
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}

export function buildLaunchAgentPlist(config: DaemonServiceConfig): string {
  const args = [
    config.nodePath,
    config.entrypoint,
    "--profile",
    config.profile.name,
    "--port",
    String(config.profile.port),
    "--secret-service",
    config.profile.secretService,
    "daemon",
    "supervise",
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DAEMON_SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(stringEntry).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(config.pathValue)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ExitTimeOut</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(config.logPath)}</string>
</dict>
</plist>
`;
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function run(spawn: Spawn, command: string, args: string[], allowFailure = false): ReturnType<Spawn> {
  const result = spawn(command, args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = resultText(result.stderr) || resultText(result.stdout) || result.error?.message || "unknown error";
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

async function bootstrap(spawn: Spawn, domain: string, plistPath: string): Promise<void> {
  let result: ReturnType<Spawn> | undefined;
  for (const delay of [0, 100, 250, 500, 1_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    result = run(spawn, "launchctl", ["bootstrap", domain, plistPath], true);
    if (!result.error && result.status === 0) return;
  }
  const detail = resultText(result?.stderr) || resultText(result?.stdout) || result?.error?.message || "unknown error";
  throw new Error(`launchctl bootstrap ${domain} ${plistPath} failed: ${detail}`);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function installedConfiguration(plistPath: string): Promise<{
  profile: string;
  port: number;
  secretService: string;
} | null> {
  if (!await exists(plistPath)) return null;
  const source = await readFile(plistPath, "utf8");
  const argumentsBlock = source.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1];
  if (!argumentsBlock) return null;
  const args = [...argumentsBlock.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((match) => unxml(match[1]!));
  const valueAfter = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const profile = valueAfter("--profile");
  const port = Number(valueAfter("--port"));
  const secretService = valueAfter("--secret-service");
  if (!profile || !Number.isInteger(port) || port < 1 || port > 65535 || !secretService) return null;
  return { profile, port, secretService };
}

function statusValue(spawn: Spawn, target: string): { loaded: boolean; state: string | null; pid: number | null } {
  const result = run(spawn, "launchctl", ["print", target], true);
  const text = resultText(result.stdout);
  const state = text.match(/^\s*state = (\S+)/m)?.[1] || null;
  const pidValue = text.match(/^\s*pid = (\d+)/m)?.[1];
  return {
    loaded: result.status === 0,
    state,
    pid: pidValue ? Number(pidValue) : null,
  };
}

async function waitForUnload(spawn: Spawn, target: string, delays: number[]): Promise<void> {
  let status = statusValue(spawn, target);
  for (const delay of delays) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    status = statusValue(spawn, target);
    if (!status.loaded) return;
  }
  throw new Error(`Daemon did not stop (state: ${status.state || "unknown"})`);
}

async function waitForRunning(spawn: Spawn, target: string): Promise<void> {
  let status = statusValue(spawn, target);
  for (const delay of [0, 50, 100, 250, 500, 1_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    status = statusValue(spawn, target);
    if (status.loaded && status.state === "running" && status.pid !== null) return;
  }
  throw new Error(`Daemon did not reach the running state (state: ${status.state || "not loaded"})`);
}

export async function runDaemonService(
  profile: CliProfile,
  argv: string[],
  writer: Writer,
  dependencies: DaemonServiceDependencies = {},
): Promise<void> {
  const platform = dependencies.platform || process.platform;
  if (platform === "win32") {
    return runWindowsDaemonService(profile, argv, writer, dependencies);
  }
  if (platform !== "darwin") throw new Error("Managed daemon commands are supported on macOS and Windows only");

  const action = argv[0] || "status";
  const confirm = argv.slice(1).includes("--confirm");
  const spawn = dependencies.spawn || spawnSync;
  const homeDir = dependencies.homeDir || os.userInfo().homedir;
  const uid = dependencies.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("Could not determine the current user ID");

  const launchAgentsDir = path.join(homeDir, "Library", "LaunchAgents");
  const logsDir = path.join(homeDir, "Library", "Logs");
  const plistPath = path.join(launchAgentsDir, `${DAEMON_SERVICE_LABEL}.plist`);
  const logPath = path.join(logsDir, "figma-gateway.log");
  const domain = `gui/${uid}`;
  const target = `${domain}/${DAEMON_SERVICE_LABEL}`;
  const waitDelays = dependencies.waitDelays || [0, 100, 250, 500, 1_000, 2_000, 4_000, 8_000];
  const serviceStatus = async (): Promise<Record<string, unknown>> => {
    const installed = await exists(plistPath);
    const configuration = installed ? await installedConfiguration(plistPath) : null;
    return {
      ok: true,
      service: DAEMON_SERVICE_LABEL,
      profile: configuration?.profile || null,
      secretService: configuration?.secretService || null,
      plist: plistPath,
      installed,
      configured: configuration !== null,
      ...statusValue(spawn, target),
    };
  };

  if (action === "status") {
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "install") {
    if (!profile.secret) throw new Error(`Shared gateway secret is missing from Keychain service: ${profile.secretService}`);
    const keychain = run(spawn, "security", ["find-generic-password", "-w", "-s", profile.secretService], true);
    if (keychain.status !== 0 || !resultText(keychain.stdout)) {
      throw new Error(`Shared gateway secret must be stored in Keychain service: ${profile.secretService}`);
    }
    await mkdir(launchAgentsDir, { recursive: true });
    await mkdir(logsDir, { recursive: true });
    const nodePath = dependencies.nodePath || process.execPath;
    const entrypoint = dependencies.entrypoint || process.argv[1];
    if (!entrypoint) throw new Error("Could not determine the figma-gateway entrypoint");
    const defaultPath = [
      path.dirname(nodePath),
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ];
    const pathValue = dependencies.pathValue || [...new Set(defaultPath)].join(":");
    const temporaryPath = `${plistPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, buildLaunchAgentPlist({
      profile,
      nodePath,
      entrypoint,
      logPath,
      pathValue,
    }), { encoding: "utf8", mode: 0o644 });
    run(spawn, "plutil", ["-lint", temporaryPath]);
    await rename(temporaryPath, plistPath);
    run(spawn, "launchctl", ["bootout", target], true);
    await waitForUnload(spawn, target, waitDelays);
    await bootstrap(spawn, domain, plistPath);
    run(spawn, "launchctl", ["enable", target]);
    run(spawn, "launchctl", ["kickstart", "-k", target]);
    await waitForRunning(spawn, target);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "start" || action === "restart") {
    if (!await exists(plistPath)) throw new Error("Daemon is not installed. Run: figma-gateway daemon install");
    const current = statusValue(spawn, target);
    if (!current.loaded) await bootstrap(spawn, domain, plistPath);
    run(spawn, "launchctl", ["enable", target]);
    run(spawn, "launchctl", ["kickstart", "-k", target]);
    await waitForRunning(spawn, target);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "stop") {
    run(spawn, "launchctl", ["bootout", target], true);
    await waitForUnload(spawn, target, waitDelays);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  if (action === "uninstall") {
    if (!confirm) throw new Error("daemon uninstall requires --confirm");
    run(spawn, "launchctl", ["bootout", target], true);
    await waitForUnload(spawn, target, waitDelays);
    await rm(plistPath, { force: true });
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown daemon command: ${action}`);
}
