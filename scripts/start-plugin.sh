#!/usr/bin/env bash
# Start the Figma Gateway plugin and wait for its WebSocket connection.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

APP="$FIGMA_APP"
BUNDLE_ID="$FIGMA_APP_BUNDLE_ID"
PORT="${FIGMA_BRIDGE_PORT:-$FIGMA_GATEWAY_PORT}"
SERVER="${FIGMA_BRIDGE_SERVER:-$FIGMA_GATEWAY_SERVER}"
BASE="http://127.0.0.1:$PORT"
MENU_PLUGINS="${FIGMA_MENU_PLUGINS:-Plugins}"
MENU_DEVELOPMENT="${FIGMA_MENU_DEVELOPMENT:-Development}"
MENU_PLUGIN_NAME="$FIGMA_GATEWAY_PLUGIN_NAME"
TARGET_INSTANCE="$FIGMA_GATEWAY_PLUGIN_INSTANCE"
MENU_HOT_RELOAD="${FIGMA_MENU_HOT_RELOAD:-Hot reload plugin}"
RELOAD=0
[[ "${1:-}" == "--reload" ]] && RELOAD=1

health() {
  curl -fsS -m 3 \
    -H "X-Figma-Gateway-Secret: $FIGMA_GATEWAY_SECRET" \
    "$BASE/health" 2>/dev/null
}

plugin_alive() {
health | FIGMA_TARGET_INSTANCE="$TARGET_INSTANCE" FIGMA_TARGET_FILE_NAME="${FIGMA_TARGET_FILE_NAME:-}" FIGMA_TARGET_EDITOR_TYPE="${FIGMA_TARGET_EDITOR_TYPE:-}" python3 -c '
import json, os, sys
target_instance = os.environ["FIGMA_TARGET_INSTANCE"]
target_file_name = os.environ["FIGMA_TARGET_FILE_NAME"]
target_editor_type = os.environ["FIGMA_TARGET_EDITOR_TYPE"]
files = json.load(sys.stdin).get("files") or []
matches = (
    (not target_instance or item.get("instance") == target_instance)
    and (not target_file_name or item.get("fileName") == target_file_name)
    and (not target_editor_type or item.get("editorType") == target_editor_type)
    for item in files
)
sys.exit(0 if any(matches) else 1)
' \
    2>/dev/null
}

plugin_sessions() {
health | FIGMA_TARGET_INSTANCE="$TARGET_INSTANCE" FIGMA_TARGET_FILE_NAME="${FIGMA_TARGET_FILE_NAME:-}" FIGMA_TARGET_EDITOR_TYPE="${FIGMA_TARGET_EDITOR_TYPE:-}" python3 -c '
import json, os, sys
target_instance = os.environ["FIGMA_TARGET_INSTANCE"]
target_file_name = os.environ["FIGMA_TARGET_FILE_NAME"]
target_editor_type = os.environ["FIGMA_TARGET_EDITOR_TYPE"]
for item in json.load(sys.stdin).get("files") or []:
    if (
        (not target_instance or item.get("instance") == target_instance)
        and (not target_file_name or item.get("fileName") == target_file_name)
        and (not target_editor_type or item.get("editorType") == target_editor_type)
        and item.get("fileKey")
    ):
        print(item["fileKey"])
' 2>/dev/null
}

INITIAL_SESSIONS=""
new_plugin_alive() {
  local current key
  current="$(plugin_sessions || true)"
  [[ -n "$current" ]] || return 1
  while IFS= read -r key; do
    [[ -n "$key" ]] || continue
    if ! grep -Fqx -- "$key" <<<"$INITIAL_SESSIONS"; then
      return 0
    fi
  done <<<"$current"
  return 1
}

if [[ "${1:-}" == "--check" ]]; then
  if plugin_alive; then echo "running"; exit 0; else echo "stopped"; exit 1; fi
fi

[[ -f "$SERVER" ]] || { echo "ERROR: the gateway server is missing. Run npm run build:server: $SERVER" >&2; exit 1; }

GATEWAY_STARTED=0
if ! health >/dev/null; then
  FIGMA_GATEWAY_DAEMON=1 FIGMA_GATEWAY_PORT="$PORT" nohup node "$SERVER" \
    >>"${TMPDIR:-/tmp}/figma-gateway-$PORT.log" 2>&1 &
  for _ in $(seq 1 20); do
    health >/dev/null && break
    sleep 0.25
  done
  health >/dev/null || { echo "ERROR: could not start the gateway daemon" >&2; exit 1; }
  GATEWAY_STARTED=1
  echo "==> Started the gateway daemon (127.0.0.1:$PORT)"
fi

# The plugin UI backs off for up to five seconds. After starting a new daemon,
# wait beyond that limit so delayed reconnects are included in the baseline.
if [[ $GATEWAY_STARTED -eq 1 ]]; then
  for _ in $(seq 1 24); do sleep 0.25; done
fi
INITIAL_SESSIONS="$(plugin_sessions || true)"

if [[ $RELOAD -eq 0 ]] && [[ "${FIGMA_REQUIRE_NEW_SESSION:-0}" != "1" ]] && plugin_alive; then
  if [[ -n "${FIGMA_TARGET_FILE_NAME:-}" ]]; then
    echo "==> Plugin is already connected to the target file: $FIGMA_TARGET_FILE_NAME"
  else
    echo "==> Plugin is already connected"
  fi
  exit 0
fi

[[ -d "$APP" ]] || { echo "ERROR: Figma is not installed at $APP" >&2; exit 1; }
if ! pgrep -f "^${APP}/Contents/MacOS/" >/dev/null 2>&1; then
  echo "==> Starting Figma"
  open -a "$APP"
  for _ in $(seq 1 40); do
    pgrep -f "^${APP}/Contents/MacOS/" >/dev/null 2>&1 && break
    sleep 1
  done
  sleep 8
fi

PID="$(pgrep -f "^${APP}/Contents/MacOS/" | head -1)"
[[ -n "$PID" ]] || { echo "ERROR: Figma is not running" >&2; exit 1; }

click_menu_item() {
  osascript -e "tell application id \"$BUNDLE_ID\" to activate" >/dev/null
  osascript - "$PID" "${FIGMA_TARGET_FILE_NAME:-}" "$1" "$MENU_DEVELOPMENT" "$MENU_PLUGINS" \
    > /dev/null 2>"${TMPDIR:-/tmp}/figma-gateway-menu.err" <<'APPLESCRIPT'
on run argv
  set targetPid to item 1 of argv as integer
  set targetName to item 2 of argv
  set pluginName to item 3 of argv
  set developmentMenu to item 4 of argv
  set pluginsMenu to item 5 of argv
  set foundTarget to targetName is ""
  delay 0.6
  tell application "System Events" to tell (first process whose unix id is targetPid)
    if targetName is not "" then
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
    end if
    if foundTarget is false then error "target Figma window not found: " & targetName
    click menu item pluginName of menu 1 of menu item developmentMenu of menu 1 of menu bar item pluginsMenu of menu bar 1
  end tell
end run
APPLESCRIPT
}

if [[ $RELOAD -eq 1 ]]; then
  echo "==> $MENU_HOT_RELOAD"
  click_menu_item "$MENU_HOT_RELOAD" || true
  sleep 2
fi

echo "==> $MENU_PLUGINS > $MENU_DEVELOPMENT > $MENU_PLUGIN_NAME"
for attempt in $(seq 1 12); do
  if click_menu_item "$MENU_PLUGIN_NAME"; then
    for _ in $(seq 1 6); do
      if { [[ "${FIGMA_REQUIRE_NEW_SESSION:-0}" == "1" ]] && new_plugin_alive; } || \
         { [[ "${FIGMA_REQUIRE_NEW_SESSION:-0}" != "1" ]] && plugin_alive; }; then
        echo "==> Plugin connected (attempt $attempt)"
        exit 0
      fi
      sleep 1
    done
  elif grep -q -- "-1743" "${TMPDIR:-/tmp}/figma-gateway-menu.err" 2>/dev/null; then
    echo "ERROR: Accessibility permission is required" >&2
    exit 1
  fi
  echo "    Waiting for the connection ($attempt/12)"
  sleep 4
done

echo "ERROR: could not start the Plugin" >&2
sed 's/^/  /' "${TMPDIR:-/tmp}/figma-gateway-menu.err" >&2 2>/dev/null || true
exit 1
