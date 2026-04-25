#!/usr/bin/env python3
"""
mac_control.py — Zero-dependency macOS screen/keyboard/mouse control.

Uses only Python stdlib (ctypes, subprocess) to call CoreGraphics CGEvent
for mouse/keyboard, screencapture for screenshots, and osascript for window
management.  No third-party packages are required.

Requirements:
  - macOS 10.9+
  - Python 3.8+
  - Terminal.app (or the calling process) must be granted Accessibility
    permission in System Settings → Privacy & Security → Accessibility.

Usage:
  python3 mac_control.py screenshot [--region x,y,w,h] [--cursor] [--output path]
  python3 mac_control.py click --x X --y Y [--button left|right] [--count 1|2]
  python3 mac_control.py move --x X --y Y
  python3 mac_control.py drag --from-x X1 --from-y Y1 --to-x X2 --to-y Y2
  python3 mac_control.py type --text "Hello 世界"
  python3 mac_control.py key --key "return" [--modifiers cmd]
  python3 mac_control.py window --app "Safari"
  python3 mac_control.py activate --app "Safari"
  python3 mac_control.py calibrate

All coordinates are in **logical points** (Quartz coordinate space).
For Retina displays, the script automatically handles the pixel<->point conversion.
"""

from __future__ import annotations

import argparse
import ctypes
import ctypes.util
import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from typing import Optional

# ---------------------------------------------------------------------------
# Guard: only runs on macOS
# ---------------------------------------------------------------------------


def _ensure_macos() -> None:
    if platform.system() != "Darwin":
        print(json.dumps({"success": False, "error": "This tool only works on macOS"}))
        sys.exit(1)


# ---------------------------------------------------------------------------
# CoreGraphics CGEvent helpers (via ctypes)
# ---------------------------------------------------------------------------

# Load frameworks
_cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))

# CGPoint struct: two doubles
class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


# Constants
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventLeftMouseDragged = 6
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventRightMouseDragged = 7
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagMaskCommand = 1 << 20   # 0x100000
kCGEventFlagMaskShift = 1 << 17     # 0x020000
kCGEventFlagMaskControl = 1 << 18   # 0x040000
kCGEventFlagMaskAlternate = 1 << 19  # 0x080000
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGHIDEventTap = 0

# kCGEventSourceStateHIDSystemState = 1
_kCGEventSourceStateHIDSystemState = 1

# Field tags (from CGEventTypes.h)
_kCGMouseEventClickState = 1
_kCGKeyboardEventKeycode = 37


def _create_event_source() -> ctypes.c_void_p:
    """Create a CGEventSource using the HID system state."""
    return _cg.CGEventSourceCreate(_kCGEventSourceStateHIDSystemState)


def _create_mouse_event(
    event_type: int, point: CGPoint, button: int
) -> ctypes.c_void_p:
    """Create a CGEvent for mouse operations."""
    source = _create_event_source()
    event = _cg.CGEventCreateMouseEvent(source, event_type, point, button)
    return event


def _create_keyboard_event(
    keycode: int, key_down: bool
) -> ctypes.c_void_p:
    """Create a CGEvent for keyboard operations."""
    source = _create_event_source()
    event = _cg.CGEventCreateKeyboardEvent(source, keycode, 1 if key_down else 0)
    return event


def _post_event(event: ctypes.c_void_p) -> None:
    """Post a CGEvent to the HID event tap."""
    _cg.CGEventPost(kCGHIDEventTap, event)


def _set_click_count(event: ctypes.c_void_p, count: int) -> None:
    """Set the click count on a mouse event."""
    _cg.CGEventSetIntegerValueField(event, _kCGMouseEventClickState, count)


def _set_event_flags(event: ctypes.c_void_p, flags: int) -> None:
    """Set modifier flags on an event."""
    _cg.CGEventSetFlags(event, flags)


# Virtual key codes
_MODIFIER_FLAGS: dict[str, int] = {
    "cmd": kCGEventFlagMaskCommand,
    "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "ctrl": kCGEventFlagMaskControl,
    "control": kCGEventFlagMaskControl,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
}

_KEY_CODES: dict[str, int] = {
    "return": 36,
    "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51,
    "backspace": 51,
    "escape": 53,
    "esc": 53,
    "up": 126,
    "down": 125,
    "left": 123,
    "right": 124,
    "home": 115,
    "end": 119,
    "pageup": 116,
    "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
    "a": 0, "b": 11, "c": 8, "d": 2, "e": 14, "f": 3, "g": 5,
    "h": 4, "i": 34, "j": 38, "k": 40, "l": 37, "m": 46, "n": 45,
    "o": 31, "p": 35, "q": 12, "r": 15, "s": 1, "t": 17, "u": 32,
    "v": 9, "w": 13, "x": 7, "y": 16, "z": 6,
    "0": 29, "1": 18, "2": 19, "3": 20, "4": 21, "5": 23,
    "6": 22, "7": 26, "8": 28, "9": 25,
}


# ---------------------------------------------------------------------------
# Coordinate helpers
# ---------------------------------------------------------------------------


def _get_retina_scale() -> float:
    """Return the main screen's backing scale factor (1.0 for non-Retina)."""
    try:
        result = subprocess.run(
            [
                "osascript", "-e",
                'tell application "System Events" to tell appearance preferences '
                "to return (scaling factor of main screen as text)",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    # Default assumption for modern Macs
    return 2.0


@dataclass
class WindowInfo:
    app_name: str
    window_name: str
    bounds: dict   # {x, y, width, height} in logical points
    position: dict  # {x, y} top-left corner
    size: dict      # {width, height}


def _get_window_bounds(app_name: str) -> Optional[WindowInfo]:
    """Get the frontmost window bounds of an application via osascript."""
    script = f'''
    tell application "System Events"
        tell process "{app_name}"
            set frontWin to front window
            set pos to position of frontWin
            set sz to size of frontWin
            return (item 1 of pos as text) & "," & (item 2 of pos as text) & "," & (item 1 of sz as text) & "," & (item 2 of sz as text)
        end tell
    end tell
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return None
        parts = result.stdout.strip().split(",")
        return WindowInfo(
            app_name=app_name,
            window_name="",
            bounds={
                "x": float(parts[0]),
                "y": float(parts[1]),
                "width": float(parts[2]),
                "height": float(parts[3]),
            },
            position={"x": float(parts[0]), "y": float(parts[1])},
            size={"width": float(parts[2]), "height": float(parts[3])},
        )
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Mouse operations
# ---------------------------------------------------------------------------


def click(
    x: float,
    y: float,
    button: str = "left",
    count: int = 1,
) -> dict:
    """Click at logical coordinates (x, y)."""
    btn_map = {"left": kCGMouseButtonLeft, "right": kCGMouseButtonRight}
    btn = btn_map.get(button, kCGMouseButtonLeft)
    point = CGPoint(x, y)

    if button == "right":
        down_type, up_type = kCGEventRightMouseDown, kCGEventRightMouseUp
    else:
        down_type, up_type = kCGEventLeftMouseDown, kCGEventLeftMouseUp

    for i in range(count):
        # Mouse down
        event = _create_mouse_event(down_type, point, btn)
        _set_click_count(event, count)
        _post_event(event)
        # Mouse up
        event = _create_mouse_event(up_type, point, btn)
        _set_click_count(event, count)
        _post_event(event)
        if count > 1:
            time.sleep(0.05)

    return {"success": True, "action": "click", "x": x, "y": y, "button": button, "count": count}


def move(x: float, y: float) -> dict:
    """Move mouse to logical coordinates (x, y)."""
    point = CGPoint(x, y)
    event = _create_mouse_event(kCGEventMouseMoved, point, kCGMouseButtonLeft)
    _post_event(event)
    return {"success": True, "action": "move", "x": x, "y": y}


def drag(
    from_x: float, from_y: float, to_x: float, to_y: float, button: str = "left"
) -> dict:
    """Drag from one point to another with smooth interpolation."""
    btn_map = {"left": kCGMouseButtonLeft, "right": kCGMouseButtonRight}
    btn = btn_map.get(button, kCGMouseButtonLeft)

    if button == "right":
        down_type = kCGEventRightMouseDown
        drag_type = kCGEventRightMouseDragged
        up_type = kCGEventRightMouseUp
    else:
        down_type = kCGEventLeftMouseDown
        drag_type = kCGEventLeftMouseDragged
        up_type = kCGEventLeftMouseUp

    # Mouse down at start
    start_point = CGPoint(from_x, from_y)
    event = _create_mouse_event(down_type, start_point, btn)
    _post_event(event)

    # Smooth drag: interpolate in steps
    steps = max(int(max(abs(to_x - from_x), abs(to_y - from_y)) / 5), 1)
    for i in range(1, steps + 1):
        t = i / steps
        cx = from_x + (to_x - from_x) * t
        cy = from_y + (to_y - from_y) * t
        point = CGPoint(cx, cy)
        event = _create_mouse_event(drag_type, point, btn)
        _post_event(event)
        time.sleep(0.002)

    # Mouse up at end
    end_point = CGPoint(to_x, to_y)
    event = _create_mouse_event(up_type, end_point, btn)
    _post_event(event)

    return {
        "success": True,
        "action": "drag",
        "from": {"x": from_x, "y": from_y},
        "to": {"x": to_x, "y": to_y},
    }


# ---------------------------------------------------------------------------
# Keyboard operations
# ---------------------------------------------------------------------------


def type_text(text: str) -> dict:
    """Type text using the clipboard-paste method (pbcopy + Cmd+V).

    This approach is recommended for CJK/emoji input because it bypasses
    the IME interception problem entirely.

    The original clipboard contents are saved and restored after pasting.
    """
    # Save current clipboard
    try:
        original_clipboard = subprocess.run(
            ["pbpaste"], capture_output=True, timeout=5,
        ).stdout
    except Exception:
        original_clipboard = b""

    # Set clipboard to desired text
    try:
        proc = subprocess.run(
            ["pbcopy"], input=text.encode("utf-8"), timeout=5,
        )
        if proc.returncode != 0:
            return {"success": False, "error": "pbcopy failed"}
    except Exception as e:
        return {"success": False, "error": str(e)}

    time.sleep(0.05)

    # Simulate Cmd+V (paste)
    _press_key_with_modifiers(_KEY_CODES["v"], kCGEventFlagMaskCommand)

    time.sleep(0.05)

    # Restore original clipboard
    try:
        subprocess.run(
            ["pbcopy"], input=original_clipboard, timeout=5,
        )
    except Exception:
        pass

    return {
        "success": True,
        "action": "type",
        "text": text,
        "method": "clipboard-paste",
        "length": len(text),
    }


def key_press(key: str, modifiers: Optional[list[str]] = None) -> dict:
    """Press a single key, optionally with modifiers.

    Args:
        key: Key name (e.g. 'return', 'tab', 'a', 'f5')
        modifiers: List of modifier names (e.g. ['cmd', 'shift'])
    """
    modifiers = modifiers or []
    key_lower = key.lower()

    if key_lower not in _KEY_CODES:
        return {"success": False, "error": f"Unknown key: {key}"}

    keycode = _KEY_CODES[key_lower]
    flags = 0
    for mod in modifiers:
        mod_lower = mod.lower()
        if mod_lower in _MODIFIER_FLAGS:
            flags |= _MODIFIER_FLAGS[mod_lower]

    _press_key_with_modifiers(keycode, flags)

    return {
        "success": True,
        "action": "key",
        "key": key_lower,
        "modifiers": modifiers,
    }


def _press_key_with_modifiers(keycode: int, flags: int) -> None:
    """Press a key with modifier flags, then release."""
    # Key down
    event = _create_keyboard_event(keycode, key_down=True)
    _set_event_flags(event, flags)
    _post_event(event)
    time.sleep(0.01)

    # Key up
    event = _create_keyboard_event(keycode, key_down=False)
    _set_event_flags(event, flags)
    _post_event(event)
    time.sleep(0.01)


# ---------------------------------------------------------------------------
# Screenshot
# ---------------------------------------------------------------------------


def screenshot(
    region: Optional[tuple[int, int, int, int]] = None,
    cursor: bool = False,
    output: Optional[str] = None,
) -> dict:
    """Take a screenshot and return the file path.

    Args:
        region: Optional (x, y, width, height) in logical points.
        cursor: Whether to include the cursor.
        output: Optional output file path. Defaults to a temp file.

    Returns:
        dict with 'success', 'path', and optionally 'region'.
    """
    if output is None:
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        output = tmp.name
        tmp.close()

    cmd = ["screencapture"]
    if not cursor:
        cmd.append("-C")  # No cursor
    if region:
        x, y, w, h = region
        # screencapture -R expects pixel coordinates
        scale = _get_retina_scale()
        px = int(x * scale)
        py = int(y * scale)
        pw = int(w * scale)
        ph = int(h * scale)
        cmd.extend(["-R", f"{px},{py},{pw},{ph}"])
    cmd.append(output)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode != 0:
            return {"success": False, "error": result.stderr.strip() or "screencapture failed"}
        if not os.path.exists(output):
            return {"success": False, "error": "Screenshot file was not created"}
        return {
            "success": True,
            "action": "screenshot",
            "path": output,
            "region": (
                {"x": region[0], "y": region[1], "width": region[2], "height": region[3]}
                if region
                else None
            ),
        }
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Window management
# ---------------------------------------------------------------------------


def get_window(app_name: str) -> dict:
    """Get the frontmost window info of an application."""
    win = _get_window_bounds(app_name)
    if win is None:
        return {
            "success": False,
            "error": (
                f"Could not get window for '{app_name}'. "
                "Ensure the app is running and Accessibility permission is granted."
            ),
        }
    return {
        "success": True,
        "action": "window",
        "app": win.app_name,
        "bounds": win.bounds,
        "position": win.position,
        "size": win.size,
    }


def activate_app(app_name: str) -> dict:
    """Bring an application to the foreground."""
    script = f'tell application "{app_name}" to activate'
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return {"success": False, "error": result.stderr.strip()}
        return {"success": True, "action": "activate", "app": app_name}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ---------------------------------------------------------------------------
# Calibration
# ---------------------------------------------------------------------------


def calibrate() -> dict:
    """Detect and return the Retina scale factor and screen info."""
    scale = _get_retina_scale()
    # Get screen resolution
    screen_info = None
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType", "-json"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            data = json.loads(result.stdout)
            displays = data.get("SPDisplaysDataType", [])
            if displays:
                d = displays[0]
                ndrvs = d.get("spdisplays_ndrvs", [{}])
                screen_info = {
                    "name": d.get("_name", "Unknown"),
                    "resolution": ndrvs[0].get("spdisplays_resolution", "Unknown") if ndrvs else "Unknown",
                    "retina": d.get("_spdisplays_retina", "spdisplays_no") == "spdisplays_yes",
                }
    except Exception:
        pass

    return {
        "success": True,
        "action": "calibrate",
        "scale_factor": scale,
        "screen": screen_info,
        "note": (
            f"All coordinates in this tool use logical points. "
            f"Divide pixel coordinates by {scale} to get logical points."
        ),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main() -> None:
    _ensure_macos()

    parser = argparse.ArgumentParser(
        description="macOS screen/keyboard/mouse control (zero-dependency)",
    )
    sub = parser.add_subparsers(dest="command")

    # screenshot
    p_ss = sub.add_parser("screenshot", help="Take a screenshot")
    p_ss.add_argument("--region", help="x,y,w,h in logical points")
    p_ss.add_argument("--cursor", action="store_true", help="Include cursor")
    p_ss.add_argument("--output", "-o", help="Output file path")

    # click
    p_click = sub.add_parser("click", help="Click at coordinates")
    p_click.add_argument("--x", type=float, required=True)
    p_click.add_argument("--y", type=float, required=True)
    p_click.add_argument("--button", choices=["left", "right"], default="left")
    p_click.add_argument("--count", type=int, default=1, choices=[1, 2])

    # move
    p_move = sub.add_parser("move", help="Move mouse")
    p_move.add_argument("--x", type=float, required=True)
    p_move.add_argument("--y", type=float, required=True)

    # drag
    p_drag = sub.add_parser("drag", help="Drag from one point to another")
    p_drag.add_argument("--from-x", type=float, required=True)
    p_drag.add_argument("--from-y", type=float, required=True)
    p_drag.add_argument("--to-x", type=float, required=True)
    p_drag.add_argument("--to-y", type=float, required=True)
    p_drag.add_argument("--button", choices=["left", "right"], default="left")

    # type
    p_type = sub.add_parser("type", help="Type text (clipboard-paste method)")
    p_type.add_argument("--text", required=True, help="Text to type")

    # key
    p_key = sub.add_parser("key", help="Press a key")
    p_key.add_argument("--key", required=True, help="Key name")
    p_key.add_argument(
        "--modifiers", nargs="*", default=[],
        help="Modifier keys (cmd, shift, ctrl, alt)",
    )

    # window
    p_win = sub.add_parser("window", help="Get window info")
    p_win.add_argument("--app", required=True, help="Application name")

    # activate
    p_act = sub.add_parser("activate", help="Activate application")
    p_act.add_argument("--app", required=True, help="Application name")

    # calibrate
    sub.add_parser("calibrate", help="Detect Retina scale factor")

    args = parser.parse_args()

    result: dict = {"success": False, "error": "No command specified"}

    if args.command == "screenshot":
        region = None
        if args.region:
            parts = args.region.split(",")
            region = tuple(int(p.strip()) for p in parts)
        result = screenshot(region=region, cursor=args.cursor, output=args.output)

    elif args.command == "click":
        result = click(args.x, args.y, button=args.button, count=args.count)

    elif args.command == "move":
        result = move(args.x, args.y)

    elif args.command == "drag":
        result = drag(args.from_x, args.from_y, args.to_x, args.to_y, button=args.button)

    elif args.command == "type":
        result = type_text(args.text)

    elif args.command == "key":
        result = key_press(args.key, args.modifiers)

    elif args.command == "window":
        result = get_window(args.app)

    elif args.command == "activate":
        result = activate_app(args.app)

    elif args.command == "calibrate":
        result = calibrate()

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
