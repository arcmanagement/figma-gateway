#!/usr/bin/env python3
"""Validate a local development plugin and print Figma's supported import steps."""

import argparse
import json
import os
import pathlib
import sys


if os.environ.get("FIGMA_GATEWAY_PLUGIN_DIR"):
    DEFAULT_MANIFEST = pathlib.Path(os.environ["FIGMA_GATEWAY_PLUGIN_DIR"]) / "manifest.json"
elif sys.platform == "win32":
    DEFAULT_MANIFEST = pathlib.Path(
        os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local")
    ) / "FigmaGateway" / "plugin" / "manifest.json"
else:
    DEFAULT_MANIFEST = (
        pathlib.Path.home()
        / "Library"
        / "Application Support"
        / "Figma Gateway"
        / "plugin"
        / "manifest.json"
    )


def validate_manifest(manifest_path: pathlib.Path):
    manifest_path = manifest_path.expanduser().resolve()
    if not manifest_path.is_file():
        raise ValueError(f"Manifest does not exist: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError(f"Could not read the manifest: {error}") from error

    for field in ("name", "id", "main"):
        if not isinstance(manifest.get(field), str) or not manifest[field].strip():
            raise ValueError(f"Manifest field is missing or invalid: {field}")

    base = manifest_path.parent
    referenced = [base / manifest["main"]]
    if manifest.get("ui"):
        referenced.append(base / manifest["ui"])
    missing = [str(file_path) for file_path in referenced if not file_path.is_file()]
    if missing:
        raise ValueError(f"Plugin build output is missing: {', '.join(missing)}")
    return manifest, manifest_path


def manifest_summary(manifest, manifest_path):
    return {
        "name": manifest["name"],
        "id": manifest["id"],
        "manifest": str(manifest_path),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", nargs="?", type=pathlib.Path)
    parser.add_argument("--json", action="store_true", help="Print machine-readable output")
    args = parser.parse_args()

    try:
        manifest_paths = [args.manifest] if args.manifest else [
            DEFAULT_MANIFEST,
            DEFAULT_MANIFEST.parent / "dev" / "manifest.json",
        ]
        manifests = [validate_manifest(path) for path in manifest_paths]
    except ValueError as error:
        parser.error(str(error))

    if args.json:
        if args.manifest:
            manifest, manifest_path = manifests[0]
            print(json.dumps({
                "ok": True,
                **manifest_summary(manifest, manifest_path),
                "manualImportRequired": True,
            }))
        else:
            print(json.dumps({
                "ok": True,
                "manifests": [manifest_summary(*item) for item in manifests],
                "manualImportRequired": True,
            }))
        return 0

    for _, manifest_path in manifests:
        print(f"Manifest ready: {manifest_path}")
    print("In Figma Desktop, choose Plugins > Development > Import plugin from manifest.")
    print("Select each manifest path shown above. This step is required once per computer.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
