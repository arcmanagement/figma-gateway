import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CliProfile } from "./config.js";

export function localPluginDirectory(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.userInfo().homedir,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Application Support", "Figma Gateway", "plugin");
  }
  if (platform === "win32") {
    return path.join(environment.LOCALAPPDATA || path.join(homeDir, "AppData", "Local"), "FigmaGateway", "plugin");
  }
  return path.join(environment.XDG_DATA_HOME || path.join(homeDir, ".local", "share"), "figma-gateway", "plugin");
}

export type LocalPluginBuild = {
  manifest: string;
  devManifest: string;
};

export function buildLocalPlugin(profile: CliProfile): LocalPluginBuild {
  if (!profile.secret) throw new Error("A local gateway secret is required before building the Plugin");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const outputDirectory = localPluginDirectory();
  const result = spawnSync(process.execPath, [
    path.join(root, "scripts", "build-plugin.mjs"),
    "--port", String(profile.port),
    "--out-dir", outputDirectory,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, FIGMA_GATEWAY_SECRET: profile.secret },
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Local Plugin build failed").trim());
  }
  return {
    manifest: path.join(outputDirectory, "manifest.json"),
    devManifest: path.join(outputDirectory, "dev", "manifest.json"),
  };
}
