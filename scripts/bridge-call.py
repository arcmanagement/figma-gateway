#!/usr/bin/env python3
"""Call one gateway MCP tool over stdio.

This entry point works even when the gateway is not configured in an MCP host.
The gateway uses a leader/follower design, so a process started here follows an
existing resident leader and observes the same state.

    bridge-call.py <tool> '<JSON arguments>'
    bridge-call.py list_files '{}'
    bridge-call.py get_node '{"nodeId":"1:2","depth":2}'

Environment
    FIGMA_BRIDGE_SERVER  Path to the gateway server index.js. Required.
"""

import json
import os
import pathlib
import queue
import subprocess
import sys
import threading

DEFAULT_SERVER = pathlib.Path(__file__).resolve().parent.parent / "dist/server/index.js"


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)

    server = os.environ.get("FIGMA_BRIDGE_SERVER", str(DEFAULT_SERVER))
    if not server:
        sys.exit("ERROR: FIGMA_BRIDGE_SERVER must point to the gateway server index.js")
    if not os.path.exists(server):
        sys.exit(f"ERROR: {server} does not exist")

    tool = sys.argv[1]
    try:
        arguments = json.loads(sys.argv[2]) if len(sys.argv) >= 3 else {}
    except json.JSONDecodeError as exc:
        sys.exit(f"ERROR: arguments are not valid JSON: {exc}")

    # Output is restricted to the server working tree, so pass the caller cwd.
    proc = subprocess.Popen(["node", server], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1, cwd=os.getcwd())
    lines = queue.Queue()
    threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()

    def send(method, params=None, rid=None):
        message = {"jsonrpc": "2.0", "method": method}
        if rid is not None:
            message["id"] = rid
        if params is not None:
            message["params"] = params
        proc.stdin.write(json.dumps(message) + "\n")
        proc.stdin.flush()

    def recv(rid, timeout=180):
        while True:
            try:
                message = json.loads(lines.get(timeout=timeout))
            except json.JSONDecodeError:
                continue
            except queue.Empty:
                sys.exit("ERROR: the gateway server did not respond")
            if message.get("id") == rid:
                return message

    try:
        send("initialize", {"protocolVersion": "2024-11-05", "capabilities": {},
                            "clientInfo": {"name": "figma-gateway", "version": "0"}}, 1)
        recv(1)
        send("notifications/initialized")
        send("tools/call", {"name": tool, "arguments": arguments}, 2)
        result = recv(2)
    finally:
        proc.terminate()

    if "error" in result:
        sys.exit(f"ERROR: {json.dumps(result['error'], ensure_ascii=False)}")

    content = (result.get("result") or {}).get("content") or [{}]
    print(content[0].get("text", json.dumps(result, ensure_ascii=False)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
