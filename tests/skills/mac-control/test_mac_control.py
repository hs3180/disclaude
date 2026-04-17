#!/usr/bin/env python3
"""
Unit tests for mac_control.py.

These tests validate the module's logic without actually performing
desktop automation (which would require macOS + Accessibility permissions).
Instead, they test:
- Argument parsing
- Coordinate conversion logic
- JSON response format
- Error handling paths

Run with: python3 -m pytest tests/skills/mac-control/test_mac_control.py -v
"""

import json
import os
import sys
import unittest
from unittest.mock import MagicMock, patch

# Add scripts directory to path so we can import the module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'skills', 'mac-control', 'scripts'))


class TestCoordinateConversion(unittest.TestCase):
    """Test the coordinate conversion logic (pixel → logical point)."""

    @patch('mac_control._get_scale_factor')
    def test_retina_conversion(self, mock_scale):
        """On a 2x Retina display, pixel coords should be halved."""
        mock_scale.return_value = 2.0
        from mac_control import _convert_coordinates
        lx, ly = _convert_coordinates(1000, 500)
        self.assertEqual(lx, 500.0)
        self.assertEqual(ly, 250.0)

    @patch('mac_control._get_scale_factor')
    def test_non_retina_conversion(self, mock_scale):
        """On a 1x display, coordinates should stay the same."""
        mock_scale.return_value = 1.0
        from mac_control import _convert_coordinates
        lx, ly = _convert_coordinates(1000, 500)
        self.assertEqual(lx, 1000.0)
        self.assertEqual(ly, 500.0)

    @patch('mac_control._get_scale_factor')
    def test_3x_conversion(self, mock_scale):
        """On a 3x display (e.g., some ProMotion), coordinates should be divided by 3."""
        mock_scale.return_value = 3.0
        from mac_control import _convert_coordinates
        lx, ly = _convert_coordinates(3000, 1500)
        self.assertAlmostEqual(lx, 1000.0)
        self.assertAlmostEqual(ly, 500.0)

    @patch('mac_control._get_scale_factor')
    def test_zero_coordinates(self, mock_scale):
        """Origin (0,0) should always map to (0,0)."""
        mock_scale.return_value = 2.0
        from mac_control import _convert_coordinates
        lx, ly = _convert_coordinates(0, 0)
        self.assertEqual(lx, 0.0)
        self.assertEqual(ly, 0.0)


class TestResponseFormat(unittest.TestCase):
    """Test the JSON response format."""

    def test_success_response(self):
        from mac_control import _success
        result = _success(x=100, y=200)
        self.assertTrue(result["success"])
        self.assertEqual(result["x"], 100)
        self.assertEqual(result["y"], 200)
        self.assertNotIn("error", result)

    def test_error_response(self):
        from mac_control import _error
        result = _error("something went wrong")
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "something went wrong")

    def test_error_no_extra_keys(self):
        from mac_control import _error
        result = _error("fail")
        self.assertIn("success", result)
        self.assertIn("error", result)
        self.assertEqual(len(result), 2)


class TestScreenshot(unittest.TestCase):
    """Test screenshot functionality with mocked subprocess."""

    @patch('mac_control.subprocess.run')
    @patch('mac_control.tempfile.mkstemp')
    def test_screenshot_default_path(self, mock_mkstemp, mock_run):
        mock_mkstemp.return_value = (99, "/tmp/test_screenshot.png")
        mock_run.return_value = MagicMock(returncode=0)

        from mac_control import screenshot
        # Need to mock os.close for the fd
        with patch('os.close'):
            result = screenshot()

        self.assertTrue(result["success"])
        self.assertIn("path", result)
        mock_run.assert_called_once()

    @patch('mac_control.subprocess.run')
    def test_screenshot_custom_path(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)

        from mac_control import screenshot
        result = screenshot(output_path="/tmp/custom.png")

        self.assertTrue(result["success"])
        self.assertEqual(result["path"], "/tmp/custom.png")

    @patch('mac_control.subprocess.run')
    def test_screenshot_with_region(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)

        from mac_control import screenshot
        result = screenshot(output_path="/tmp/region.png", region=(100, 200, 300, 400))

        self.assertTrue(result["success"])
        call_args = mock_run.call_args[0][0]
        self.assertIn("-R", call_args)
        self.assertIn("100,200,300,400", call_args)

    @patch('mac_control.subprocess.run')
    def test_screenshot_failure(self, mock_run):
        mock_run.side_effect = FileNotFoundError("screencapture not found")

        from mac_control import screenshot
        result = screenshot(output_path="/tmp/fail.png")

        self.assertFalse(result["success"])
        self.assertIn("not found", result["error"])


class TestClick(unittest.TestCase):
    """Test click functionality."""

    @patch('mac_control._post_event')
    @patch('mac_control._convert_coordinates')
    def test_left_click(self, mock_convert, mock_post):
        mock_convert.return_value = (500.0, 300.0)

        from mac_control import click
        result = click(1000, 600)

        self.assertTrue(result["success"])
        self.assertEqual(result["button"], "left")
        self.assertFalse(result["double"])

    @patch('mac_control._post_event')
    @patch('mac_control._convert_coordinates')
    def test_right_click(self, mock_convert, mock_post):
        mock_convert.return_value = (500.0, 300.0)

        from mac_control import click
        result = click(1000, 600, button="right")

        self.assertTrue(result["success"])
        self.assertEqual(result["button"], "right")

    @patch('mac_control._post_event')
    @patch('mac_control._convert_coordinates')
    def test_double_click(self, mock_convert, mock_post):
        mock_convert.return_value = (500.0, 300.0)

        from mac_control import click
        result = click(1000, 600, double=True)

        self.assertTrue(result["success"])
        self.assertTrue(result["double"])

    def test_invalid_button(self):
        from mac_control import click
        result = click(100, 200, button="middle")

        self.assertFalse(result["success"])
        self.assertIn("Unknown button", result["error"])


class TestTypeText(unittest.TestCase):
    """Test text input functionality."""

    def test_empty_text(self):
        from mac_control import type_text
        result = type_text("")
        self.assertFalse(result["success"])
        self.assertIn("Empty text", result["error"])

    @patch('mac_control._type_via_clipboard')
    def test_type_uses_clipboard_by_default(self, mock_clipboard):
        mock_clipboard.return_value = {"success": True, "method": "clipboard"}

        from mac_control import type_text
        result = type_text("Hello")

        mock_clipboard.assert_called_once_with("Hello", True)
        self.assertTrue(result["success"])

    @patch('mac_control._type_via_keystrokes')
    def test_type_can_use_keystrokes(self, mock_keystrokes):
        mock_keystrokes.return_value = {"success": True, "method": "keystroke"}

        from mac_control import type_text
        result = type_text("ASCII", use_clipboard=False)

        mock_keystrokes.assert_called_once_with("ASCII")


class TestPressKey(unittest.TestCase):
    """Test key press functionality."""

    @patch('mac_control._post_event')
    def test_press_return(self, mock_post):
        from mac_control import press_key
        result = press_key("return")
        self.assertTrue(result["success"])
        self.assertEqual(result["key"], "return")

    @patch('mac_control._post_event')
    def test_press_with_modifiers(self, mock_post):
        from mac_control import press_key
        result = press_key("v", modifiers=["cmd"])
        self.assertTrue(result["success"])
        self.assertIn("cmd", result["modifiers"])

    def test_unknown_key(self):
        from mac_control import press_key
        result = press_key("nonexistent_key")
        self.assertFalse(result["success"])
        self.assertIn("Unknown key", result["error"])


class TestCalibrate(unittest.TestCase):
    """Test calibration functionality."""

    @patch('mac_control.NSScreen')
    def test_calibrate_returns_scale_factor(self, mock_nsscreen):
        mock_main = MagicMock()
        mock_main.backingScaleFactor.return_value = 2.0
        mock_nsscreen.mainScreen.return_value = mock_main
        mock_nsscreen.screens.return_value = [mock_main]
        mock_main.frame.return_value = MagicMock(
            origin=MagicMock(x=0, y=0),
            size=MagicMock(width=1440, height=900),
        )
        mock_main.__eq__ = lambda self, other: True

        from mac_control import calibrate
        result = calibrate()

        self.assertTrue(result["success"])
        self.assertEqual(result["primary_scale_factor"], 2.0)
        self.assertIn("screens", result)


class TestWindowManagement(unittest.TestCase):
    """Test window management functionality."""

    @patch('mac_control.subprocess.run')
    def test_get_window_bounds(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=0,
            stdout="100.0, 200.0, 900.0, 800.0",
        )

        from mac_control import get_app_window
        result = get_app_window("Feishu")

        self.assertTrue(result["success"])
        self.assertEqual(result["bounds_points"]["x"], 100.0)
        self.assertEqual(result["bounds_points"]["width"], 800.0)

    @patch('mac_control.subprocess.run')
    def test_get_window_failure(self, mock_run):
        mock_run.return_value = MagicMock(
            returncode=1,
            stderr="Application not found",
        )

        from mac_control import get_app_window
        result = get_app_window("NonExistentApp")

        self.assertFalse(result["success"])
        self.assertIn("Failed", result["error"])

    @patch('mac_control.subprocess.run')
    def test_activate_app(self, mock_run):
        mock_run.return_value = MagicMock(returncode=0)

        from mac_control import activate_app
        result = activate_app("Safari")

        self.assertTrue(result["success"])
        self.assertTrue(result["activated"])


class TestCLI(unittest.TestCase):
    """Test CLI argument parsing and dispatch."""

    def test_cli_calibrate(self):
        """Test that calibrate command produces valid JSON output."""
        with patch('mac_control.calibrate') as mock_calibrate:
            mock_calibrate.return_value = {
                "success": True,
                "primary_scale_factor": 2.0,
                "screens": [],
            }
            with patch('sys.argv', ['mac_control.py', 'calibrate']):
                with patch('builtins.print') as mock_print:
                    from mac_control import main
                    main()
                    output = mock_print.call_args[0][0]
                    data = json.loads(output)
                    self.assertTrue(data["success"])


if __name__ == "__main__":
    unittest.main()
