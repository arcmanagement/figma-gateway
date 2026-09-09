#!/usr/bin/env python3
"""Build and verify a structured Figma container export plan."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


EXPORT_TYPES = {"SECTION", "FRAME"}
ROOT_TYPES = EXPORT_TYPES | {"GROUP", "COMPONENT", "COMPONENT_SET", "INSTANCE"}
BOARD_ROOT_TYPES = ROOT_TYPES | {"PAGE"}
SLIDES_ROOT_TYPES = {"PAGE", "SLIDE_GRID", "SLIDE_ROW", "SLIDE"}
# Layout-only nodes that cannot be rendered by the gateway remain in the manifest.
STRUCTURE_ONLY_ROOT_TYPES = {"PAGE", "SLIDE_GRID", "SLIDE_ROW"}
COMPONENT_BOUNDARY_TYPES = {"COMPONENT", "COMPONENT_SET", "INSTANCE"}
ARROW_STROKE_CAPS = {"ARROW_EQUILATERAL", "ARROW_LINES", "TRIANGLE_FILLED"}

MANIFEST_CONVENTIONS = {
    "scope": (
        "The root, every SECTION descendant, and every outermost FRAME "
        "returned by the Figma bridge get_node response. Hidden descendants "
        "are not returned by the bridge and therefore are not included."
    ),
    "frameSelection": (
        "A descendant FRAME is exported only when it is not inside another "
        "FRAME, COMPONENT, COMPONENT_SET, or INSTANCE. Nested layout and "
        "component FRAME nodes are omitted."
    ),
    "rootIncludedInNodes": True,
    "rootIncludedInTypeCounts": True,
    "documentOrder": "One-based depth-first pre-order from the Figma child arrays.",
    "siblingOrder": "One-based within siblingNodeIds.",
    "siblingNodeIds": "Includes the current node.",
    "layout": (
        "Use bounds for absolute canvas placement and relativeBounds for "
        "placement relative to parentExportNode."
    ),
    "semantics": (
        "CONNECTOR relations preserve Figma endpoints, arrow direction, and "
        "labels. They do not infer navigation or state-transition semantics."
    ),
}

# Slides use each slide as an export unit.
SLIDES_CONVENTION_OVERRIDES = {
    "scope": (
        "The root and every SLIDE descendant returned by the Figma bridge "
        "get_node response. Hidden descendants are not returned by the bridge "
        "and therefore are not included."
    ),
    "frameSelection": (
        "Slides export one image per SLIDE node. SLIDE_GRID and SLIDE_ROW "
        "are layout containers and keep structure only."
    ),
    "semantics": (
        "Slides normally contain no CONNECTOR nodes, so relations stay "
        "empty. Slide order follows the document order of the slide grid."
    ),
}

# FigJam boards do not have an outermost-frame convention.
BOARD_CONVENTION_OVERRIDES = {
    "scope": (
        "The root and every SECTION descendant returned by the Figma bridge "
        "get_node response. Hidden descendants are not returned by the bridge "
        "and therefore are not included."
    ),
    "frameSelection": (
        "FigJam boards normally contain no FRAME nodes. When present, the "
        "same outermost FRAME rule as design files applies."
    ),
    "semantics": (
        "CONNECTOR relations resolve each endpoint to the endpoint node "
        "itself (sticky, shape, or other board content) and include its "
        "text. They do not infer workflow or state-transition semantics."
    ),
}


def slug(value: str) -> str:
    cleaned = re.sub(r"[^\w\-. ]+", "_", str(value or ""), flags=re.UNICODE).strip()
    return (cleaned or "node")[:60]


def unwrap_node(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit("ERROR: node JSON must be an object")
    node = value if "id" in value else value.get("node")
    if not isinstance(node, dict):
        raise SystemExit("ERROR: node JSON does not contain a node")
    return node


def node_reference(node: dict[str, Any]) -> dict[str, str]:
    return {
        "id": str(node.get("id", "")),
        "name": str(node.get("name", "")),
        "type": str(node.get("type", "")),
    }


def normalize_bounds(value: Any) -> dict[str, float] | None:
    if not isinstance(value, dict):
        return None
    keys = ("x", "y", "width", "height")
    if any(not isinstance(value.get(key), (int, float)) for key in keys):
        return None
    return {key: value[key] for key in keys}


def relative_bounds(
    bounds: dict[str, float] | None, parent_bounds: dict[str, float] | None
) -> dict[str, float] | None:
    if bounds is None or parent_bounds is None:
        return None
    return {
        "x": bounds["x"] - parent_bounds["x"],
        "y": bounds["y"] - parent_bounds["y"],
        "width": bounds["width"],
        "height": bounds["height"],
    }


def collect_structure(
    root: dict[str, Any], kind: str = "design"
) -> list[dict[str, Any]]:
    root_type = str(root.get("type", ""))
    if kind == "board":
        allowed_types = BOARD_ROOT_TYPES
    elif kind == "slides":
        allowed_types = SLIDES_ROOT_TYPES
    else:
        allowed_types = ROOT_TYPES
    if root_type not in allowed_types:
        allowed = ", ".join(sorted(allowed_types))
        raise SystemExit(
            f"ERROR: URL node must be a supported container ({allowed}): "
            f"{root.get('id')} {root_type}"
        )

    root_id = str(root.get("id", ""))
    if not root_id:
        raise SystemExit("ERROR: root container node ID is empty")

    records: list[dict[str, Any]] = []
    seen: set[str] = set()

    def walk(
        node: dict[str, Any],
        *,
        parent_node: dict[str, str] | None,
        parent_export: dict[str, Any] | None,
        scene_path: list[dict[str, str]],
        export_path: list[dict[str, str]],
        scene_depth: int,
        section_depth: int,
        frame_depth: int,
        inside_component: bool,
        inside_frame: bool,
        is_root: bool = False,
    ) -> None:
        node_type = str(node.get("type", ""))
        reference = node_reference(node)
        current_scene_path = [*scene_path, reference]
        is_outermost_frame = (
            node_type == "FRAME" and not inside_frame and not inside_component
        )
        if kind == "slides":
            should_export = is_root or node_type == "SLIDE"
        else:
            should_export = is_root or node_type == "SECTION" or is_outermost_frame
        current_export = parent_export
        current_export_path = export_path

        if should_export:
            node_id = reference["id"]
            if not node_id or node_id in seen:
                raise SystemExit("ERROR: exported node ID is empty or duplicated")
            seen.add(node_id)
            bounds = normalize_bounds(node.get("bounds"))
            parent_bounds = (
                parent_export.get("bounds") if parent_export is not None else None
            )
            record = {
                **reference,
                "documentOrder": len(records) + 1,
                "sceneDepth": scene_depth,
                "exportDepth": 0
                if parent_export is None
                else parent_export["exportDepth"] + 1,
                "sectionDepth": section_depth,
                "frameDepth": frame_depth,
                "parentNode": parent_node,
                "parentExportNode": None
                if parent_export is None
                else node_reference(parent_export),
                "childNodeIds": [],
                "siblingOrder": 1,
                "siblingNodeIds": [],
                "scenePath": current_scene_path,
                "exportPath": [*export_path, reference],
                "bounds": bounds,
                "relativeBounds": relative_bounds(bounds, parent_bounds),
            }
            records.append(record)
            current_export = record
            current_export_path = record["exportPath"]

        children = node.get("children", [])
        if not isinstance(children, list):
            return
        children_inside_component = (
            inside_component or node_type in COMPONENT_BOUNDARY_TYPES
        )
        children_inside_frame = inside_frame or node_type == "FRAME"
        for child in children:
            if not isinstance(child, dict):
                continue
            child_type = str(child.get("type", ""))
            walk(
                child,
                parent_node=reference,
                parent_export=current_export,
                scene_path=current_scene_path,
                export_path=current_export_path,
                scene_depth=scene_depth + 1,
                section_depth=section_depth + (1 if child_type == "SECTION" else 0),
                frame_depth=frame_depth + (1 if child_type == "FRAME" else 0),
                inside_component=children_inside_component,
                inside_frame=children_inside_frame,
            )

    walk(
        root,
        parent_node=None,
        parent_export=None,
        scene_path=[],
        export_path=[],
        scene_depth=0,
        section_depth=0,
        frame_depth=0,
        inside_component=False,
        inside_frame=False,
        is_root=True,
    )

    by_id = {record["id"]: record for record in records}
    for record in records:
        parent = record.get("parentExportNode")
        if isinstance(parent, dict) and parent.get("id") in by_id:
            by_id[parent["id"]]["childNodeIds"].append(record["id"])

    for record in records:
        parent = record.get("parentExportNode")
        sibling_ids = (
            by_id[parent["id"]]["childNodeIds"]
            if isinstance(parent, dict) and parent.get("id") in by_id
            else [record["id"]]
        )
        record["siblingNodeIds"] = sibling_ids
        record["siblingOrder"] = sibling_ids.index(record["id"]) + 1

    return records


def collect_scene_index(
    root: dict[str, Any],
) -> tuple[dict[str, dict[str, Any]], dict[str, str], list[dict[str, Any]]]:
    nodes: dict[str, dict[str, Any]] = {}
    parents: dict[str, str] = {}
    connectors: list[dict[str, Any]] = []

    def walk(node: dict[str, Any], parent_id: str | None = None) -> None:
        node_id = str(node.get("id", ""))
        if node_id:
            nodes[node_id] = node
            if parent_id:
                parents[node_id] = parent_id
            if node.get("type") == "CONNECTOR":
                connectors.append(node)
        children = node.get("children", [])
        if not isinstance(children, list):
            return
        for child in children:
            if isinstance(child, dict):
                walk(child, node_id or parent_id)

    walk(root)
    return nodes, parents, connectors


def normalize_connector_endpoint(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    endpoint: dict[str, Any] = {}
    endpoint_node_id = value.get("endpointNodeId")
    if isinstance(endpoint_node_id, str) and endpoint_node_id:
        endpoint["endpointNodeId"] = endpoint_node_id
    position = value.get("position")
    if (
        isinstance(position, dict)
        and isinstance(position.get("x"), (int, float))
        and isinstance(position.get("y"), (int, float))
    ):
        endpoint["position"] = {"x": position["x"], "y": position["y"]}
    magnet = value.get("magnet")
    if isinstance(magnet, str) and magnet:
        endpoint["magnet"] = magnet
    return endpoint


def resolve_connector_endpoint(
    endpoint: dict[str, Any],
    scene_nodes: dict[str, dict[str, Any]],
    scene_parents: dict[str, str],
    exported_nodes: dict[str, dict[str, Any]],
    kind: str = "design",
) -> tuple[dict[str, Any] | None, str | None]:
    endpoint_node_id = str(endpoint.get("endpointNodeId", ""))
    if not endpoint_node_id:
        return None, "endpointNodeId is missing"
    if endpoint_node_id not in scene_nodes:
        return None, "endpointNodeId is outside the exported root"

    if kind == "board":
        # Board endpoints directly identify meaningful sticky notes or shapes.
        node = scene_nodes[endpoint_node_id]
        reference: dict[str, Any] = node_reference(node)
        characters = node.get("characters")
        if isinstance(characters, str) and characters:
            reference["characters"] = characters
        shape_type = node.get("shapeType")
        if isinstance(shape_type, str) and shape_type:
            reference["shapeType"] = shape_type
        return reference, None

    current_id = endpoint_node_id
    visited: set[str] = set()
    while current_id and current_id not in visited:
        visited.add(current_id)
        exported = exported_nodes.get(current_id)
        if exported is not None and exported.get("type") == "FRAME":
            return node_reference(exported), None
        current_id = scene_parents.get(current_id, "")
    return None, "endpoint has no exported FRAME ancestor"


def connector_direction(start_cap: str, end_cap: str) -> str:
    start_has_arrow = start_cap in ARROW_STROKE_CAPS
    end_has_arrow = end_cap in ARROW_STROKE_CAPS
    if start_has_arrow and end_has_arrow:
        return "bidirectional"
    if start_has_arrow:
        return "end_to_start"
    if end_has_arrow:
        return "start_to_end"
    return "undirected"


def collect_connector_relations(
    root: dict[str, Any], exported: list[dict[str, Any]], kind: str = "design"
) -> list[dict[str, Any]]:
    scene_nodes, scene_parents, connectors = collect_scene_index(root)
    exported_nodes = {node["id"]: node for node in exported}
    relations: list[dict[str, Any]] = []

    for connector in connectors:
        connector_data = connector.get("connector", {})
        if not isinstance(connector_data, dict):
            connector_data = {}
        start_endpoint = normalize_connector_endpoint(connector_data.get("start"))
        end_endpoint = normalize_connector_endpoint(connector_data.get("end"))
        start_node, start_issue = resolve_connector_endpoint(
            start_endpoint, scene_nodes, scene_parents, exported_nodes, kind
        )
        end_node, end_issue = resolve_connector_endpoint(
            end_endpoint, scene_nodes, scene_parents, exported_nodes, kind
        )
        start_cap = str(connector_data.get("startStrokeCap", "NONE"))
        end_cap = str(connector_data.get("endStrokeCap", "NONE"))
        direction = connector_direction(start_cap, end_cap)
        issues = []
        if start_issue:
            issues.append({"endpoint": "start", "reason": start_issue})
        if end_issue:
            issues.append({"endpoint": "end", "reason": end_issue})

        target_key = "node" if kind == "board" else "frame"
        start = {"connectorEndpoint": start_endpoint, target_key: start_node}
        end = {"connectorEndpoint": end_endpoint, target_key: end_node}
        from_node = start_node if direction == "start_to_end" else end_node
        to_node = end_node if direction == "start_to_end" else start_node
        if direction not in {"start_to_end", "end_to_start"}:
            from_node = None
            to_node = None

        relation = {
            "id": str(connector.get("id", "")),
            "type": "CONNECTOR",
            "label": str(connector.get("name", "")),
            "lineType": str(connector_data.get("lineType", "")),
            "direction": direction,
            "startStrokeCap": start_cap,
            "endStrokeCap": end_cap,
            "start": start,
            "end": end,
            "fromNode": from_node,
            "toNode": to_node,
            "bounds": normalize_bounds(connector.get("bounds")),
            "status": "resolved" if not issues else "unresolved",
            "resolutionIssues": issues,
        }
        if kind == "board":
            label_text = connector.get("characters")
            relation["text"] = label_text if isinstance(label_text, str) else None
        relations.append(relation)

    return relations


def build_tree(nodes: list[dict[str, Any]]) -> dict[str, Any]:
    if not nodes:
        raise SystemExit("ERROR: structure contains no exportable nodes")
    by_id = {node["id"]: node for node in nodes}

    def branch(node_id: str) -> dict[str, Any]:
        node = by_id[node_id]
        return {
            "id": node["id"],
            "name": node["name"],
            "type": node["type"],
            "documentOrder": node["documentOrder"],
            "sceneDepth": node["sceneDepth"],
            "exportDepth": node["exportDepth"],
            "siblingOrder": node["siblingOrder"],
            "outputPath": node.get("outputPath"),
            "bounds": node.get("bounds"),
            "relativeBounds": node.get("relativeBounds"),
            "export": node.get("export"),
            "children": [branch(child_id) for child_id in node["childNodeIds"]],
        }

    return branch(nodes[0]["id"])


def select_file(
    list_files_data: Any,
    file_name: str,
    instance: str | None = None,
    excluded_file_keys: set[str] | None = None,
) -> dict[str, str]:
    if not file_name:
        raise SystemExit("ERROR: expected Figma file name is empty")
    if isinstance(list_files_data, dict):
        files = list_files_data.get("files", [])
    else:
        files = list_files_data
    if not isinstance(files, list):
        raise SystemExit("ERROR: list_files response does not contain a file list")

    connected = [
        {
            "instance": str(item.get("instance", "")),
            "fileKey": str(item.get("fileKey", "")),
            "fileName": str(item.get("fileName", "")),
        }
        for item in files
        if isinstance(item, dict)
    ]
    excluded = excluded_file_keys or set()
    matches = [
        item for item in connected
        if item["fileName"] == file_name
        and (instance is None or item["instance"] == instance)
        and item["fileKey"] not in excluded
    ]
    if len(matches) != 1 or not matches[0]["fileKey"]:
        names = ", ".join(item["fileName"] or "<unnamed>" for item in connected)
        if not names:
            names = "<none>"
        raise SystemExit(
            f"ERROR: expected one new connected Figma file named {file_name!r} "
            f"for instance {instance!r}; "
            f"connected files: {names}"
        )
    return matches[0]


def build_plan(
    node_data: Any,
    file_key: str,
    export_format: str,
    overview_scale: float,
    detail_scale: float,
    source_url: str | None = None,
    kind: str = "design",
) -> dict[str, Any]:
    if not file_key:
        raise SystemExit("ERROR: file key is required")
    if overview_scale <= 0 or detail_scale <= 0:
        raise SystemExit("ERROR: export scales must be greater than zero")

    export_format = export_format.upper()
    if export_format not in {"PNG", "JPG", "SVG", "PDF"}:
        raise SystemExit(f"ERROR: unsupported export format: {export_format}")

    root_node = unwrap_node(node_data)
    nodes = collect_structure(root_node, kind)
    relations = collect_connector_relations(root_node, nodes, kind)
    extension = export_format.lower()
    items: list[dict[str, Any]] = []
    output_paths: set[str] = set()
    for index, node in enumerate(nodes):
        if index == 0 and node["type"] in STRUCTURE_ONLY_ROOT_TYPES:
            # Keep layout-only roots as structure without requesting an image.
            node["outputPath"] = None
            continue
        if index == 0:
            output_path = f"00_{slug(node['name'])}@{overview_scale:g}x.{extension}"
            scale = overview_scale
        else:
            if node["type"] == "SECTION":
                folder = "sections"
            elif node["type"] == "SLIDE":
                folder = "slides"
            else:
                folder = "frames"
            output_path = (
                f"{folder}/{index:03d}_d{node['exportDepth']}_"
                f"{slug(node['name'])}@{detail_scale:g}x.{extension}"
            )
            scale = detail_scale
        if output_path in output_paths:
            raise SystemExit(f"ERROR: duplicate output path: {output_path}")
        output_paths.add(output_path)
        node["outputPath"] = output_path
        items.append(
            {
                "nodeId": node["id"],
                "outputPath": output_path,
                "format": export_format,
                "scale": scale,
            }
        )

    sections = [node for node in nodes if node["type"] == "SECTION"]
    frames = [node for node in nodes if node["type"] == "FRAME"]
    type_counts: dict[str, int] = {}
    for node in nodes:
        type_counts[node["type"]] = type_counts.get(node["type"], 0) + 1

    conventions = dict(MANIFEST_CONVENTIONS)
    if kind == "board":
        conventions.update(BOARD_CONVENTION_OVERRIDES)
    elif kind == "slides":
        conventions.update(SLIDES_CONVENTION_OVERRIDES)

    return {
        "manifestVersion": 3,
        "kind": kind,
        "conventions": conventions,
        "source": {
            "url": source_url,
            "fileKey": file_key,
            "rootNodeId": nodes[0]["id"],
        },
        "fileKey": file_key,
        "root": nodes[0],
        "nodeCount": len(nodes),
        "sectionCount": len(sections),
        "frameCount": len(frames),
        "typeCounts": type_counts,
        "nodes": nodes,
        "sections": sections,
        "frames": frames,
        "relationCount": len(relations),
        "resolvedRelationCount": sum(
            1 for relation in relations if relation["status"] == "resolved"
        ),
        "unresolvedRelationCount": sum(
            1 for relation in relations if relation["status"] == "unresolved"
        ),
        "relations": relations,
        "unresolvedRelations": [
            relation for relation in relations if relation["status"] == "unresolved"
        ],
        "tree": build_tree(nodes),
        "request": {"fileKey": file_key, "items": items},
    }


def verify_export(
    plan: dict[str, Any], result: dict[str, Any], output_dir: Path
) -> dict[str, Any]:
    request = plan.get("request", {})
    requested_items = request.get("items", []) if isinstance(request, dict) else []
    results = result.get("results", []) if isinstance(result, dict) else []
    if (
        not isinstance(requested_items, list)
        or not isinstance(results, list)
        or result.get("failed", 0)
        or len(results) != len(requested_items)
    ):
        raise SystemExit("ERROR: export result is incomplete")

    expected = {
        (str(item.get("nodeId", "")), str(item.get("outputPath", ""))): item
        for item in requested_items
        if isinstance(item, dict)
    }
    verified: list[dict[str, Any]] = []
    verified_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    observed: set[tuple[str, str]] = set()
    for item in results:
        if not isinstance(item, dict):
            raise SystemExit("ERROR: export result item must be an object")
        raw_path = str(item.get("outputPath", ""))
        path = Path(raw_path)
        if path.is_absolute():
            try:
                relative_path = str(path.resolve().relative_to(output_dir.resolve()))
            except ValueError as error:
                raise SystemExit("ERROR: export path is outside output directory") from error
        else:
            relative_path = raw_path
            path = output_dir / relative_path
        key = (str(item.get("nodeId", "")), relative_path)
        if key not in expected or key in observed:
            raise SystemExit("ERROR: export result does not match the request")
        observed.add(key)
        if not item.get("success") or not path.is_file() or path.stat().st_size == 0:
            raise SystemExit(f"ERROR: exported file cannot be verified: {relative_path}")
        verified_item = {
            "nodeId": key[0],
            "outputPath": relative_path,
            "bytesWritten": path.stat().st_size,
            "width": item.get("width"),
            "height": item.get("height"),
        }
        verified.append(verified_item)
        verified_by_key[key] = verified_item

    nodes: list[dict[str, Any]] = []
    for raw_node in plan.get("nodes", []):
        node = dict(raw_node)
        if (
            node.get("outputPath") is None
            and node.get("type") in STRUCTURE_ONLY_ROOT_TYPES
        ):
            node["export"] = None
            nodes.append(node)
            continue
        key = (str(node.get("id", "")), str(node.get("outputPath", "")))
        if key not in verified_by_key:
            raise SystemExit("ERROR: manifest node does not have a verified export")
        node["export"] = verified_by_key[key]
        nodes.append(node)

    sections = [node for node in nodes if node["type"] == "SECTION"]
    frames = [node for node in nodes if node["type"] == "FRAME"]
    type_counts: dict[str, int] = {}
    for node in nodes:
        type_counts[node["type"]] = type_counts.get(node["type"], 0) + 1

    return {
        "manifestVersion": plan.get("manifestVersion", 2),
        "kind": plan.get("kind", "design"),
        "conventions": plan.get("conventions", MANIFEST_CONVENTIONS),
        "source": plan.get("source"),
        "fileKey": plan.get("fileKey"),
        "root": nodes[0],
        "nodeCount": len(nodes),
        "sectionCount": len(sections),
        "frameCount": len(frames),
        "typeCounts": type_counts,
        "nodes": nodes,
        "sections": sections,
        "frames": frames,
        "relationCount": plan.get("relationCount", 0),
        "resolvedRelationCount": plan.get("resolvedRelationCount", 0),
        "unresolvedRelationCount": plan.get("unresolvedRelationCount", 0),
        "relations": plan.get("relations", []),
        "unresolvedRelations": plan.get("unresolvedRelations", []),
        "tree": build_tree(nodes),
        "results": verified,
    }


def read_json(path: str | None) -> Any:
    if path:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    return json.load(sys.stdin)


def create_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)

    plan = subparsers.add_parser("plan")
    plan.add_argument("--file-key", required=True)
    plan.add_argument("--kind", choices=("design", "board", "slides"), default="design")
    plan.add_argument("--format", default="PNG")
    plan.add_argument("--overview-scale", type=float, default=1)
    plan.add_argument("--detail-scale", type=float, default=2)
    plan.add_argument("--source-url")

    select = subparsers.add_parser("select-file")
    select.add_argument("--file-name", required=True)
    select.add_argument("--instance")
    select.add_argument("--exclude-file-keys-json", default="[]")

    verify = subparsers.add_parser("verify")
    verify.add_argument("--plan", required=True)
    verify.add_argument("--result", required=True)
    verify.add_argument("--out", required=True)
    verify.add_argument("--manifest", required=True)
    return parser


def main() -> int:
    args = create_parser().parse_args()
    if args.command == "select-file":
        excluded = set(json.loads(args.exclude_file_keys_json))
        print(json.dumps(select_file(json.load(sys.stdin), args.file_name, args.instance, excluded)))
        return 0

    if args.command == "plan":
        plan = build_plan(
            json.load(sys.stdin),
            args.file_key,
            args.format,
            args.overview_scale,
            args.detail_scale,
            args.source_url,
            args.kind,
        )
        print(json.dumps(plan, ensure_ascii=False, indent=2))
        return 0

    plan = read_json(args.plan)
    result = read_json(args.result)
    manifest = verify_export(plan, result, Path(args.out))
    manifest_path = Path(args.manifest)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(
        f"verified {manifest['nodeCount']} nodes "
        f"({manifest['sectionCount']} sections, {manifest['frameCount']} frames); "
        f"manifest={manifest_path}",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
