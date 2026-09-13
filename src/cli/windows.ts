import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type Spawn = typeof spawnSync;

export interface FigmaWindowSignature {
  name: string;
  position: [number, number];
  size: [number, number];
}

export interface FigmaWindowOperation {
  operationId: string;
  app: string;
  createdAt: string;
  window: FigmaWindowSignature;
  originalWindows: FigmaWindowSignature[];
}

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
  set outputRows to {}
  tell application "System Events" to tell (first process whose unix id is targetPid)
    repeat with candidate in every window
      set {xPosition, yPosition} to position of candidate
      set {windowWidth, windowHeight} to size of candidate
      set end of outputRows to (name of candidate as text) & tab & xPosition & tab & yPosition & tab & windowWidth & tab & windowHeight
    end repeat
  end tell
  set oldDelimiters to AppleScript's text item delimiters
  set AppleScript's text item delimiters to linefeed
  set outputText to outputRows as text
  set AppleScript's text item delimiters to oldDelimiters
  return outputText
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

const OPEN_WINDOW_SCRIPT = `on windowMatches(candidate, targetName, targetX, targetY, targetWidth, targetHeight)
  tell application "System Events"
    set {candidateX, candidateY} to position of candidate
    set {candidateWidth, candidateHeight} to size of candidate
    return (name of candidate as text) is targetName and candidateX is targetX and candidateY is targetY and candidateWidth is targetWidth and candidateHeight is targetHeight
  end tell
end windowMatches

on restoreOriginal(originalPid, figmaPid, originalVisible, originalName, originalX, originalY, originalWidth, originalHeight)
  tell application "System Events"
    if originalPid is figmaPid and originalName is not "" then
      tell (first process whose unix id is figmaPid)
        repeat with candidate in every window
          if my windowMatches(candidate, originalName, originalX, originalY, originalWidth, originalHeight) then
            perform action "AXRaise" of candidate
            set value of attribute "AXMain" of candidate to true
            set value of attribute "AXFocused" of candidate to true
            set frontmost to true
            return
          end if
        end repeat
      end tell
    else
      try
        set frontmost of (first application process whose unix id is originalPid) to true
      end try
    end if
    try
      set visible of (first application process whose unix id is figmaPid) to originalVisible
    end try
  end tell
end restoreOriginal

on run argv
  set targetPid to item 1 of argv as integer
  set appPath to item 2 of argv
  set targetUrl to item 3 of argv
  set targetName to item 4 of argv
  tell application "System Events"
    set originalProcess to first application process whose frontmost is true
    set originalPid to unix id of originalProcess
    set originalVisible to visible of (first process whose unix id is targetPid)
    set originalName to ""
    set originalX to 0
    set originalY to 0
    set originalWidth to 0
    set originalHeight to 0
    tell (first process whose unix id is targetPid)
      set originalWindowCount to count of windows
      try
        set originalWindow to first window whose value of attribute "AXMain" is true
        set originalName to name of originalWindow as text
        set {originalX, originalY} to position of originalWindow
        set {originalWidth, originalHeight} to size of originalWindow
      end try
      set newWindowItem to missing value
      repeat with topItem in menu bar items of menu bar 1
        try
          repeat with candidateItem in menu items of menu 1 of topItem
            if (value of attribute "AXMenuItemCmdChar" of candidateItem as text) is "N" and (value of attribute "AXMenuItemCmdModifiers" of candidateItem as integer) is 1 then
              set newWindowItem to candidateItem
              exit repeat
            end if
          end repeat
        end try
        if newWindowItem is not missing value then exit repeat
      end repeat
      if newWindowItem is missing value then error "Figma New Window command was not found"
      perform action "AXPress" of newWindowItem
      delay 0.2
      set createdWindow to first window
      set {createdX, createdY} to position of createdWindow
      set {createdWidth, createdHeight} to size of createdWindow
      set managedX to createdX + 37
      set managedY to createdY + 37
      set position of createdWindow to {managedX, managedY}
    end tell
  end tell

  do shell script "/usr/bin/open -g -a " & quoted form of appPath & " " & quoted form of targetUrl

  repeat with attempt from 1 to 60
    tell application "System Events" to tell (first process whose unix id is targetPid)
      if (count of windows) is originalWindowCount + 1 then
        repeat with candidate in every window
          set {candidateX, candidateY} to position of candidate
          set {candidateWidth, candidateHeight} to size of candidate
          if candidateX is managedX and candidateY is managedY and candidateWidth is createdWidth and candidateHeight is createdHeight and (name of candidate as text) is targetName then
            my restoreOriginal(originalPid, targetPid, originalVisible, originalName, originalX, originalY, originalWidth, originalHeight)
            return (name of candidate as text) & tab & managedX & tab & managedY & tab & candidateWidth & tab & candidateHeight
          end if
        end repeat
      end if
    end tell
    my restoreOriginal(originalPid, targetPid, originalVisible, originalName, originalX, originalY, originalWidth, originalHeight)
    delay 0.2
  end repeat
  tell application "System Events" to tell (first process whose unix id is targetPid)
    repeat with candidate in every window
      set {candidateX, candidateY} to position of candidate
      set {candidateWidth, candidateHeight} to size of candidate
      if candidateX is managedX and candidateY is managedY and candidateWidth is createdWidth and candidateHeight is createdHeight then
        try
          perform action "AXPress" of button 1 of candidate
        end try
        exit repeat
      end if
    end repeat
  end tell
  my restoreOriginal(originalPid, targetPid, originalVisible, originalName, originalX, originalY, originalWidth, originalHeight)
  error "new Figma window did not load the target file: " & targetName
end run`;

const SET_MODE_SCRIPT = `on windowMatches(candidate, targetName, targetX, targetY, targetWidth, targetHeight)
  tell application "System Events"
    set {candidateX, candidateY} to position of candidate
    set {candidateWidth, candidateHeight} to size of candidate
    return (name of candidate as text) is targetName and candidateX is targetX and candidateY is targetY and candidateWidth is targetWidth and candidateHeight is targetHeight
  end tell
end windowMatches

on run argv
  set targetPid to item 1 of argv as integer
  set targetName to item 2 of argv
  set requestedMode to item 3 of argv
  set targetX to item 4 of argv as integer
  set targetY to item 5 of argv as integer
  set targetWidth to item 6 of argv as integer
  set targetHeight to item 7 of argv as integer
  tell application "System Events"
    set originalProcess to first application process whose frontmost is true
    set originalPid to unix id of originalProcess
    set originalVisible to visible of (first process whose unix id is targetPid)
    tell (first process whose unix id is targetPid)
      set originalWindow to missing value
      try
        set originalWindow to first window whose value of attribute "AXMain" is true
      end try
      set targetWindow to missing value
      repeat with candidate in every window
        if my windowMatches(candidate, targetName, targetX, targetY, targetWidth, targetHeight) then
          set targetWindow to candidate
          exit repeat
        end if
      end repeat
      if targetWindow is missing value then error "managed Figma window no longer matches its recorded state"
      perform action "AXRaise" of targetWindow
      set value of attribute "AXMain" of targetWindow to true
      set value of attribute "AXFocused" of targetWindow to true
      set frontmost to true
      delay 0.6

      set modeItem to missing value
      repeat with menuAttempt from 1 to 20
        repeat with topItem in menu bar items of menu bar 1
          try
            repeat with candidateItem in menu items of menu 1 of topItem
              if (value of attribute "AXMenuItemCmdChar" of candidateItem as text) is "D" and (value of attribute "AXMenuItemCmdModifiers" of candidateItem as text) is "9" then
                set modeItem to candidateItem
                exit repeat
              end if
            end repeat
          end try
          if modeItem is not missing value then exit repeat
        end repeat
        if modeItem is not missing value then exit repeat
        delay 0.25
      end repeat
      if modeItem is missing value then error "Figma Design/Dev Mode command was not found"
      set modeActionName to name of modeItem as text
      set actionSwitchesToDev to modeActionName contains "Dev Mode"
      if (requestedMode is "dev" and actionSwitchesToDev) or (requestedMode is "design" and not actionSwitchesToDev) then
        perform action "AXPress" of modeItem
        delay 0.5
      end if

      if originalPid is targetPid and originalWindow is not missing value then
        perform action "AXRaise" of originalWindow
        set value of attribute "AXMain" of originalWindow to true
        set value of attribute "AXFocused" of originalWindow to true
        set frontmost to true
      else
        try
          set frontmost of originalProcess to true
        end try
      end if
      try
        set visible to originalVisible
      end try
    end tell
  end tell
  return requestedMode
end run`;

const CLOSE_WINDOW_SCRIPT = `on run argv
  set targetPid to item 1 of argv as integer
  set targetName to item 2 of argv
  set targetX to item 3 of argv as integer
  set targetY to item 4 of argv as integer
  set targetWidth to item 5 of argv as integer
  set targetHeight to item 6 of argv as integer
  set matches to {}
  tell application "System Events" to tell (first process whose unix id is targetPid)
    repeat with candidate in every window
      set {candidateX, candidateY} to position of candidate
      set {candidateWidth, candidateHeight} to size of candidate
      if (name of candidate as text) is targetName and candidateX is targetX and candidateY is targetY and candidateWidth is targetWidth and candidateHeight is targetHeight then
        set end of matches to candidate
      end if
    end repeat
    if (count of matches) is not 1 then error "managed Figma window cannot be identified safely"
    perform action "AXPress" of button 1 of item 1 of matches
  end tell
end run`;

function parseWindowLine(line: string): FigmaWindowSignature {
  const [name = "", x = "", y = "", width = "", height = ""] = line.split("\t");
  if (![x, y, width, height].every((value) => /^-?\d+$/.test(value))) {
    throw new Error(`Could not parse Figma window state: ${line}`);
  }
  const numbers = [x, y, width, height].map(Number);
  if (!name || numbers.some((value) => !Number.isInteger(value))) {
    throw new Error(`Could not parse Figma window state: ${line}`);
  }
  return { name, position: [numbers[0]!, numbers[1]!], size: [numbers[2]!, numbers[3]!] };
}

function operationDirectory(): string {
  return process.env.FIGMA_GATEWAY_WINDOW_STATE_DIR || path.join(
    os.homedir(), "Library", "Application Support", "Figma Gateway", "window-operations",
  );
}

function operationPath(operationId: string): string {
  if (!/^op_[0-9a-f-]{36}$/.test(operationId)) throw new Error(`Invalid window operation ID: ${operationId}`);
  return path.join(operationDirectory(), `${operationId}.json`);
}

export function listFigmaWindowDetails(app: string, spawn: Spawn = spawnSync): FigmaWindowSignature[] {
  const pid = figmaPid(app, spawn);
  const result = run(spawn, "osascript", ["-", pid], LIST_WINDOWS_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || "Could not list Figma windows").trim());
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean).map(parseWindowLine);
}

export function listFigmaWindows(app: string, spawn: Spawn = spawnSync): string[] {
  return listFigmaWindowDetails(app, spawn).map((window) => window.name);
}

export function focusFigmaWindow(app: string, fileName: string, spawn: Spawn = spawnSync): void {
  if (!fileName.trim()) throw new Error("Figma window file name is required");
  const pid = figmaPid(app, spawn);
  const result = run(spawn, "osascript", ["-", pid, fileName], FOCUS_WINDOW_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || `Could not focus Figma window: ${fileName}`).trim());
}

export function openManagedFigmaWindow(
  app: string,
  url: string,
  fileName: string,
  spawn: Spawn = spawnSync,
): FigmaWindowOperation {
  const originalWindows = listFigmaWindowDetails(app, spawn);
  const pid = figmaPid(app, spawn);
  const result = run(spawn, "osascript", ["-", pid, app, url, fileName], OPEN_WINDOW_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || `Could not open Figma window: ${fileName}`).trim());
  const window = parseWindowLine(result.stdout.trim());
  if (originalWindows.some((candidate) => JSON.stringify(candidate) === JSON.stringify(window))) {
    throw new Error("Figma reported a pre-existing window as newly created");
  }
  const operation: FigmaWindowOperation = {
    operationId: `op_${randomUUID()}`,
    app,
    createdAt: new Date().toISOString(),
    window,
    originalWindows,
  };
  mkdirSync(operationDirectory(), { recursive: true, mode: 0o700 });
  writeFileSync(operationPath(operation.operationId), `${JSON.stringify(operation, null, 2)}\n`, { mode: 0o600 });
  return operation;
}

export function setManagedFigmaWindowMode(
  operation: FigmaWindowOperation,
  mode: "design" | "dev",
  spawn: Spawn = spawnSync,
): void {
  const pid = figmaPid(operation.app, spawn);
  const { name, position: [x, y], size: [width, height] } = operation.window;
  const result = run(spawn, "osascript", [
    "-", pid, name, mode, String(x), String(y), String(width), String(height),
  ], SET_MODE_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || `Could not switch Figma to ${mode} mode`).trim());
}

export function readFigmaWindowOperation(operationId: string): FigmaWindowOperation {
  const value = JSON.parse(readFileSync(operationPath(operationId), "utf8")) as FigmaWindowOperation;
  if (value.operationId !== operationId || !value.window || !Array.isArray(value.originalWindows)) {
    throw new Error(`Invalid Figma window operation receipt: ${operationId}`);
  }
  return value;
}

export function cleanupManagedFigmaWindow(
  operationId: string,
  spawn: Spawn = spawnSync,
): FigmaWindowOperation {
  const operation = readFigmaWindowOperation(operationId);
  const pid = figmaPid(operation.app, spawn);
  const { name, position: [x, y], size: [width, height] } = operation.window;
  const result = run(spawn, "osascript", [
    "-", pid, name, String(x), String(y), String(width), String(height),
  ], CLOSE_WINDOW_SCRIPT);
  if (result.status !== 0) throw new Error((result.stderr || "Could not safely close the managed Figma window").trim());
  rmSync(operationPath(operationId));
  return operation;
}
