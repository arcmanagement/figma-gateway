import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type Spawn = typeof spawnSync;

function run(spawn: Spawn, command: string, args: string[], input?: string): SpawnSyncReturns<string> {
  return spawn(command, args, { encoding: "utf8", input });
}

function figmaPid(app: string, spawn: Spawn): string {
  const result = run(spawn, "pgrep", ["-f", `^${app}/Contents/MacOS/`]);
  const pid = result.stdout.split(/\s+/).find(Boolean);
  if (result.status !== 0 || !pid) throw new Error(`Figma app is not running: ${app}`);
  return pid;
}

const LIST_WINDOWS_SCRIPT = `on run argv
  set targetPid to item 1 of argv as integer
  tell application "System Events" to tell (first process whose unix id is targetPid)
    set windowNames to name of every window
  end tell
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set output to windowNames as text
  set AppleScript's text item delimiters to oldDelimiters
  return output
end run`;

const FOCUS_WINDOW_SCRIPT = `on run argv
  set targetPid to item 1 of argv as integer
  set targetName to item 2 of argv
  set foundTarget to false
  tell application "System Events" to tell (first process whose unix id is targetPid)
    repeat with candidate in every window
      if (name of candidate as text) is targetName then
        perform action "AXRaise" of candidate
        set value of attribute "AXMain" of candidate to true
        set value of attribute "AXFocused" of candidate to true
        set frontmost to true
        set foundTarget to true
        exit repeat
      end if
    end repeat
  end tell
  if foundTarget is false then error "target Figma window not found: " & targetName
end run`;

export function listFigmaWindows(app: string, spawn: Spawn = spawnSync): string[] {
  const pid = figmaPid(app, spawn);
  const result = run(spawn, "osascript", ["-", pid], LIST_WINDOWS_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || "Could not list Figma windows").trim());
  return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
}

export function focusFigmaWindow(app: string, fileName: string, spawn: Spawn = spawnSync): void {
  if (!fileName.trim()) throw new Error("Figma window file name is required");
  const pid = figmaPid(app, spawn);
  const result = run(spawn, "osascript", ["-", pid, fileName], FOCUS_WINDOW_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || `Could not focus Figma window: ${fileName}`).trim());
}
