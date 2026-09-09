#!/usr/bin/env python3
"""Store, inspect, and remove Figma REST credentials in macOS Keychain."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone


def default_service(kind: str) -> str:
    variant = os.environ.get("FIGMA_VARIANT", "local")
    return os.environ.get("FIGMA_TOKEN_KEYCHAIN_ITEM", f"figma_token_{variant}_{kind}")


def security(*args: str, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["security", *args],
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )


def store(args: argparse.Namespace) -> int:
    access_token = getpass.getpass("Access token: ").strip()
    if not access_token:
        raise SystemExit("ERROR: access token is empty")
    value: dict[str, object] = {"kind": args.kind, "accessToken": access_token}
    if args.kind == "oauth":
        refresh_token = getpass.getpass("Refresh token (optional): ").strip()
        client_id = input("OAuth client ID (optional): ").strip()
        client_secret = getpass.getpass("OAuth client secret (optional): ").strip()
        if refresh_token:
            value["refreshToken"] = refresh_token
        if client_id:
            value["clientId"] = client_id
        if client_secret:
            value["clientSecret"] = client_secret
        if args.expires_in:
            value["expiresAt"] = (
                datetime.now(timezone.utc) + timedelta(seconds=args.expires_in)
            ).isoformat().replace("+00:00", "Z")
    service = args.service or default_service(args.kind)
    result = security(
        "add-generic-password",
        "-U",
        "-a",
        getpass.getuser(),
        "-s",
        service,
        "-w",
        json.dumps(value, separators=(",", ":")),
    )
    if result.returncode:
        raise SystemExit(f"ERROR: Keychain save failed: {result.stderr.strip()}")
    print(f"saved: {service} ({args.kind})")
    return 0


def status(args: argparse.Namespace) -> int:
    service = args.service or default_service(args.kind)
    result = security("find-generic-password", "-w", "-s", service)
    if result.returncode:
        print(f"not configured: {service}")
        return 1
    raw = result.stdout.strip()
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = {"kind": args.kind, "accessToken": raw}
    print(json.dumps({
        "configured": bool(value.get("accessToken")),
        "service": service,
        "kind": value.get("kind", args.kind),
        "expiresAt": value.get("expiresAt"),
        "refreshable": all(value.get(key) for key in ("refreshToken", "clientId", "clientSecret")),
    }, ensure_ascii=False, indent=2))
    return 0


def remove(args: argparse.Namespace) -> int:
    service = args.service or default_service(args.kind)
    result = security("delete-generic-password", "-s", service)
    if result.returncode:
        raise SystemExit(f"ERROR: Keychain delete failed: {result.stderr.strip()}")
    print(f"removed: {service}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("store", "status", "remove"):
        sub = subparsers.add_parser(command)
        sub.add_argument("--kind", choices=("oauth", "pat", "plan"), default="oauth")
        sub.add_argument("--service")
        if command == "store":
            sub.add_argument("--expires-in", type=int)
    args = parser.parse_args()
    if args.command == "store":
        return store(args)
    if args.command == "status":
        return status(args)
    return remove(args)


if __name__ == "__main__":
    sys.exit(main())
