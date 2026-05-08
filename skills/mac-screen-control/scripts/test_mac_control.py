#!/usr/bin/env python3
"""
Tests for mac-control.py

These tests verify argument parsing, JSON output format, and error handling.
CGEvent-dependent tests are skipped on non-macOS platforms.

Run with: python3 -m pytest skills/mac-screen-control/scripts/test_mac_control.py -v
          or: python3 skills/mac-screen-control/scripts/test_mac_control.py
"""

import json
import os
import platform
import subprocess
import sys
import tempfile
import unittest

# Path to the script under test
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT_PATH = os.path.join(SCRIPT_DIR, "mac-control.py")

IS_MACOS = platform.system() == "Darwin"


def run_script(*args: str, timeout: int = 10) -> subprocess.CompletedProcess:
    """Run mac-control.py with given arguments and return the result."""
    cmd = [sys.executable, SCRIPT_PATH] + list(args)
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


class TestArgumentParsing(unittest.TestCase):
    """Test that argument parsing works correctly."""

    def test_no_command_shows_help(self):
        """Running without a command should show help and exit."""
        result = run_script()
        self.assertNotEqual(result.returncode, 0)

    def test_invalid_command(self):
        """Invalid command should show error."""
        result = run_script("nonexistent-command")
        self.assertNotEqual(result.returncode, 0)

    def test_help_flag(self):
        """--help should show usage and exit 0."""
        result = run_script("--help")
        self.assertEqual(result.returncode, 0)
        self.assertIn("macOS screen/keyboard/mouse control", result.stdout)


class TestJSONOutput(unittest.TestCase):
    """Test that output is always valid JSON."""

    def _parse_json(self, result: subprocess.CompletedProcess) -> dict:
        """Parse JSON from script stdout, failing on parse errors."""
        self.assertTrue(result.stdout.strip(), f"No stdout. stderr: {result.stderr}")
        try:
            return json.loads(result.stdout.strip())
        except json.JSONDecodeError:
            self.fail(f"Invalid JSON output: {result.stdout.strip()}")

    @unittest.skipUnless(IS_MACOS, "macOS only")
    def test_check_permissions_output_format(self):
        """check-permissions should return valid JSON with 'ok' field."""
        result = run_script("check-permissions")
        data = self._parse_json(result)
        self.assertIn("ok", data)
        self.assertIsInstance(data["ok"], bool)

    @unittest.skipUnless(IS_MACOS, "macOS only")
    def test_calibrate_output_format(self):
        """calibrate should return valid JSON with scale factor data."""
        result = run_script("calibrate")
        data = self._parse_json(result)
        self.assertIn("ok", data)
        if data["ok"]:
            self.assertIn("data", data)
            self.assertIn("scale_factor", data["data"])
            self.assertIn("is_retina", data["data"])
            self.assertIn("logical_size", data["data"])
            self.assertIn("pixel_size", data["data"])

    @unittest.skipUnless(IS_MACOS, "macOS only")
    def test_window_info_output_format(self):
        """window-info should return valid JSON with window bounds."""
        result = run_script("window-info")
        data = self._parse_json(result)
        self.assertIn("ok", data)
        if data["ok"]:
            d = data["data"]
            self.assertIn("x", d)
            self.assertIn("y", d)
            self.assertIn("width", d)
            self.assertIn("height", d)


class TestScreenshotCommand(unittest.TestCase):
    """Test screenshot command."""

    @unittest.skipUnless(IS_MACOS, "macOS only")
    def test_screenshot_default_output(self):
        """Screenshot with default output should create a file."""
        result = run_script("screenshot")
        data = json.loads(result.stdout.strip())
        self.assertTrue(data["ok"], f"Screenshot failed: {data.get('error', '')}")
        self.assertIn("data", data)
        path = data["data"]["path"]
        self.assertTrue(os.path.exists(path), f"Screenshot file not found: {path}")
        # Cleanup
        try:
            os.unlink(path)
        except OSError:
            pass

    @unittest.skipUnless(IS_MACOS, "macOS only")
    def test_screenshot_custom_output(self):
        """Screenshot with custom output path."""
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            output_path = f.name
        try:
            result = run_script("screenshot", "--output", output_path)
            data = json.loads(result.stdout.strip())
            self.assertTrue(data["ok"], f"Screenshot failed: {data.get('error', '')}")
            self.assertEqual(data["data"]["path"], output_path)
            self.assertTrue(os.path.exists(output_path))
            # Verify it's a valid PNG (starts with PNG magic bytes)
            with open(output_path, "rb") as f:
                header = f.read(8)
            self.assertEqual(header[:4], b"\x89PNG")
        finally:
            try:
                os.unlink(output_path)
            except OSError:
                pass

    def test_screenshot_invalid_region(self):
        """Invalid region format should return error."""
        result = run_script("screenshot", "--region", "invalid")
        if IS_MACOS:
            data = json.loads(result.stdout.strip())
            self.assertFalse(data["ok"])
        # On non-macOS, it will fail with platform error first


class TestNonMacOSBehavior(unittest.TestCase):
    """Test behavior on non-macOS platforms."""

    @unittest.skipIf(IS_MACOS, "Non-macOS only")
    def test_commands_fail_gracefully_on_linux(self):
        """All CGEvent commands should fail with clear error on non-macOS."""
        commands = [
            ["click", "100", "200"],
            ["move", "100", "200"],
            ["type", "hello"],
            ["key", "return"],
            ["window-info"],
            ["activate-app", "Finder"],
            ["calibrate"],
            ["check-permissions"],
        ]
        for cmd in commands:
            result = run_script(*cmd)
            data = json.loads(result.stdout.strip())
            self.assertFalse(data["ok"], f"Command {cmd} should fail on non-macOS")
            self.assertIn("macOS required", data["error"])


class TestKeycodeMap(unittest.TestCase):
    """Test that the keycode map is comprehensive."""

    def test_common_keys_present(self):
        """Verify common keys are in the keycode map."""
        # Import the map from the script
        import importlib.util

        spec = importlib.util.spec_from_file_location("mac_control", SCRIPT_PATH)
        # We can't directly import since it may fail on non-macOS
        # Instead, verify the key categories exist in the source
        with open(SCRIPT_PATH) as f:
            source = f.read()

        required_keys = [
            "return", "tab", "space", "escape", "delete",
            "cmd", "shift", "ctrl", "alt", "option",
            "up", "down", "left", "right",
            "a", "z", "0", "9",
            "f1", "f12",
        ]
        for key in required_keys:
            self.assertIn(f'"{key}"', source, f"Key '{key}' not found in keycode map")


if __name__ == "__main__":
    unittest.main()
