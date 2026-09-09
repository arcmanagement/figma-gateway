#!/usr/bin/env bash
# Render and export Figma nodes through the REST API.
#
# This is a fallback. Prefer the local Plugin for implementation images because
# REST renders are capped at 32 megapixels and share account-level rate limits.
#
# Use this only when the Plugin cannot reach the file, for cross-file work,
# headless access, or a small number of small nodes.
#
# The token is read from macOS Keychain. Store it once with:
#   security add-generic-password -U -a "$(whoami)" -s "$FIGMA_PAT_KEYCHAIN_ITEM" -w
#
# Usage
#   ./figma-export.sh 'https://www.figma.com/design/<key>/<name>?node-id=12167-216643'
#   ./figma-export.sh '<url>' --scale 4 --out ./out
#   ./figma-export.sh --file <key> --node 12167:216643,20749:7222 --format svg
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common.sh
source "$SCRIPT_DIR/common.sh"

KEYCHAIN_ITEM="$FIGMA_PAT_KEYCHAIN_ITEM"
API=https://api.figma.com/v1

FILE_KEY=""
NODE_IDS=""
SCALE=2
FORMAT=png
OUT_DIR="."

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# Extract file key and node ID from design, file, and branch URLs.
parse_url() {
  local url="$1"
  if [[ "$url" =~ /(design|file)/([0-9a-zA-Z]{22,128})/branch/([0-9a-zA-Z]{22,128}) ]]; then
    FILE_KEY="${BASH_REMATCH[3]}"
  elif [[ "$url" =~ /(design|file)/([0-9a-zA-Z]{22,128}) ]]; then
    FILE_KEY="${BASH_REMATCH[2]}"
  else
    echo "ERROR: could not extract a file key from URL: $url" >&2
    exit 1
  fi
  if [[ "$url" =~ node-id=([0-9]+)[:-]([0-9]+) ]]; then
    NODE_IDS="${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage 0 ;;
    --file)   FILE_KEY="$2"; shift 2 ;;
    --node)   NODE_IDS="$2"; shift 2 ;;
    --scale)  SCALE="$2"; shift 2 ;;
    --format) FORMAT="$2"; shift 2 ;;
    --out)    OUT_DIR="$2"; shift 2 ;;
    http*)    parse_url "$1"; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; usage 1 ;;
  esac
done

[[ -n "$FILE_KEY" ]] || { echo "ERROR: provide a URL or --file" >&2; usage 1; }
[[ -n "$NODE_IDS" ]] || { echo "ERROR: provide URL node-id or --node" >&2; usage 1; }

TOKEN="$(security find-generic-password -s "$KEYCHAIN_ITEM" -w 2>/dev/null || true)"
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: could not read a token from Keychain item $KEYCHAIN_ITEM" >&2
  echo "  security add-generic-password -U -a \"\$(whoami)\" -s $KEYCHAIN_ITEM -w" >&2
  exit 1
fi

# Normalize URL-style node IDs to API form.
NODE_IDS="${NODE_IDS//-/:}"
mkdir -p "$OUT_DIR"

WORK_RESPONSE="$(mktemp -t figma-export)"
trap 'rm -f "$WORK_RESPONSE" "$WORK_RESPONSE".*' EXIT

echo "==> file  : $FILE_KEY"
echo "==> nodes : $NODE_IDS"
echo "==> format: $FORMAT scale=$SCALE"

# Batch nodes into one request and back off when the API returns 429.
RESPONSE=""
for attempt in 1 2 3 4 5; do
  HTTP_BODY="$WORK_RESPONSE.body"
  STATUS="$(curl -s -m 60 -o "$HTTP_BODY" -w '%{http_code}' \
    -D "$WORK_RESPONSE.head" \
    -H "X-Figma-Token: $TOKEN" \
    --get "$API/images/$FILE_KEY" \
    --data-urlencode "ids=$NODE_IDS" \
    --data-urlencode "format=$FORMAT" \
    --data-urlencode "scale=$SCALE")"
  if [[ "$STATUS" != "429" ]]; then
    RESPONSE="$(cat "$HTTP_BODY")"
    [[ "$STATUS" == "200" ]] || { echo "ERROR: HTTP $STATUS" >&2; echo "$RESPONSE" >&2; exit 1; }
    break
  fi
  RETRY_AFTER="$(awk 'tolower($1) == "retry-after:" { gsub(/\r/, "", $2); print $2 }' "$WORK_RESPONSE.head")"
  WAIT="${RETRY_AFTER:-$((2 ** attempt))}"
  echo "    Rate limited; retrying in ${WAIT}s ($attempt/5)" >&2
  sleep "$WAIT"
done
[[ -n "$RESPONSE" ]] || { echo "ERROR: rate limit persisted after five attempts" >&2; exit 1; }

RESPONSE="$RESPONSE" OUT_DIR="$OUT_DIR" FORMAT="$FORMAT" SCALE="$SCALE" python3 <<'PY'
import json, os, subprocess, sys

data = json.loads(os.environ["RESPONSE"])
if data.get("err"):
    sys.exit(f"ERROR: Figma API: {data['err']}")

out_dir, fmt, scale = os.environ["OUT_DIR"], os.environ["FORMAT"], os.environ["SCALE"]
images = data.get("images") or {}
if not images:
    sys.exit("ERROR: empty render result; verify the node IDs")

for node_id, url in images.items():
    if not url:
        print(f"    {node_id}: render failed; the node is missing or cannot be rendered")
        continue
    name = f"{node_id.replace(':', '-')}@{scale}x.{fmt}"
    path = os.path.join(out_dir, name)
    subprocess.run(["curl", "-s", "-m", "120", "-o", path, url], check=True)
    size = os.path.getsize(path)
    dims = ""
    if fmt in ("png", "jpg"):
        probe = subprocess.run(
            ["sips", "-g", "pixelWidth", "-g", "pixelHeight", path],
            capture_output=True, text=True,
        )
        vals = [ln.split(":")[-1].strip() for ln in probe.stdout.splitlines() if "pixel" in ln]
        if len(vals) == 2:
            dims = f"{vals[0]}x{vals[1]} "
    print(f"    {path}  {dims}{size:,} bytes")
PY
