import pathlib
import os
import shutil
import signal
import socket
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]


class CommonShellTest(unittest.TestCase):
    def test_common_settings_default_to_local_rest_profile(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts = pathlib.Path(directory) / "scripts"
            scripts.mkdir()
            shutil.copy2(ROOT / "scripts" / "common.sh", scripts / "common.sh")
            command = (
                f'source "{scripts / "common.sh"}"; '
                'printf "%s" "$FIGMA_VARIANT"'
            )
            result = subprocess.run(
                ["bash", "-c", command],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, "local")

    def test_common_settings_load_in_bash_and_zsh(self):
        with tempfile.TemporaryDirectory() as directory:
            scripts = pathlib.Path(directory) / "scripts"
            scripts.mkdir()
            shutil.copy2(ROOT / "scripts" / "common.sh", scripts / "common.sh")
            (scripts / "config.local.sh").write_text(
                "FIGMA_VARIANT=example-2\n"
                "FIGMA_TOKEN_KIND=pat\n"
                "FIGMA_TOKEN_KEYCHAIN_ITEM=figma_token_example_2_pat\n"
                "FIGMA_GATEWAY_PLUGIN_NAME='Custom Gateway'\n"
                "FIGMA_GATEWAY_PLUGIN_INSTANCE=example\n"
            )
            command = (
                f'source "{scripts / "common.sh"}"; '
                'printf "%s|%s|%s|%s|%s|%s" "$FIGMA_VARIANT" "$FIGMA_TOKEN_KIND" '
                '"$FIGMA_TOKEN_KEYCHAIN_ITEM" "$FIGMA_GATEWAY_PORT" '
                '"$FIGMA_GATEWAY_PLUGIN_NAME" "$FIGMA_GATEWAY_PLUGIN_INSTANCE"'
            )
            for shell in ("bash", "zsh"):
                with self.subTest(shell=shell):
                    result = subprocess.run(
                        [shell, "-c", command],
                        text=True,
                        capture_output=True,
                        check=False,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual(
                        result.stdout,
                        "example-2|pat|figma_token_example_2_pat|1995|Figma Gateway|shared",
                    )

    def test_export_uses_the_shared_gateway_port(self):
        script = (ROOT / "scripts" / "export.sh").read_text()
        self.assertIn('BRIDGE_PORT="${FIGMA_BRIDGE_PORT:-$FIGMA_GATEWAY_PORT}"', script)
        self.assertNotIn('BRIDGE_PORT="${BRIDGE_PORT_OVERRIDE:-$FIGMA_MAIN_BRIDGE_PORT}"', script)

    def test_export_uses_standard_figma_and_one_plugin_identity(self):
        script = (ROOT / "scripts" / "export.sh").read_text()
        self.assertIn('PLUGIN_MENU="$FIGMA_GATEWAY_PLUGIN_NAME"', script)
        self.assertIn('EXPECTED_INSTANCE="$FIGMA_GATEWAY_PLUGIN_INSTANCE"', script)
        self.assertIn('APP="$FIGMA_APP"', script)
        self.assertIn('BUNDLE="$FIGMA_APP_BUNDLE_ID"', script)
        self.assertIn('open -g -a "$APP" "$URL"', script)
        self.assertNotIn('APP_KIND=', script)
        self.assertNotIn('--app)', script)
        self.assertNotIn('open -g "${SCHEME}://file/', script)
        self.assertNotIn('EXPECTED_INSTANCE="${FIGMA_MAIN_GATEWAY_INSTANCE:-main}"', script)
        self.assertNotIn('EXPECTED_INSTANCE="$FIGMA_VARIANT"', script)

    def test_plugin_build_prefers_the_canonical_gateway_port(self):
        script = (ROOT / "scripts" / "build-plugin.mjs").read_text()
        expression = (
            "process.env.FIGMA_BRIDGE_PORT || process.env.FIGMA_GATEWAY_PORT ||\n"
            "    process.env.FIGMA_VARIANT_BRIDGE_PORT"
        )
        self.assertIn(expression, script)

    def test_new_session_baseline_is_captured_after_daemon_health(self):
        script = (ROOT / "scripts" / "start-plugin.sh").read_text()
        stable_health = 'health >/dev/null || { echo "ERROR: could not start the gateway daemon"'
        settle = 'for _ in $(seq 1 24); do sleep 0.25; done'
        baseline = 'INITIAL_SESSIONS="$(plugin_sessions || true)"'
        self.assertLess(script.index(stable_health), script.index(settle))
        self.assertLess(script.index(settle), script.index(baseline))
        self.assertIn('item.get("fileName") == target_file_name', script)

    def test_delayed_plugin_reconnect_is_in_baseline_after_new_daemon(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            scripts = root / "scripts"
            scripts.mkdir()
            shutil.copy2(ROOT / "scripts" / "common.sh", scripts / "common.sh")
            shutil.copy2(ROOT / "scripts" / "start-plugin.sh", scripts / "start-plugin.sh")
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]
            server = root / "delayed-server.mjs"
            pid_file = root / "server.pid"
            server.write_text(
                "import http from 'node:http';\n"
                "import fs from 'node:fs';\n"
                "fs.writeFileSync(process.env.TEST_PID_FILE, String(process.pid));\n"
                "const started = Date.now();\n"
                "http.createServer((_req, res) => {\n"
                "  const connected = Date.now() - started >= 5200;\n"
                "  res.writeHead(200, {'content-type':'application/json'});\n"
                "  res.end(JSON.stringify({ok:true,files:connected ? [{instance:'shared',fileKey:'old-session',fileName:'Target'}] : []}));\n"
                f"}}).listen({port}, '127.0.0.1');\n"
            )
            (scripts / "config.local.sh").write_text(
                "FIGMA_VARIANT=example\n"
                f"FIGMA_GATEWAY_PORT={port}\n"
                f"FIGMA_VARIANT_BRIDGE_PORT={port}\n"
                f"FIGMA_GATEWAY_SERVER={server}\n"
                "FIGMA_GATEWAY_SECRET=test-secret\n"
            )
            environment = {
                **os.environ,
                "TEST_PID_FILE": str(pid_file),
                "FIGMA_TARGET_FILE_NAME": "Target",
            }
            try:
                result = subprocess.run(
                    ["bash", str(scripts / "start-plugin.sh")],
                    text=True,
                    capture_output=True,
                    check=False,
                    timeout=15,
                    env=environment,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn("Plugin is already connected to the target file", result.stdout)
            finally:
                if pid_file.exists():
                    os.kill(int(pid_file.read_text()), signal.SIGTERM)


if __name__ == "__main__":
    unittest.main()
