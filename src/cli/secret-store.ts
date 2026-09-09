import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type ExecFile = typeof execFileSync;

export interface SecretStoreDependencies {
  platform?: NodeJS.Platform;
  homeDir?: string;
  environment?: NodeJS.ProcessEnv;
  execFile?: ExecFile;
  username?: string;
}

function powershell(): string {
  return process.env.ComSpec ? "powershell.exe" : "powershell";
}

export function windowsSecretPath(
  service: string,
  dependencies: Pick<SecretStoreDependencies, "homeDir" | "environment"> = {},
): string {
  const environment = dependencies.environment || process.env;
  const homeDir = dependencies.homeDir || os.homedir();
  const localAppData = environment.LOCALAPPDATA || path.join(homeDir, "AppData", "Local");
  const id = createHash("sha256").update(service).digest("hex").slice(0, 16);
  return path.join(localAppData, "FigmaGateway", `secret-${id}.dpapi`);
}

export function readGatewaySecret(
  service: string,
  dependencies: SecretStoreDependencies = {},
): string {
  const platform = dependencies.platform || process.platform;
  const exec = dependencies.execFile || execFileSync;
  try {
    if (platform === "darwin") {
      return String(exec("security", ["find-generic-password", "-w", "-s", service], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })).trim();
    }
    if (platform === "win32") {
      const secretPath = windowsSecretPath(service, dependencies);
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$secure = Get-Content -Raw -LiteralPath $env:FIGMA_GATEWAY_SECRET_FILE | ConvertTo-SecureString",
        "$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)",
        "try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }",
      ].join("; ");
      return String(exec(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...(dependencies.environment || process.env), FIGMA_GATEWAY_SECRET_FILE: secretPath },
      })).trim();
    }
  } catch {
    return "";
  }
  return "";
}

export function ensureGatewaySecret(
  service: string,
  dependencies: SecretStoreDependencies = {},
): string {
  const existing = readGatewaySecret(service, dependencies);
  if (existing) return existing;

  const platform = dependencies.platform || process.platform;
  const exec = dependencies.execFile || execFileSync;
  const secret = randomBytes(32).toString("hex");
  if (platform === "darwin") {
    const username = dependencies.username || os.userInfo().username;
    exec("security", ["add-generic-password", "-U", "-a", username, "-s", service, "-w", secret], {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
    });
    return secret;
  }
  if (platform === "win32") {
    const secretPath = windowsSecretPath(service, dependencies);
    mkdirSync(path.dirname(secretPath), { recursive: true });
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "$secret = [Console]::In.ReadToEnd()",
      "$secure = ConvertTo-SecureString $secret -AsPlainText -Force",
      "$secure | ConvertFrom-SecureString | Set-Content -NoNewline -LiteralPath $env:FIGMA_GATEWAY_SECRET_FILE",
    ].join("; ");
    exec(powershell(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      input: secret,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...(dependencies.environment || process.env), FIGMA_GATEWAY_SECRET_FILE: secretPath },
    });
    return secret;
  }
  throw new Error("Persistent gateway secrets are supported on macOS and Windows only");
}
