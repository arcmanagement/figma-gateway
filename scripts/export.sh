#!/usr/bin/env bash
# Export a node from a Figma URL and restore the previous app state.
#
# The file opens in the background. The target window is focused only while
# starting the Plugin, then the previous application and visibility are restored.
#
# The TypeScript gateway handles requests. This script coordinates opening,
# starting, selecting, exporting, and restoring the application.
#
# Import the generated Plugin manifest into Figma before using this command.
# The script starts Figma and the gateway server when necessary.
#
# Usage
#   ./export.sh '<Figma URL>' --out ~/Desktop
#   ./export.sh '<URL>' --scale 4 --format PNG --out ./out
#   ./export.sh '<URL>' --tree --out ~/Desktop
#   ./export.sh '<SECTION or FRAME URL>' --structure --out ./out
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

BRIDGE_SERVER="${FIGMA_BRIDGE_SERVER:-$FIGMA_GATEWAY_SERVER}"
BRIDGE_PORT="${FIGMA_BRIDGE_PORT:-$FIGMA_GATEWAY_PORT}"
MENU_PLUGINS="${FIGMA_MENU_PLUGINS:-Plugins}"
MENU_DEVELOPMENT="${FIGMA_MENU_DEVELOPMENT:-Development}"

URL=""
SCALE=2
FORMAT=PNG
OUT_DIR="$PWD"
TREE=0
STRUCTURE=0
FILE_NAME=""
OVERVIEW_SCALE=1
DETAIL_SCALE=2
# Child node types treated as implementation-level details.
CHILD_TYPES="SECTION,FRAME"

usage() { sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    http*)     URL="$1"; shift ;;
    --scale)   SCALE="$2"; shift 2 ;;
    --format)  FORMAT="$(tr '[:lower:]' '[:upper:]' <<<"$2")"; shift 2 ;;
    --out)     OUT_DIR="$2"; shift 2 ;;
    --tree)            TREE=1; shift ;;
    --structure)       STRUCTURE=1; shift ;;
    --section-tree)    STRUCTURE=1; shift ;;
    --file-name)       FILE_NAME="$2"; shift 2 ;;
    --overview-scale)  OVERVIEW_SCALE="$2"; shift 2 ;;
    --detail-scale)    DETAIL_SCALE="$2"; shift 2 ;;
    --child-types)     CHILD_TYPES="$2"; shift 2 ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -n "$URL" ]] || { echo "ERROR: provide a Figma URL" >&2; usage 1; }
[[ -n "$BRIDGE_SERVER" ]] || { echo "ERROR: FIGMA_BRIDGE_SERVER must point to the gateway server index.js" >&2; exit 1; }
(( TREE + STRUCTURE <= 1 )) || { echo "ERROR: --tree and --structure cannot be used together" >&2; exit 1; }

FILE_KIND="design"
if [[ "$URL" =~ /(design|file)/([0-9a-zA-Z]{22,128})/branch/([0-9a-zA-Z]{22,128}) ]]; then
  URL_KEY="${BASH_REMATCH[3]}"
elif [[ "$URL" =~ /(design|file)/([0-9a-zA-Z]{22,128}) ]]; then
  URL_KEY="${BASH_REMATCH[2]}"
elif [[ "$URL" =~ /board/([0-9a-zA-Z]{22,128}) ]]; then
  URL_KEY="${BASH_REMATCH[1]}"
  FILE_KIND="board"
elif [[ "$URL" =~ /slides/([0-9a-zA-Z]{22,128}) ]]; then
  URL_KEY="${BASH_REMATCH[1]}"
  FILE_KIND="slides"
elif [[ "$URL" =~ /buzz/([0-9a-zA-Z]{22,128}) ]]; then
  URL_KEY="${BASH_REMATCH[1]}"
  FILE_KIND="buzz"
else
  echo "ERROR: could not extract a file key from the URL" >&2; exit 1
fi
if [[ "$URL" =~ node-id=([0-9]+)[:-]([0-9]+) ]]; then
  NODE_ID="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
elif [[ "$FILE_KIND" == "board" || "$FILE_KIND" == "slides" || "$FILE_KIND" == "buzz" ]]; then
  # Shared FigJam, Slides, and Buzz links often omit node-id. Use the page root.
  NODE_ID="0:1"
else
  echo "ERROR: the URL does not contain node-id" >&2; exit 1
fi
EXPECTED_FILE_NAME="${FILE_NAME:-$(FIGMA_URL="$URL" python3 - <<'PY'
import os
from urllib.parse import unquote, urlparse

path = urlparse(os.environ["FIGMA_URL"]).path.rstrip("/")
print(unquote(path.rsplit("/", 1)[-1]) if path else "")
PY
)}"
[[ -n "$EXPECTED_FILE_NAME" ]] || { echo "ERROR: could not extract the Figma file name; provide --file-name" >&2; exit 1; }

PLUGIN_MENU="$FIGMA_GATEWAY_PLUGIN_NAME"
EXPECTED_INSTANCE="$FIGMA_GATEWAY_PLUGIN_INSTANCE"

APP="$FIGMA_APP"
BUNDLE="$FIGMA_APP_BUNDLE_ID"
[[ -d "$APP" ]] || { echo "ERROR: $APP does not exist" >&2; exit 1; }
[[ "$BRIDGE_PORT" =~ ^[0-9]+$ ]] && (( BRIDGE_PORT >= 1 && BRIDGE_PORT <= 65535 )) || {
  echo "ERROR: gateway port must be from 1 to 65535: $BRIDGE_PORT" >&2
  exit 1
}

mkdir -p "$OUT_DIR"

echo "==> App   : $APP"
echo "==> File  : $EXPECTED_FILE_NAME"
echo "==> Node  : $NODE_ID"
echo "==> Output: $OUT_DIR"
[[ $TREE -eq 1 ]] && echo "==> Mode  : overview ${OVERVIEW_SCALE}x + details ${DETAIL_SCALE}x"
[[ $STRUCTURE -eq 1 ]] && echo "==> Mode  : root ${OVERVIEW_SCALE}x + all sections and outermost frames ${DETAIL_SCALE}x"

# Start the gateway before the Plugin. Avoid an extra follower when the port is active.
BRIDGE_STARTED=0
BRIDGE_SERVER_PID=""
if ! lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "==> Starting gateway server (port $BRIDGE_PORT)"
  FIGMA_BRIDGE_PORT="$BRIDGE_PORT" nohup node "$BRIDGE_SERVER" \
    >>"${TMPDIR:-/tmp}/figma-bridge-$BRIDGE_PORT.log" 2>&1 &
  BRIDGE_SERVER_PID="$!"
  BRIDGE_STARTED=1
  for _ in $(seq 1 20); do
    lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.5
  done
  lsof -nP -iTCP:"$BRIDGE_PORT" -sTCP:LISTEN >/dev/null 2>&1 || {
    echo "ERROR: could not start the gateway server; see ${TMPDIR:-/tmp}/figma-bridge-$BRIDGE_PORT.log" >&2
    exit 1
  }
fi

# Record the current app state and restore it at exit.
was_visible() {
  local pid
  pid="$(pgrep -f "^${APP}/Contents/MacOS/" | head -1 || true)"
  [[ -z "$pid" ]] && { echo "absent"; return; }
  osascript -e "tell application \"System Events\" to get visible of (first process whose unix id is $pid)" 2>/dev/null
}
ORIGINAL_STATE="$(was_visible)"
ORIGINAL_FRONTMOST_PID="$(osascript -e 'tell application "System Events" to get unix id of first application process whose frontmost is true' 2>/dev/null || true)"
PLAN_FILE=""
RESULT_FILE=""

# Remove temporary files and restore app state for every exit path.
restore() {
  local pid
  pid="$(pgrep -f "^${APP}/Contents/MacOS/" | head -1 || true)"
  [[ -z "$pid" ]] && return
  case "$ORIGINAL_STATE" in
    true)
      osascript -e "tell application \"System Events\" to set visible of (first process whose unix id is $pid) to true" >/dev/null 2>&1 || true
      ;;
    false)
      osascript -e "tell application \"System Events\" to set visible of (first process whose unix id is $pid) to false" >/dev/null 2>&1 || true
      ;;
    absent)
      osascript -e "tell application id \"$BUNDLE\" to quit" >/dev/null 2>&1 || true
      ;;
  esac
  echo "==> Restored Figma visibility to $ORIGINAL_STATE"
}
cleanup() {
  [[ -z "$PLAN_FILE" ]] || rm -f "$PLAN_FILE"
  [[ -z "$RESULT_FILE" ]] || rm -f "$RESULT_FILE"
  restore
  if [[ $BRIDGE_STARTED -eq 1 && -n "$BRIDGE_SERVER_PID" ]]; then
    kill "$BRIDGE_SERVER_PID" >/dev/null 2>&1 || true
    wait "$BRIDGE_SERVER_PID" 2>/dev/null || true
    echo "==> Stopped the gateway server started by this run"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Open without taking focus.
echo "==> Opening file"
open -g -a "$APP" "$URL"
for _ in $(seq 1 40); do
  pgrep -f "^${APP}/Contents/MacOS/" >/dev/null 2>&1 && break
  sleep 1
done
sleep 10

PID="$(pgrep -f "^${APP}/Contents/MacOS/" | head -1)"
[[ -n "$PID" ]] || { echo "ERROR: Figma is not running" >&2; exit 1; }

# Query connection state through list_files.
bridge_call() {
  FIGMA_BRIDGE_PORT="$BRIDGE_PORT" BRIDGE_SERVER="$BRIDGE_SERVER" BRIDGE_TOOL="$1" BRIDGE_ARGS="$2" BRIDGE_CWD="$OUT_DIR" python3 - <<'PY'
import json, os, queue, subprocess, threading, sys

proc = subprocess.Popen(["node", os.environ["BRIDGE_SERVER"]], stdin=subprocess.PIPE,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                        bufsize=1, cwd=os.environ["BRIDGE_CWD"])
lines = queue.Queue()
threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()

def send(method, params=None, rid=None):
    msg = {"jsonrpc": "2.0", "method": method}
    if rid is not None: msg["id"] = rid
    if params is not None: msg["params"] = params
    proc.stdin.write(json.dumps(msg) + "\n"); proc.stdin.flush()

def recv(rid, timeout=180):
    while True:
        try: msg = json.loads(lines.get(timeout=timeout))
        except json.JSONDecodeError: continue
        if msg.get("id") == rid: return msg

send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                    "clientInfo": {"name": "figma-gateway", "version": "0"}}, 1)
recv(1)
send("notifications/initialized")
send("tools/call", {"name": os.environ["BRIDGE_TOOL"],
                    "arguments": json.loads(os.environ["BRIDGE_ARGS"])}, 2)
result = recv(2)
proc.terminate()
content = (result.get("result") or {}).get("content") or [{}]
print(content[0].get("text", json.dumps(result, ensure_ascii=False)))
PY
}

# Exclude sessions that existed before starting the Plugin in the target window.
INITIAL_SESSION_KEYS="$(bridge_call list_files '{}' 2>/dev/null | FIGMA_TARGET_INSTANCE="$EXPECTED_INSTANCE" python3 -c '
import json, os, sys
data = json.load(sys.stdin)
files = data.get("files", []) if isinstance(data, dict) else data
print(json.dumps([
    str(item.get("fileKey")) for item in files
    if isinstance(item, dict)
    and item.get("instance") == os.environ["FIGMA_TARGET_INSTANCE"]
    and item.get("fileKey")
]))
' 2>/dev/null || printf '[]')"

# Retry until the Plugin appears in the gateway after the file has loaded.
echo "==> Starting Plugin"
FILE_KEY=""
LIST_FILES=""
click_plugin_menu() {
  local status=0
  osascript \
    - "$PID" "$EXPECTED_FILE_NAME" "$PLUGIN_MENU" "$MENU_PLUGINS" "$MENU_DEVELOPMENT" <<'APPLESCRIPT' || status=$?
on run argv
  set targetPid to item 1 of argv as integer
  set targetName to item 2 of argv
  set pluginName to item 3 of argv
  set pluginsMenu to item 4 of argv
  set developmentMenu to item 5 of argv
  set foundTarget to false
  tell application "System Events" to tell (first process whose unix id is targetPid)
    set frontmost to true
    repeat with candidate in every window
      if (name of candidate as text) is targetName then
        perform action "AXRaise" of candidate
        set value of attribute "AXMain" of candidate to true
        set value of attribute "AXFocused" of candidate to true
        set foundTarget to true
        exit repeat
      end if
    end repeat
    if foundTarget is false then error "target Figma window not found: " & targetName
    click menu item pluginName of menu 1 of menu item developmentMenu of menu 1 of menu bar item pluginsMenu of menu bar 1
  end tell
end run
APPLESCRIPT
  if [[ -n "$ORIGINAL_FRONTMOST_PID" ]]; then
    osascript - "$ORIGINAL_FRONTMOST_PID" <<'APPLESCRIPT' >/dev/null 2>&1 || true
on run argv
  set targetPid to item 1 of argv as integer
  tell application "System Events" to tell (first application process whose unix id is targetPid)
    set frontmost to true
  end tell
end run
APPLESCRIPT
  fi
  return "$status"
}

for attempt in $(seq 1 8); do
  # Start the Plugin in the selected Figma window, then restore focus.
  if ! PLUGIN_ERROR="$(click_plugin_menu 2>&1)"; then
    echo "  Retrying Plugin start: ${PLUGIN_ERROR%%$'\n'*}"
  fi
  sleep 5
  # fileKey changes when a file is reopened, so select the exact file name each time.
  LIST_FILES="$(bridge_call list_files '{}' 2>/dev/null || true)"
  SELECTED_FILE="$(printf '%s' "$LIST_FILES" \
    | python3 "$SCRIPT_DIR/structure-export.py" select-file \
        --file-name "$EXPECTED_FILE_NAME" \
        --instance "$EXPECTED_INSTANCE" \
        --exclude-file-keys-json "$INITIAL_SESSION_KEYS" 2>/dev/null || true)"
  FILE_KEY="$(printf '%s' "$SELECTED_FILE" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("fileKey", ""))
except Exception: pass
')"
  [[ -n "$FILE_KEY" ]] && { echo "  Connected on attempt $attempt: fileKey=$FILE_KEY"; break; }
  echo "  Waiting ($attempt/8)"
done
if [[ -z "$FILE_KEY" ]]; then
  printf '%s' "$LIST_FILES" | python3 "$SCRIPT_DIR/structure-export.py" select-file \
    --file-name "$EXPECTED_FILE_NAME" \
    --instance "$EXPECTED_INSTANCE" \
    --exclude-file-keys-json "$INITIAL_SESSION_KEYS" >/dev/null
  echo "ERROR: the Plugin in the target file did not connect to the gateway" >&2
  exit 1
fi

EXT="$(tr '[:upper:]' '[:lower:]' <<<"$FORMAT")"

if [[ $STRUCTURE -eq 1 ]]; then
  mkdir -p "$OUT_DIR/sections" "$OUT_DIR/frames"
  [[ "$FILE_KIND" == "slides" ]] && mkdir -p "$OUT_DIR/slides"
  echo "==> Discovering sections and outermost frames recursively"
  NODE_JSON="$(bridge_call get_node "$(FK="$FILE_KEY" NI="$NODE_ID" python3 -c '
import json, os
print(json.dumps({"fileKey": os.environ["FK"], "nodeId": os.environ["NI"]}))
')" 2>/dev/null)"
  # Preserve raw structure data for Markdown generation and later analysis.
  printf '%s' "$NODE_JSON" > "$OUT_DIR/structure.json"
  PLAN_FILE="$(mktemp "$OUT_DIR/.figma-structure-plan.XXXXXX")"
  printf '%s' "$NODE_JSON" | python3 "$SCRIPT_DIR/structure-export.py" plan \
    --file-key "$FILE_KEY" \
    --kind "$FILE_KIND" \
    --source-url "$URL" \
    --format "$FORMAT" \
    --overview-scale "$OVERVIEW_SCALE" \
    --detail-scale "$DETAIL_SCALE" >"$PLAN_FILE"
  ARGS="$(python3 -c '
import json, sys
print(json.dumps(json.load(open(sys.argv[1], encoding="utf-8"))["request"]))
' "$PLAN_FILE")"
elif [[ $TREE -eq 1 ]]; then
  # Export the parent overview and child details through get_node without REST.
  mkdir -p "$OUT_DIR/detail"
  echo "==> Discovering child nodes"
  CHILDREN="$(bridge_call get_node "$(FK="$FILE_KEY" NI="$NODE_ID" python3 -c '
import json, os
print(json.dumps({"fileKey": os.environ["FK"], "nodeId": os.environ["NI"]}))')" 2>/dev/null)"
  ARGS="$(CH="$CHILDREN" FK="$FILE_KEY" NI="$NODE_ID" FT="$FORMAT" EX="$EXT" \
          OS="$OVERVIEW_SCALE" DS="$DETAIL_SCALE" CT="$CHILD_TYPES" python3 <<'PY'
import json, os, re, sys

try:
    data = json.loads(os.environ["CH"])
except json.JSONDecodeError:
    sys.exit("ERROR: could not read child nodes")
root = data if "id" in data else data.get("node", data)

def slug(text):
    cleaned = re.sub(r"[^\w\-. ]+", "_", str(text or ""), flags=re.UNICODE).strip()
    return (cleaned or "node")[:60]

wanted = set(os.environ["CT"].split(","))
node_id, fmt, ext = os.environ["NI"], os.environ["FT"], os.environ["EX"]
overview, detail = float(os.environ["OS"]), float(os.environ["DS"])

items = [{"nodeId": node_id, "format": fmt, "scale": overview,
          "outputPath": f"00_{slug(root.get('name'))}@{os.environ['OS']}x.{ext}"}]
children = [c for c in (root.get("children") or []) if c.get("type") in wanted]
for index, child in enumerate(children, 1):
    items.append({
        "nodeId": child["id"], "format": fmt, "scale": detail,
        "outputPath": f"detail/{index:02d}_{slug(child.get('name'))}@{os.environ['DS']}x.{ext}",
    })

print(json.dumps({"fileKey": os.environ["FK"], "items": items}))
sys.stderr.write(f"    Parent {root.get('name')} / children {len(children)}\n")
PY
)"
else
  NAME="${NODE_ID//:/-}@${SCALE}x.${EXT}"
  ARGS="$(FK="$FILE_KEY" NI="$NODE_ID" NM="$NAME" FT="$FORMAT" SC="$SCALE" python3 <<'PY'
import json, os
print(json.dumps({"fileKey": os.environ["FK"], "items": [{
    "nodeId": os.environ["NI"], "outputPath": os.environ["NM"],
    "format": os.environ["FT"], "scale": float(os.environ["SC"])}]}))
PY
)"
fi

echo "==> Exporting"
RESULT_FILE="$(mktemp "$OUT_DIR/.figma-export-result.XXXXXX")"
bridge_call save_screenshots "$ARGS" >"$RESULT_FILE"
RESULT="$RESULT_FILE" python3 <<'PY'
import json, os, sys

raw = open(os.environ["RESULT"], encoding="utf-8").read()
try:
    data = json.loads(raw)
except json.JSONDecodeError:
    sys.exit(raw[:400])

print("    Succeeded {} / failed {}".format(data.get("succeeded"), data.get("failed")))
for item in data.get("results", []):
    if item.get("success"):
        print("    {}  {:,} bytes".format(item.get("outputPath", ""), item.get("bytesWritten", 0)))
    else:
        print("    ERROR {}".format(item.get("error")), file=sys.stderr)
PY

if [[ $STRUCTURE -eq 1 ]]; then
  python3 "$SCRIPT_DIR/structure-export.py" verify \
    --plan "$PLAN_FILE" \
    --result "$RESULT_FILE" \
    --out "$OUT_DIR" \
    --manifest "$OUT_DIR/manifest.json"
fi

echo "==> Original visibility: $ORIGINAL_STATE"
