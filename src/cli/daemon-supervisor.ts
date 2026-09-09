import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import type { CliProfile } from "./config.js";

type Spawn = typeof spawn;

export interface SupervisorDependencies {
  spawn?: Spawn;
  fetch?: typeof fetch;
  nodePath?: string;
  entrypoint?: string;
  healthIntervalMs?: number;
  startupGraceMs?: number;
  restartDelayMs?: number;
  unhealthyLimit?: number;
  maxCycles?: number;
}

function childExited(child: ChildProcess): Promise<"exit"> {
  return new Promise((resolve) => child.once("exit", () => resolve("exit")));
}

async function waitForUnhealthy(
  child: ChildProcess,
  profile: CliProfile,
  dependencies: SupervisorDependencies,
): Promise<"unhealthy"> {
  const request = dependencies.fetch || fetch;
  const interval = dependencies.healthIntervalMs ?? 5_000;
  const grace = dependencies.startupGraceMs ?? 10_000;
  const limit = dependencies.unhealthyLimit ?? 3;
  const startedAt = Date.now();
  let failures = 0;
  while (child.exitCode === null && !child.killed) {
    await delay(interval);
    try {
      const response = await request(`http://127.0.0.1:${profile.port}/health`, {
        headers: { "x-figma-gateway-secret": profile.secret },
        signal: AbortSignal.timeout(Math.min(interval, 3_000)),
      });
      if (!response.ok) throw new Error(`health returned ${response.status}`);
      failures = 0;
    } catch {
      if (Date.now() - startedAt < grace) continue;
      failures += 1;
      if (failures >= limit) return "unhealthy";
    }
  }
  return new Promise(() => undefined);
}

export async function superviseDaemon(
  profile: CliProfile,
  writer: (value: string) => void = (value) => process.stderr.write(value),
  dependencies: SupervisorDependencies = {},
): Promise<void> {
  const spawnProcess = dependencies.spawn || spawn;
  const nodePath = dependencies.nodePath || process.execPath;
  const entrypoint = dependencies.entrypoint || process.argv[1];
  if (!entrypoint) throw new Error("Could not determine the figma-gateway entrypoint");

  let stopping = false;
  let child: ChildProcess | null = null;
  const stop = () => {
    stopping = true;
    child?.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let cycle = 0;
  try {
    while (!stopping && (dependencies.maxCycles === undefined || cycle < dependencies.maxCycles)) {
      cycle += 1;
      child = spawnProcess(nodePath, [
        entrypoint,
        "--profile", profile.name,
        "--port", String(profile.port),
        "--secret-service", profile.secretService,
        "daemon",
      ], { stdio: ["ignore", "ignore", "inherit"] });
      writer(`${JSON.stringify({ event: "worker_started", cycle, pid: child.pid || null })}\n`);
      const outcome = await Promise.race([
        childExited(child),
        waitForUnhealthy(child, profile, dependencies),
      ]);
      if (outcome === "unhealthy" && child.exitCode === null) {
        writer(`${JSON.stringify({ event: "worker_unhealthy", cycle })}\n`);
        child.kill("SIGTERM");
        await Promise.race([childExited(child), delay(5_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      } else if (!stopping) {
        writer(`${JSON.stringify({ event: "worker_exited", cycle, code: child.exitCode })}\n`);
      }
      child = null;
      if (!stopping) await delay(dependencies.restartDelayMs ?? 1_000);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    child?.kill("SIGTERM");
  }
}
