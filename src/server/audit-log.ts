import { mkdir, rename, stat, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_LOG_BYTES = 5 * 1024 * 1024;

export function defaultAuditLogPath(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Logs", "Figma Gateway", "audit.jsonl");
  }
  if (platform === "win32") {
    const root = environment.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
    return path.join(root, "FigmaGateway", "logs", "audit.jsonl");
  }
  const root = environment.XDG_STATE_HOME || path.join(homeDir, ".local", "state");
  return path.join(root, "figma-gateway", "audit.jsonl");
}

export interface AuditEvent {
  event: "rpc_completed";
  tool: string;
  success: boolean;
  durationMs: number;
}

export interface AuditWriter {
  write(event: AuditEvent): Promise<void>;
}

export class AuditLogger implements AuditWriter {
  readonly filePath: string;

  constructor(filePath = defaultAuditLogPath()) {
    this.filePath = filePath;
  }

  async write(event: AuditEvent): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const current = await stat(this.filePath);
      if (current.size >= MAX_LOG_BYTES) {
        await rename(this.filePath, `${this.filePath}.1`).catch(() => undefined);
      }
    } catch {
      await writeFile(this.filePath, "", { mode: 0o600 });
    }
    await appendFile(this.filePath, `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
    })}\n`, { encoding: "utf8", mode: 0o600 });
  }
}
