#!/usr/bin/env python3
"""Render a Figma bridge get_node structure as a Markdown document.

Supports both Design files and FigJam boards. The document kind is detected from
the structure unless --kind is provided. Supplemental elements are ordered by
position and attached to nearby flow elements when possible.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

# FigJam types that can act as flow nodes and connector endpoints.
BOARD_FLOW_TYPES = {"SHAPE_WITH_TEXT", "STICKY", "TEXT"}
# Supplemental types listed in reading order when they are not connected.
NOTE_TYPES = {"STICKY", "TEXT", "CODE_BLOCK", "TABLE", "LINK_UNFURL", "EMBED", "STAMP"}
NOTE_LABELS = {
    "STICKY": "Sticky note",
    "TEXT": "Note",
    "CODE_BLOCK": "Code",
    "TABLE": "Table",
    "LINK_UNFURL": "Link",
    "EMBED": "Embed",
    "STAMP": "Stamp",
}
ARROW_STROKE_CAPS = {"ARROW_EQUILATERAL", "ARROW_LINES", "TRIANGLE_FILLED"}
COMPONENT_BOUNDARY_TYPES = {"COMPONENT", "COMPONENT_SET", "INSTANCE"}
# Maximum center-to-center distance for attaching a note to a flow element.
NOTE_ATTACH_DISTANCE = 450
# Maximum vertical offset for elements in the same reading-order row.
READING_BAND_HEIGHT = 60


def unwrap_node(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit("ERROR: structure JSON must be an object")
    node = value if "id" in value else value.get("node")
    if not isinstance(node, dict):
        raise SystemExit("ERROR: structure JSON does not contain a node")
    return node


class Scene:
    def __init__(self, root: dict[str, Any]) -> None:
        self.root = root
        self.nodes: dict[str, dict[str, Any]] = {}
        self.parents: dict[str, str] = {}
        self.order: dict[str, int] = {}
        self._walk(root, None)
        self.edges, self.connected = self._collect_edges()

    def _walk(self, node: dict[str, Any], parent_id: str | None) -> None:
        node_id = str(node.get("id", ""))
        if node_id:
            self.nodes[node_id] = node
            self.order[node_id] = len(self.order)
            if parent_id:
                self.parents[node_id] = parent_id
        children = node.get("children", [])
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    self._walk(child, node_id or parent_id)

    def _collect_edges(self) -> tuple[list[dict[str, Any]], set[str]]:
        edges: list[dict[str, Any]] = []
        connected: set[str] = set()
        for node in self.nodes.values():
            if node.get("type") != "CONNECTOR":
                continue
            data = node.get("connector") or {}
            start = str((data.get("start") or {}).get("endpointNodeId") or "")
            end = str((data.get("end") or {}).get("endpointNodeId") or "")
            if start not in self.nodes or end not in self.nodes:
                continue
            start_arrow = data.get("startStrokeCap") in ARROW_STROKE_CAPS
            end_arrow = data.get("endStrokeCap") in ARROW_STROKE_CAPS
            if start_arrow and not end_arrow:
                start, end = end, start
            edges.append(
                {
                    "from": start,
                    "to": end,
                    "text": connector_label(node),
                    "bidirectional": start_arrow and end_arrow,
                }
            )
            connected.add(start)
            connected.add(end)
        return edges, connected

    def section_of(self, node_id: str) -> str | None:
        current = self.parents.get(node_id)
        while current:
            if self.nodes[current].get("type") == "SECTION":
                return current
            current = self.parents.get(current)
        return None

    def frame_of(self, node_id: str) -> str | None:
        current = node_id
        result = None
        while current:
            if self.nodes[current].get("type") == "FRAME":
                result = current
            current = self.parents.get(current)
        return result

    def slide_of(self, node_id: str) -> str | None:
        current = self.parents.get(node_id)
        while current:
            if self.nodes[current].get("type") == "SLIDE":
                return current
            current = self.parents.get(current)
        return None

    def center(self, node_id: str) -> tuple[float, float] | None:
        bounds = self.nodes[node_id].get("bounds") or {}
        if not isinstance(bounds, dict) or "x" not in bounds:
            return None
        return (
            bounds.get("x", 0) + bounds.get("width", 0) / 2,
            bounds.get("y", 0) + bounds.get("height", 0) / 2,
        )

    def reading_order(self, ids: list[str]) -> list[str]:
        remaining = sorted(
            ids, key=lambda nid: (self.center(nid) or (0.0, 0.0))[1]
        )
        ordered: list[str] = []
        while remaining:
            base_y = (self.center(remaining[0]) or (0.0, 0.0))[1]
            band = [
                nid
                for nid in remaining
                if abs((self.center(nid) or (0.0, 0.0))[1] - base_y)
                < READING_BAND_HEIGHT
            ]
            band.sort(key=lambda nid: (self.center(nid) or (0.0, 0.0))[0])
            ordered.extend(band)
            remaining = [nid for nid in remaining if nid not in band]
        return ordered


def label(node: dict[str, Any]) -> str:
    text = str(node.get("characters") or node.get("name") or "").strip()
    return re.sub(r"\s+", " ", text)


def connector_label(node: dict[str, Any]) -> str:
    text = str(node.get("characters") or "").strip()
    if text:
        return re.sub(r"\s+", " ", text)
    name = str(node.get("name") or "").strip()
    if name.startswith("Connector"):
        return ""
    return re.sub(r"\s+", " ", name)


def detect_kind(scene: Scene) -> str:
    # Check for slides before a PAGE root because a full Slides export also uses PAGE.
    for node in scene.nodes.values():
        if node.get("type") == "SLIDE":
            return "slides"
    if scene.root.get("type") == "PAGE":
        return "board"
    for node in scene.nodes.values():
        if node.get("type") in {"STICKY", "SHAPE_WITH_TEXT"}:
            return "board"
    return "design"


def render_note(scene: Scene, node_id: str, indent: str) -> list[str]:
    node = scene.nodes[node_id]
    node_type = str(node.get("type", ""))
    kind_label = NOTE_LABELS.get(node_type, "Supplement")
    lines: list[str] = []
    if node_type == "TABLE":
        table = node.get("table") or {}
        cells = table.get("cells") or []
        if cells:
            lines.append(f"{indent}- Table:")
            header = cells[0]
            lines.append(f"{indent}  | " + " | ".join(header) + " |")
            lines.append(f"{indent}  |" + "---|" * len(header))
            for row in cells[1:]:
                lines.append(f"{indent}  | " + " | ".join(row) + " |")
        return lines
    if node_type == "CODE_BLOCK":
        language = str(node.get("codeLanguage", "")).lower()
        lines.append(f"{indent}- Code:")
        lines.append(f"{indent}  ```{language}")
        for code_line in str(node.get("characters") or "").splitlines():
            lines.append(f"{indent}  {code_line}")
        lines.append(f"{indent}  ```")
        return lines
    if node_type in {"LINK_UNFURL", "EMBED"}:
        link = node.get("link") or {}
        url = link.get("url") or ""
        title = link.get("title") or label(node) or url
        if url:
            lines.append(f"{indent}- {kind_label}: [{title}]({url})")
        elif title:
            lines.append(f"{indent}- {kind_label}: {title}")
        return lines
    text = label(node)
    if not text:
        return lines
    link = node.get("link") or {}
    if link.get("url"):
        lines.append(f"{indent}- {kind_label}: [{text}]({link['url']})")
    else:
        lines.append(f"{indent}- {kind_label}: {text}")
    return lines


def nearest_flow_node(scene: Scene, node_id: str) -> str | None:
    center = scene.center(node_id)
    if not center:
        return None
    section = scene.section_of(node_id)
    best = None
    best_distance = math.inf
    for candidate in scene.connected:
        if scene.section_of(candidate) != section:
            continue
        other = scene.center(candidate)
        if not other:
            continue
        distance = math.dist(center, other)
        if distance < best_distance:
            best, best_distance = candidate, distance
    return best if best_distance < NOTE_ATTACH_DISTANCE else None


def render_edges(scene: Scene, edges: list[dict[str, Any]]) -> list[str]:
    lines = ["Connections:"]
    seen: set[tuple[str, str, str]] = set()
    for edge in sorted(edges, key=lambda e: scene.order[e["from"]]):
        key = (edge["from"], edge["to"], edge["text"])
        if key in seen:
            continue
        seen.add(key)
        if edge["bidirectional"]:
            joint = " ⇄ "
        elif edge["text"]:
            joint = f" —{edge['text']}→ "
        else:
            joint = " → "
        lines.append(
            f"- {label(scene.nodes[edge['from']])}{joint}"
            f"{label(scene.nodes[edge['to']])}"
        )
    lines.append("")
    return lines


def render_mermaid(
    scene: Scene, group_of, group_label
) -> list[str]:
    if not scene.edges:
        return []
    lines = ["```mermaid", "flowchart TD"]
    ids: dict[str, str] = {}

    def mermaid_id(node_id: str) -> str:
        if node_id not in ids:
            ids[node_id] = f"n{len(ids)}"
        return ids[node_id]

    groups: dict[str | None, list[str]] = {}
    for node_id in sorted(scene.connected, key=lambda nid: scene.order[nid]):
        groups.setdefault(group_of(node_id), []).append(node_id)
    group_index = 0
    for group, members in groups.items():
        if group:
            group_index += 1
            lines.append(f'  subgraph g{group_index}["{group_label(group)}"]')
        for node_id in members:
            text = label(scene.nodes[node_id])[:40].replace('"', "'")
            lines.append(f'    {mermaid_id(node_id)}["{text}"]')
        if group:
            lines.append("  end")
    for edge in scene.edges:
        edge_label = f'|"{edge["text"][:20]}"|' if edge["text"] else ""
        arrow = "<-->" if edge["bidirectional"] else "-->"
        lines.append(
            f"  {mermaid_id(edge['from'])} {arrow}{edge_label} "
            f"{mermaid_id(edge['to'])}"
        )
    lines.append("```")
    lines.append("")
    return lines


def render_board(scene: Scene, title: str) -> list[str]:
    lines = [f"# {title}", ""]
    lines.append(
        "Generated from a FigJam board structure. It includes section hierarchy, "
        "shape text, connector relationships, and positioned notes."
    )
    lines.append("")

    def dump_section(section_id: str, depth: int) -> None:
        section = scene.nodes[section_id]
        lines.append(f"{'#' * min(depth + 1, 6)} {label(section)}")
        lines.append("")
        members = [
            nid for nid in scene.nodes if scene.section_of(nid) == section_id
        ]
        flow = [
            nid
            for nid in members
            if nid in scene.connected
            and scene.nodes[nid].get("type") in BOARD_FLOW_TYPES
        ]
        notes = [
            nid
            for nid in members
            if nid not in scene.connected
            and scene.nodes[nid].get("type") in NOTE_TYPES
        ]
        attached: dict[str, list[str]] = {}
        floating: list[str] = []
        for nid in notes:
            host = nearest_flow_node(scene, nid)
            if host:
                attached.setdefault(host, []).append(nid)
            else:
                floating.append(nid)
        if flow:
            lines.append("Flow elements:")
            for nid in scene.reading_order(flow):
                lines.append(f"- {label(scene.nodes[nid])}")
                for note in scene.reading_order(attached.get(nid, [])):
                    lines.extend(render_note(scene, note, "  "))
            lines.append("")
        if floating:
            lines.append("Supplements:")
            for nid in scene.reading_order(floating):
                lines.extend(render_note(scene, nid, ""))
            lines.append("")
        section_edges = [
            edge
            for edge in scene.edges
            if scene.section_of(edge["from"]) == section_id
        ]
        if section_edges:
            lines.extend(render_edges(scene, section_edges))
        for child_id in sorted(
            [
                nid
                for nid in scene.nodes
                if scene.nodes[nid].get("type") == "SECTION"
                and scene.section_of(nid) == section_id
            ],
            key=lambda nid: scene.order[nid],
        ):
            dump_section(child_id, depth + 1)

    root_id = str(scene.root.get("id", ""))
    if scene.root.get("type") == "SECTION":
        lines.append(f"## {label(scene.root)} (root)")
        lines.append("")
        top = [
            nid
            for nid in scene.nodes
            if scene.nodes[nid].get("type") == "SECTION"
            and scene.parents.get(nid) == root_id
        ]
    else:
        top = [
            nid
            for nid in scene.nodes
            if scene.nodes[nid].get("type") == "SECTION"
            and scene.section_of(nid) is None
            and nid != root_id
        ]
    for section_id in sorted(top, key=lambda nid: scene.order[nid]):
        dump_section(section_id, 2)

    mermaid = render_mermaid(
        scene,
        scene.section_of,
        lambda sec: label(scene.nodes[sec]),
    )
    if mermaid:
        lines.append("## Overall flow (Mermaid)")
        lines.append("")
        lines.extend(mermaid)
    return lines


def render_slides(scene: Scene, title: str) -> list[str]:
    lines = [f"# {title}", ""]
    lines.append(
        "Generated from a Figma Slides structure. Slides follow the document order "
        "in the slide grid, which matches presentation order."
    )
    lines.append("")
    slides = sorted(
        [
            nid
            for nid in scene.nodes
            if scene.nodes[nid].get("type") == "SLIDE"
        ],
        key=lambda nid: scene.order[nid],
    )
    for index, slide_id in enumerate(slides, 1):
        slide = scene.nodes[slide_id]
        heading = f"## {index}. {label(slide)}"
        if slide.get("skipped"):
            heading += " (skipped)"
        lines.append(heading)
        lines.append("")
        members = [
            nid for nid in scene.nodes if scene.slide_of(nid) == slide_id
        ]
        texts = [
            nid
            for nid in members
            if scene.nodes[nid].get("type") == "TEXT"
            and label(scene.nodes[nid])
        ]
        for nid in scene.reading_order(texts):
            text_node = scene.nodes[nid]
            text = label(text_node)
            url = (text_node.get("link") or {}).get("url")
            lines.append(f"- [{text}]({url})" if url else f"- {text}")
        others = [
            nid
            for nid in members
            if scene.nodes[nid].get("type") in NOTE_TYPES - {"TEXT"}
        ]
        for nid in scene.reading_order(others):
            lines.extend(render_note(scene, nid, ""))
        if texts or others:
            lines.append("")
    return lines


def render_design(scene: Scene, title: str) -> list[str]:
    lines = [f"# {title}", ""]
    lines.append(
        "Generated from a Design file structure. It includes SECTION and outermost "
        "FRAME hierarchy, text inside frames, and connector transitions."
    )
    lines.append("")

    def dump(node: dict[str, Any], depth: int, inside_frame: bool) -> None:
        node_type = str(node.get("type", ""))
        node_id = str(node.get("id", ""))
        is_container = node_type == "SECTION" or (
            node_type == "FRAME" and not inside_frame
        )
        if is_container:
            lines.append(f"{'#' * min(depth + 1, 6)} {label(node)}")
            lines.append("")
            if node_type == "FRAME":
                texts = [
                    nid
                    for nid in scene.nodes
                    if scene.frame_of(nid) == node_id
                    and scene.nodes[nid].get("type") == "TEXT"
                    and label(scene.nodes[nid])
                ]
                for nid in scene.reading_order(texts):
                    text_node = scene.nodes[nid]
                    text = label(text_node)
                    url = (text_node.get("link") or {}).get("url")
                    lines.append(f"- [{text}]({url})" if url else f"- {text}")
                if texts:
                    lines.append("")
        children = node.get("children", [])
        next_inside = inside_frame or node_type == "FRAME"
        if node_type in COMPONENT_BOUNDARY_TYPES:
            return
        if node_type == "FRAME" and inside_frame:
            next_depth = depth
        else:
            next_depth = depth + (1 if is_container else 0)
        if isinstance(children, list):
            for child in children:
                if isinstance(child, dict):
                    dump(child, next_depth, next_inside)

    dump(scene.root, 1, False)

    if scene.edges:
        frame_edges = []
        for edge in scene.edges:
            source = scene.frame_of(edge["from"]) or edge["from"]
            target = scene.frame_of(edge["to"]) or edge["to"]
            frame_edges.append({**edge, "from": source, "to": target})
        lines.append("## Transitions (connectors)")
        lines.append("")
        lines.extend(render_edges(scene, frame_edges))
        frame_scene_edges = scene.edges
        scene.edges = frame_edges
        scene.connected = {e["from"] for e in frame_edges} | {
            e["to"] for e in frame_edges
        }
        mermaid = render_mermaid(scene, lambda nid: None, lambda sec: "")
        scene.edges = frame_scene_edges
        if mermaid:
            lines.append("## Transition diagram (Mermaid)")
            lines.append("")
            lines.extend(mermaid)
    return lines


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--structure", help="get_node JSON; reads stdin when omitted")
    parser.add_argument(
        "--kind", choices=("auto", "design", "board", "slides"), default="auto"
    )
    parser.add_argument("--title", default="")
    parser.add_argument("--out", help="output Markdown path; writes stdout when omitted")
    args = parser.parse_args()

    if args.structure:
        data = json.loads(Path(args.structure).read_text(encoding="utf-8"))
    else:
        data = json.load(sys.stdin)
    scene = Scene(unwrap_node(data))
    kind = args.kind if args.kind != "auto" else detect_kind(scene)
    title = args.title or label(scene.root) or "Figma structure"
    if kind == "board":
        lines = render_board(scene, title)
    elif kind == "slides":
        lines = render_slides(scene, title)
    else:
        lines = render_design(scene, title)
    output = "\n".join(lines).rstrip() + "\n"
    if args.out:
        Path(args.out).write_text(output, encoding="utf-8")
        print(f"written {args.out} (kind={kind})", file=sys.stderr)
    else:
        sys.stdout.write(output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
