from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "structure-export.py"


def load_script():
    spec = importlib.util.spec_from_file_location("structure_export", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load structure-export.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StructureExportTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.module = load_script()

    def test_collects_sections_and_frames_with_relationships(self) -> None:
        node = {
            "id": "1:1",
            "name": "Root",
            "type": "SECTION",
            "bounds": {"x": 100, "y": 200, "width": 800, "height": 600},
            "children": [
                {
                    "id": "1:2",
                    "name": "Frame A",
                    "type": "FRAME",
                    "bounds": {"x": 120, "y": 240, "width": 300, "height": 500},
                    "children": [
                        {
                            "id": "1:6",
                            "name": "Inner Layout Frame",
                            "type": "FRAME",
                        },
                        {
                            "id": "1:3",
                            "name": "Nested A",
                            "type": "SECTION",
                            "bounds": {
                                "x": 130,
                                "y": 250,
                                "width": 200,
                                "height": 100,
                            },
                        },
                    ],
                },
                {
                    "id": "1:4",
                    "name": "Wrapper",
                    "type": "GROUP",
                    "children": [
                        {
                            "id": "1:5",
                            "name": "Frame B",
                            "type": "FRAME",
                            "bounds": {
                                "x": 500,
                                "y": 240,
                                "width": 300,
                                "height": 500,
                            },
                        },
                    ],
                },
                {
                    "id": "1:7",
                    "name": "Component Instance",
                    "type": "INSTANCE",
                    "children": [
                        {
                            "id": "1:8",
                            "name": "Component Internal Frame",
                            "type": "FRAME",
                        }
                    ],
                },
            ],
        }

        plan = self.module.build_plan(
            node,
            "file-key",
            "PNG",
            1,
            2,
            "https://www.figma.com/design/file/name?node-id=1-1",
        )

        self.assertEqual(
            [item["id"] for item in plan["nodes"]],
            ["1:1", "1:2", "1:3", "1:5"],
        )
        nested_section = plan["nodes"][2]
        grouped_frame = plan["nodes"][3]
        self.assertEqual(nested_section["parentNode"]["id"], "1:2")
        self.assertEqual(nested_section["parentExportNode"]["id"], "1:2")
        self.assertEqual(grouped_frame["parentNode"]["id"], "1:4")
        self.assertEqual(grouped_frame["parentExportNode"]["id"], "1:1")
        self.assertEqual(
            [part["id"] for part in grouped_frame["scenePath"]],
            ["1:1", "1:4", "1:5"],
        )
        self.assertEqual(
            [part["id"] for part in grouped_frame["exportPath"]],
            ["1:1", "1:5"],
        )
        self.assertEqual(grouped_frame["relativeBounds"]["x"], 400)
        self.assertEqual(plan["root"]["childNodeIds"], ["1:2", "1:5"])
        self.assertEqual(grouped_frame["siblingNodeIds"], ["1:2", "1:5"])
        self.assertEqual(grouped_frame["siblingOrder"], 2)
        self.assertEqual(plan["frameCount"], 2)
        self.assertEqual(plan["sectionCount"], 2)
        self.assertNotIn("1:6", [item["id"] for item in plan["nodes"]])
        self.assertNotIn("1:8", [item["id"] for item in plan["nodes"]])
        self.assertIn("Nested layout", plan["conventions"]["frameSelection"])
        self.assertTrue(plan["conventions"]["rootIncludedInTypeCounts"])
        self.assertEqual(
            plan["conventions"]["siblingNodeIds"], "Includes the current node."
        )
        self.assertEqual(
            plan["source"]["url"],
            "https://www.figma.com/design/file/name?node-id=1-1",
        )
        self.assertEqual(plan["request"]["items"][0]["scale"], 1)
        self.assertEqual(plan["request"]["items"][1]["scale"], 2)
        self.assertEqual(
            plan["request"]["items"][1]["outputPath"],
            "frames/001_d1_Frame A@2x.png",
        )
        self.assertEqual(
            plan["request"]["items"][2]["outputPath"],
            "sections/002_d2_Nested A@2x.png",
        )
        self.assertEqual(
            [child["id"] for child in plan["tree"]["children"]],
            ["1:2", "1:5"],
        )
        self.assertEqual(plan["manifestVersion"], 3)
        self.assertEqual(plan["relationCount"], 0)

    def test_merges_large_page_shards_in_original_child_order(self) -> None:
        merged = self.module.merge_root_shards(
            {
                "id": "1:1",
                "name": "Page",
                "type": "PAGE",
                "children": [
                    {"id": "1:2", "name": "A", "type": "SECTION"},
                    {"id": "1:3", "name": "B", "type": "FRAME"},
                ],
            },
            [
                {"id": "1:3", "name": "B", "type": "FRAME", "children": []},
                {
                    "id": "1:2",
                    "name": "A",
                    "type": "SECTION",
                    "children": [{"id": "1:4", "name": "Screen", "type": "FRAME"}],
                },
            ],
        )

        self.assertEqual([child["id"] for child in merged["children"]], ["1:2", "1:3"])
        self.assertEqual(merged["children"][0]["children"][0]["id"], "1:4")

        with self.assertRaises(SystemExit):
            self.module.merge_root_shards(
                {"id": "1:1", "type": "PAGE", "children": [{"id": "1:2"}]},
                [{"id": "wrong", "type": "SECTION"}],
            )

    def test_structures_directed_connector_between_exported_frames(self) -> None:
        node = {
            "id": "1:1",
            "name": "Root",
            "type": "SECTION",
            "children": [
                {
                    "id": "1:2",
                    "name": "Frame A",
                    "type": "FRAME",
                    "children": [
                        {"id": "1:3", "name": "Button", "type": "RECTANGLE"}
                    ],
                },
                {
                    "id": "1:4",
                    "name": "Open detail",
                    "type": "CONNECTOR",
                    "bounds": {"x": 100, "y": 200, "width": 300, "height": 40},
                    "connector": {
                        "lineType": "ELBOWED",
                        "start": {"endpointNodeId": "1:3", "magnet": "RIGHT"},
                        "end": {"endpointNodeId": "1:5", "magnet": "LEFT"},
                        "startStrokeCap": "NONE",
                        "endStrokeCap": "ARROW_LINES",
                    },
                },
                {"id": "1:5", "name": "Frame B", "type": "FRAME"},
            ],
        }

        plan = self.module.build_plan(node, "file-key", "PNG", 1, 2)

        self.assertEqual(plan["relationCount"], 1)
        self.assertEqual(plan["resolvedRelationCount"], 1)
        self.assertEqual(plan["unresolvedRelationCount"], 0)
        relation = plan["relations"][0]
        self.assertEqual(relation["id"], "1:4")
        self.assertEqual(relation["label"], "Open detail")
        self.assertEqual(relation["lineType"], "ELBOWED")
        self.assertEqual(relation["direction"], "start_to_end")
        self.assertEqual(relation["start"]["connectorEndpoint"]["magnet"], "RIGHT")
        self.assertEqual(relation["start"]["frame"]["id"], "1:2")
        self.assertEqual(relation["end"]["frame"]["id"], "1:5")
        self.assertEqual(relation["fromNode"]["id"], "1:2")
        self.assertEqual(relation["toNode"]["id"], "1:5")
        self.assertEqual(relation["status"], "resolved")
        self.assertEqual(relation["resolutionIssues"], [])
        self.assertEqual(plan["unresolvedRelations"], [])

    def test_preserves_unresolved_position_only_connector(self) -> None:
        node = {
            "id": "1:1",
            "name": "Root",
            "type": "SECTION",
            "children": [
                {"id": "1:2", "name": "Frame A", "type": "FRAME"},
                {
                    "id": "1:3",
                    "name": "Floating note",
                    "type": "CONNECTOR",
                    "connector": {
                        "lineType": "STRAIGHT",
                        "start": {"position": {"x": 10, "y": 20}},
                        "end": {"position": {"x": 30, "y": 40}},
                        "startStrokeCap": "NONE",
                        "endStrokeCap": "NONE",
                    },
                },
            ],
        }

        plan = self.module.build_plan(node, "file-key", "PNG", 1, 2)

        self.assertEqual(plan["relationCount"], 1)
        self.assertEqual(plan["resolvedRelationCount"], 0)
        self.assertEqual(plan["unresolvedRelationCount"], 1)
        relation = plan["unresolvedRelations"][0]
        self.assertEqual(relation["direction"], "undirected")
        self.assertIsNone(relation["start"]["frame"])
        self.assertIsNone(relation["end"]["frame"])
        self.assertIsNone(relation["fromNode"])
        self.assertIsNone(relation["toNode"])
        self.assertEqual(
            relation["resolutionIssues"],
            [
                {"endpoint": "start", "reason": "endpointNodeId is missing"},
                {"endpoint": "end", "reason": "endpointNodeId is missing"},
            ],
        )

    def test_accepts_frame_root(self) -> None:
        plan = self.module.build_plan(
            {
                "id": "1:1",
                "name": "Root Frame",
                "type": "FRAME",
                "children": [
                    {"id": "1:2", "name": "Child Frame", "type": "FRAME"}
                ],
            },
            "file-key",
            "PNG",
            1,
            2,
        )

        self.assertEqual(plan["root"]["type"], "FRAME")
        self.assertEqual(plan["frameCount"], 1)
        self.assertEqual([node["id"] for node in plan["nodes"]], ["1:1"])

    def test_accepts_design_page_root_without_requesting_a_page_image(self) -> None:
        page = {
            "id": "834:29473",
            "name": "⭐️Design Review",
            "type": "PAGE",
            "bounds": {"x": 0, "y": 0, "width": 2000, "height": 1200},
            "children": [
                {
                    "id": "834:30000",
                    "name": "Review section",
                    "type": "SECTION",
                    "bounds": {"x": 100, "y": 200, "width": 900, "height": 800},
                    "children": [
                        {
                            "id": "834:30001",
                            "name": "Screen A",
                            "type": "FRAME",
                            "bounds": {"x": 140, "y": 260, "width": 390, "height": 844},
                            "children": [
                                {"id": "834:30002", "name": "Layout", "type": "FRAME"}
                            ],
                        },
                        {
                            "id": "834:30003",
                            "name": "Component",
                            "type": "COMPONENT",
                            "children": [
                                {"id": "834:30004", "name": "Internal", "type": "FRAME"}
                            ],
                        },
                    ],
                },
                {
                    "id": "834:30005",
                    "name": "Screen B",
                    "type": "FRAME",
                    "bounds": {"x": 1100, "y": 200, "width": 390, "height": 844},
                },
                {
                    "id": "834:30006",
                    "name": "Open B",
                    "type": "CONNECTOR",
                    "connector": {
                        "start": {"endpointNodeId": "834:30001"},
                        "end": {"endpointNodeId": "834:30005"},
                        "startStrokeCap": "NONE",
                        "endStrokeCap": "ARROW_LINES",
                    },
                },
            ],
        }

        plan = self.module.build_plan(page, "file-key", "PNG", 1, 2)

        self.assertEqual(
            [node["id"] for node in plan["nodes"]],
            ["834:29473", "834:30000", "834:30001", "834:30005"],
        )
        self.assertEqual(plan["root"]["type"], "PAGE")
        self.assertIsNone(plan["root"]["outputPath"])
        self.assertNotIn(
            "834:29473", [item["nodeId"] for item in plan["request"]["items"]]
        )
        self.assertEqual(plan["sectionCount"], 1)
        self.assertEqual(plan["frameCount"], 2)
        self.assertEqual(plan["root"]["childNodeIds"], ["834:30000", "834:30005"])
        self.assertEqual(plan["nodes"][1]["parentNode"]["id"], "834:29473")
        self.assertEqual(plan["nodes"][2]["parentExportNode"]["id"], "834:30000")
        self.assertEqual(plan["nodes"][2]["relativeBounds"]["x"], 40)
        self.assertEqual(plan["nodes"][3]["siblingOrder"], 2)
        self.assertEqual(
            [part["id"] for part in plan["nodes"][2]["scenePath"]],
            ["834:29473", "834:30000", "834:30001"],
        )
        self.assertEqual(
            [part["id"] for part in plan["nodes"][2]["exportPath"]],
            ["834:29473", "834:30000", "834:30001"],
        )
        self.assertEqual(plan["relations"][0]["status"], "resolved")

        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            results = []
            for item in plan["request"]["items"]:
                output_path = output_dir / item["outputPath"]
                output_path.parent.mkdir(parents=True, exist_ok=True)
                output_path.write_bytes(b"image")
                results.append(
                    {
                        "nodeId": item["nodeId"],
                        "outputPath": str(output_path),
                        "success": True,
                    }
                )
            manifest = self.module.verify_export(
                plan,
                {"succeeded": len(results), "failed": 0, "results": results},
                output_dir,
            )

        self.assertIsNone(manifest["root"]["export"])
        self.assertEqual(len(manifest["results"]), 3)
        self.assertTrue(all(item["bytesWritten"] == 5 for item in manifest["results"]))
        self.assertEqual(manifest["typeCounts"], {"PAGE": 1, "SECTION": 1, "FRAME": 2})

        capped = self.module.build_plan(
            page, "file-key", "PNG", 1, 2, max_overview_pixels=1_000_000
        )
        section_request = next(
            item for item in capped["request"]["items"] if item["nodeId"] == "834:30000"
        )
        frame_request = next(
            item for item in capped["request"]["items"] if item["nodeId"] == "834:30001"
        )
        self.assertLess(section_request["scale"], 2)
        self.assertEqual(frame_request["scale"], 2)

    def test_exports_outermost_frames_but_omits_their_internal_frames(self) -> None:
        plan = self.module.build_plan(
            {
                "id": "10:1",
                "name": "Root Section",
                "type": "SECTION",
                "children": [
                    {
                        "id": "10:2",
                        "name": "Nested Section",
                        "type": "SECTION",
                        "children": [
                            {
                                "id": "10:3",
                                "name": "Outermost Frame",
                                "type": "FRAME",
                                "bounds": {
                                    "x": 100,
                                    "y": 200,
                                    "width": 390,
                                    "height": 844,
                                },
                                "children": [
                                    {
                                        "id": "10:4",
                                        "name": "Layout Frame",
                                        "type": "FRAME",
                                    },
                                    {
                                        "id": "10:5",
                                        "name": "Control",
                                        "type": "INSTANCE",
                                        "children": [
                                            {
                                                "id": "10:6",
                                                "name": "Control Internal Frame",
                                                "type": "FRAME",
                                            }
                                        ],
                                    },
                                ],
                            }
                        ],
                    }
                ],
            },
            "file-key",
            "PNG",
            1,
            2,
        )

        self.assertEqual(
            [node["id"] for node in plan["nodes"]], ["10:1", "10:2", "10:3"]
        )
        self.assertEqual(plan["frameCount"], 1)
        self.assertEqual(plan["frames"][0]["name"], "Outermost Frame")
        self.assertEqual(plan["frames"][0]["frameDepth"], 1)

    def test_accepts_group_root_and_exports_descendant_frames(self) -> None:
        plan = self.module.build_plan(
            {
                "id": "1:1",
                "name": "Root Group",
                "type": "GROUP",
                "children": [
                    {"id": "1:2", "name": "Child Frame", "type": "FRAME"}
                ],
            },
            "file-key",
            "PNG",
            1,
            2,
        )

        self.assertEqual(plan["root"]["type"], "GROUP")
        self.assertEqual(plan["nodeCount"], 2)
        self.assertEqual(plan["frameCount"], 1)
        self.assertEqual(plan["nodes"][1]["parentExportNode"]["id"], "1:1")

    def test_rejects_non_container_root(self) -> None:
        with self.assertRaises(SystemExit):
            self.module.build_plan(
                {"id": "1:1", "name": "Rectangle", "type": "RECTANGLE"},
                "file-key",
                "PNG",
                1,
                2,
            )

    def test_selects_only_exact_file_name(self) -> None:
        selected = self.module.select_file(
            {
                "files": [
                    {"instance": "shared", "fileKey": "icon", "fileName": "Icon Master"},
                    {"instance": "shared", "fileKey": "mit", "fileName": "MIT Screen Design"},
                ]
            },
            "MIT Screen Design",
        )

        self.assertEqual(
            selected,
            {"instance": "shared", "fileKey": "mit", "fileName": "MIT Screen Design"},
        )

    def test_selects_new_session_by_instance_when_file_names_match(self) -> None:
        selected = self.module.select_file(
            {
                "files": [
                    {"instance": "shared", "fileKey": "shared-old", "fileName": "Shared Name"},
                    {"instance": "shared", "fileKey": "shared-new", "fileName": "Shared Name"},
                ]
            },
            "Shared Name",
            "shared",
            {"shared-old"},
        )

        self.assertEqual(selected["fileKey"], "shared-new")
        self.assertEqual(selected["instance"], "shared")

    def test_rejects_missing_file_name_match(self) -> None:
        with self.assertRaises(SystemExit):
            self.module.select_file(
                {"files": [{"fileKey": "icon", "fileName": "Icon Master"}]},
                "MIT Screen Design",
            )

    def test_verifies_every_file_and_builds_manifest(self) -> None:
        node = {
            "id": "1:1",
            "name": "Root",
            "type": "SECTION",
            "children": [
                {"id": "1:2", "name": "Child Section", "type": "SECTION"},
                {"id": "1:3", "name": "Child Frame", "type": "FRAME"},
            ],
        }
        plan = self.module.build_plan(node, "file-key", "PNG", 1, 2)
        with tempfile.TemporaryDirectory() as temporary:
            output_dir = Path(temporary)
            results = []
            for item in plan["request"]["items"]:
                path = output_dir / item["outputPath"]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"image")
                results.append(
                    {
                        "nodeId": item["nodeId"],
                        "outputPath": str(path),
                        "success": True,
                        "width": 10,
                        "height": 20,
                    }
                )

            manifest = self.module.verify_export(
                plan,
                {"succeeded": 3, "failed": 0, "results": results},
                output_dir,
            )

        self.assertEqual(manifest["sectionCount"], 2)
        self.assertEqual(manifest["frameCount"], 1)
        self.assertEqual(manifest["nodeCount"], 3)
        self.assertEqual(manifest["manifestVersion"], 3)
        self.assertEqual(len(manifest["results"]), 3)
        self.assertEqual(manifest["relationCount"], 0)
        self.assertEqual(
            manifest["conventions"]["siblingOrder"],
            "One-based within siblingNodeIds.",
        )
        self.assertEqual(manifest["nodes"][1]["export"]["bytesWritten"], 5)
        self.assertEqual(
            [child["type"] for child in manifest["tree"]["children"]],
            ["SECTION", "FRAME"],
        )


if __name__ == "__main__":
    unittest.main()
