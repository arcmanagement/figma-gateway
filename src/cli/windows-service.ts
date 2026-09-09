import { spawnSync } from "node:child_process";
import { access, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CliProfile } from "./config.js";

type Writer = (value: string) => void;
type Spawn = typeof spawnSync;

export const WINDOWS_TASK_NAME = "Figma Gateway";

export interface WindowsServiceDependencies {
  spawn?: Spawn;
  homeDir?: string;
  localAppData?: string;
  nodePath?: string;
  entrypoint?: string;
  username?: string;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteArgument(value: string): string {
  return `&quot;${xml(value)}&quot;`;
}

export function buildScheduledTaskXml(config: {
  profile: CliProfile;
  nodePath: string;
  entrypoint: string;
  username: string;
}): string {
  const argumentsValue = [
    config.entrypoint,
    "--profile", config.profile.name,
    "--port", String(config.profile.port),
    "--secret-service", config.profile.secretService,
    "daemon", "supervise",
  ].map(quoteArgument).join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger><Enabled>true</Enabled><UserId>${xml(config.username)}</UserId></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(config.username)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>${xml(config.nodePath)}</Command><Arguments>${argumentsValue}</Arguments></Exec>
  </Actions>
</Task>
`;
}

function run(spawn: Spawn, command: string, args: string[], allowFailure = false): ReturnType<Spawn> {
  const result = spawn(command, args, { encoding: "utf8" });
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = String(result.stderr || result.stdout || result.error?.message || "unknown error").trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
  return result;
}

async function exists(filePath: string): Promise<boolean> {
  try { await access(filePath); return true; } catch { return false; }
}

export async function runWindowsDaemonService(
  profile: CliProfile,
  argv: string[],
  writer: Writer,
  dependencies: WindowsServiceDependencies = {},
): Promise<void> {
  const action = argv[0] || "status";
  const confirm = argv.slice(1).includes("--confirm");
  const spawn = dependencies.spawn || spawnSync;
  const homeDir = dependencies.homeDir || os.homedir();
  const localAppData = dependencies.localAppData || process.env.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const serviceDirectory = path.join(localAppData, "FigmaGateway", "service");
  const taskXmlPath = path.join(serviceDirectory, "task.xml");
  const query = () => run(spawn, "schtasks.exe", ["/Query", "/TN", WINDOWS_TASK_NAME], true);
  const serviceStatus = async () => {
    const result = query();
    return {
      ok: true,
      service: WINDOWS_TASK_NAME,
      task: taskXmlPath,
      installed: result.status === 0,
      configured: await exists(taskXmlPath),
      state: result.status === 0 ? "registered" : "not_registered",
    };
  };

  if (action === "status") {
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  if (action === "install") {
    if (!profile.secret) throw new Error("The shared gateway secret is not available in Windows Credential Protection");
    const nodePath = dependencies.nodePath || process.execPath;
    const entrypoint = dependencies.entrypoint || process.argv[1];
    if (!entrypoint) throw new Error("Could not determine the figma-gateway entrypoint");
    const username = dependencies.username || process.env.USERNAME;
    if (!username) throw new Error("Could not determine the current Windows user");
    await mkdir(serviceDirectory, { recursive: true });
    const temporaryPath = `${taskXmlPath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, buildScheduledTaskXml({ profile, nodePath, entrypoint, username }), "utf16le");
    await rename(temporaryPath, taskXmlPath);
    if (query().status === 0) {
      run(spawn, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], true);
    }
    run(spawn, "schtasks.exe", ["/Create", "/TN", WINDOWS_TASK_NAME, "/XML", taskXmlPath, "/F"]);
    run(spawn, "schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME]);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  if (action === "start" || action === "restart") {
    if (query().status !== 0) throw new Error("Daemon is not installed. Run: figma-gateway daemon install");
    if (action === "restart") run(spawn, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], true);
    run(spawn, "schtasks.exe", ["/Run", "/TN", WINDOWS_TASK_NAME]);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  if (action === "stop") {
    run(spawn, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], true);
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  if (action === "uninstall") {
    if (!confirm) throw new Error("daemon uninstall requires --confirm");
    run(spawn, "schtasks.exe", ["/End", "/TN", WINDOWS_TASK_NAME], true);
    run(spawn, "schtasks.exe", ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"], true);
    await rm(taskXmlPath, { force: true });
    writer(`${JSON.stringify(await serviceStatus(), null, 2)}\n`);
    return;
  }
  throw new Error(`Unknown daemon command: ${action}`);
}
