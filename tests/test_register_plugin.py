import json
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


if __name__ == "__main__":
    unittest.main()
