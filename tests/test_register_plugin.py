import json
import os
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class RegisterPluginTest(unittest.TestCase):
    def test_reports_supported_manual_import_without_modifying_figma_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            plugin = root / "plugin"
            plugin.mkdir()
            (plugin / "code.js").write_text("", encoding="utf-8")
            (plugin / "ui.html").write_text("", encoding="utf-8")
            manifest = plugin / "manifest.json"
            manifest.write_text(json.dumps({
                "name": "Figma Gateway",
                "id": "figma-gateway-shared-design",
                "main": "code.js",
                "ui": "ui.html",
            }), encoding="utf-8")

            result = subprocess.run(
                ["python3", str(ROOT / "scripts/register-plugin.py"), str(manifest), "--json"],
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {
                "ok": True,
                "name": "Figma Gateway",
                "id": "figma-gateway-shared-design",
                "manifest": str(manifest.resolve()),
                "manualImportRequired": True,
            })

    def test_rejects_a_manifest_with_missing_build_output(self):
        with tempfile.TemporaryDirectory() as directory:
            manifest = pathlib.Path(directory) / "manifest.json"
            manifest.write_text(json.dumps({
                "name": "Figma Gateway",
                "id": "figma-gateway-shared-design",
                "main": "missing.js",
            }), encoding="utf-8")
            result = subprocess.run(
                ["python3", str(ROOT / "scripts/register-plugin.py"), str(manifest)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Plugin build output is missing", result.stderr)

    def test_default_registration_reports_standard_and_dev_manifests(self):
        with tempfile.TemporaryDirectory() as directory:
            plugin = pathlib.Path(directory) / "plugin"
            plugin.mkdir()
            (plugin / "code.js").write_text("", encoding="utf-8")
            (plugin / "ui.html").write_text("", encoding="utf-8")
            dev_plugin = plugin / "dev"
            dev_plugin.mkdir()
            (dev_plugin / "code.js").write_text("", encoding="utf-8")
            (dev_plugin / "ui.html").write_text("", encoding="utf-8")
            for manifest_path, name, plugin_id in (
                (plugin / "manifest.json", "Figma Gateway", "figma-gateway-shared-design"),
                (dev_plugin / "manifest.json", "Figma Gateway", "figma-gateway-shared-dev"),
            ):
                manifest_path.write_text(json.dumps({
                    "name": name,
                    "id": plugin_id,
                    "main": "code.js",
                    "ui": "ui.html",
                }), encoding="utf-8")
            result = subprocess.run(
                ["python3", str(ROOT / "scripts" / "register-plugin.py"), "--json"],
                text=True,
                capture_output=True,
                check=False,
                env={**os.environ, "FIGMA_GATEWAY_PLUGIN_DIR": str(plugin)},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual([item["id"] for item in payload["manifests"]], [
                "figma-gateway-shared-design",
                "figma-gateway-shared-dev",
            ])


if __name__ == "__main__":
    unittest.main()
