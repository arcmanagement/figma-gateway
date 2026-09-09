import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function outside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function status(target: string) {
  try {
    return await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function safeOutputPath(cwd: string, requested: string, label: string): Promise<string> {
  const lexicalRoot = path.resolve(cwd);
  const lexicalTarget = path.resolve(lexicalRoot, requested);
  if (!requested || outside(lexicalRoot, lexicalTarget)) {
    throw new Error(`${label} must stay inside the caller working directory: ${requested}`);
  }

  const root = await realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalTarget);
  const parts = relative.split(path.sep).filter(Boolean);
  if (parts.length === 0) throw new Error(`${label} must name a file: ${requested}`);

  let parent = root;
  for (const part of parts.slice(0, -1)) {
    const next = path.join(parent, part);
    let info = await status(next);
    if (!info) {
      try {
        await mkdir(next);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      info = await lstat(next);
    }
    if (info.isSymbolicLink()) throw new Error(`${label} must not traverse a symbolic link: ${requested}`);
    if (!info.isDirectory()) throw new Error(`${label} parent is not a directory: ${requested}`);
    parent = await realpath(next);
    if (outside(root, parent)) throw new Error(`${label} resolves outside the caller working directory: ${requested}`);
  }

  const target = path.join(parent, parts.at(-1)!);
  const targetInfo = await status(target);
  if (targetInfo?.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${requested}`);
  if (targetInfo?.isDirectory()) throw new Error(`${label} must name a file: ${requested}`);
  return target;
}
