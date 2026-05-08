#!/usr/bin/env python3
"""
mac-control.py — macOS screen/keyboard/mouse control via CGEvent + Accessibility API.

Zero external dependencies: only Python stdlib + macOS native frameworks via ctypes.

Usage:
    python3 mac-control.py <command> [options]

Commands:
    screenshot [--output PATH] [--region X,Y,W,H]
    click X Y [--button left|right|double] [--delay MS]
    move X Y
    type TEXT [--method clipboard|cgevent]
    key KEY [--modifiers CMD,SHIFT,...]
    window-info [--app APP_NAME]
    activate-app APP_NAME
    calibrate
    check-permissions

Output:
    JSON to stdout: {"ok": true, "data": {...}} or {"ok": false, "error": "..."}
"""

import json
import os
import platform
import subprocess
import sys
import tempfile
import time
from argparse import ArgumentParser
from typing import Any

# ── Platform guard ────────────────────────────────────────────────────────────

IS_MACOS = platform.system() == "Darwin"

if IS_MACOS:
    import ctypes
    import ctypes.util

    # CoreGraphics / CoreFoundation via ctypes
    _cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
    _cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    _app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))

    # CGEvent types
    CGEventRef = ctypes.c_void_p
    CGDirectDisplayID = ctypes.c_uint32

    # CGEventType enum
    kCGEventLeftMouseDown = 1
    kCGEventLeftMouseUp = 2
    kCGEventRightMouseDown = 3
    kCGEventRightMouseUp = 4
    kCGEventMouseMoved = 5
    kCGEventLeftMouseDragged = 6
    kCGEventRightMouseDragged = 7
    kCGEventKeyDown = 10
    kCGEventKeyUp = 11
    kCGEventFlagsChanged = 12

    # CGMouseButton
    kCGMouseButtonLeft = 0
    kCGMouseButtonRight = 1

    # CGEventFlags (modifier keys)
    kCGEventFlagMaskCommand = 1 << 8
    kCGEventFlagMaskShift = 1 << 9
    kCGEventFlagMaskControl = 1 << 12
    kCGEventFlagMaskAlternate = 1 << 11

    # CGEventTapLocation
    kCGHIDEventTap = 0

    # KeyCode constants
    _KEYCODE_MAP: dict[str, int] = {
        "return": 0x24,
        "enter": 0x24,
        "tab": 0x30,
        "space": 0x31,
        "delete": 0x33,
        "backspace": 0x33,
        "escape": 0x35,
        "esc": 0x35,
        "command": 0x37,
        "cmd": 0x37,
        "shift": 0x38,
        "capslock": 0x39,
        "option": 0x3A,
        "alt": 0x3A,
        "control": 0x3B,
        "ctrl": 0x3B,
        "right-shift": 0x3C,
        "right-option": 0x3D,
        "right-control": 0x3E,
        "up": 0x7E,
        "down": 0x7D,
        "left": 0x7B,
        "right": 0x7C,
        "home": 0x73,
        "end": 0x77,
        "pageup": 0x74,
        "pagedown": 0x79,
        "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
        "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
        "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
        "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E,
        "f": 0x03, "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26,
        "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D, "o": 0x1F,
        "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
        "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10,
        "z": 0x06,
        "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
        "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
        "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
        ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
        "`": 0x32,
    }

    _MODIFIER_FLAG_MAP: dict[str, int] = {
        "cmd": kCGEventFlagMaskCommand,
        "command": kCGEventFlagMaskCommand,
        "shift": kCGEventFlagMaskShift,
        "ctrl": kCGEventFlagMaskControl,
        "control": kCGEventFlagMaskControl,
        "alt": kCGEventFlagMaskAlternate,
        "option": kCGEventFlagMaskAlternate,
    }


# ── Helpers ───────────────────────────────────────────────────────────────────


def _ok(data: Any = None) -> None:
    """Print success JSON and exit."""
    print(json.dumps({"ok": True, "data": data}))
    sys.exit(0)


def _err(msg: str) -> None:
    """Print error JSON and exit."""
    print(json.dumps({"ok": False, "error": msg}))
    sys.exit(1)


def _require_macos() -> None:
    """Ensure we're running on macOS."""
    if not IS_MACOS:
        _err("macOS required — this skill only works on macOS with Accessibility permissions")


# ── CGEvent Wrappers ──────────────────────────────────────────────────────────


def _cg_event_create_mouse(x: float, y: float, event_type: int, button: int = 0) -> CGEventRef:
    """Create a mouse CGEvent."""
    point = ctypes.c_int32(int(x)), ctypes.c_int32(int(y))
    return _cg.CGEventCreateMouseEvent(None, ctypes.c_uint32(event_type), *point, ctypes.c_uint32(button))


def _cg_event_post(event: CGEventRef) -> None:
    """Post a CGEvent to the HID event tap."""
    _cg.CGEventPost(ctypes.c_uint32(kCGHIDEventTap), event)


def _cg_event_create_keyboard(keycode: int, key_down: bool) -> CGEventRef:
    """Create a keyboard CGEvent."""
    event = _cg.CGEventCreateKeyboardEvent(None, ctypes.c_uint16(keycode), ctypes.c_bool(key_down))
    return event


def _cg_event_set_flags(event: CGEventRef, flags: int) -> None:
    """Set modifier flags on a CGEvent."""
    _cg.CGEventSetFlags(event, ctypes.c_uint64(flags))


def _get_modifier_flags(modifier_str: str) -> int:
    """Parse modifier string like 'cmd,shift' into CGEventFlag bitmask."""
    if not modifier_str:
        return 0
    flags = 0
    for mod in modifier_str.split(","):
        mod = mod.strip().lower()
        if mod in _MODIFIER_FLAG_MAP:
            flags |= _MODIFIER_FLAG_MAP[mod]
    return flags


# ── Commands ──────────────────────────────────────────────────────────────────


def cmd_screenshot(output: str | None, region: str | None) -> None:
    """Capture a screenshot using the native screencapture command."""
    _require_macos()

    if output is None:
        output = os.path.join(tempfile.gettempdir(), f"mac-screenshot-{int(time.time())}.png")

    cmd = ["screencapture", "-x"]  # -x: no sound

    if region:
        # region format: X,Y,W,H
        parts = region.split(",")
        if len(parts) != 4:
            _err("Region must be X,Y,W,H format")
        x, y, w, h = (str(int(float(p))) for p in parts)
        cmd.extend(["-R", f"{x},{y},{w},{h}"])

    cmd.append(output)

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=10)
        _ok({"path": output, "region": region})
    except FileNotFoundError:
        _err("screencapture command not found — are you on macOS?")
    except subprocess.CalledProcessError as e:
        _err(f"screencapture failed: {e.stderr.strip() or e.returncode}")
    except subprocess.TimeoutExpired:
        _err("screencapture timed out")


def cmd_click(x: float, y: float, button: str, delay: int) -> None:
    """Click at the given coordinates (logical points)."""
    _require_macos()

    if button == "right":
        down_event = kCGEventRightMouseDown
        up_event = kCGEventRightMouseUp
        mouse_button = kCGMouseButtonRight
    else:
        down_event = kCGEventLeftMouseDown
        up_event = kCGEventLeftMouseUp
        mouse_button = kCGMouseButtonLeft

    try:
        if button == "double":
            # Double-click: two down/up cycles
            for _ in range(2):
                e = _cg_event_create_mouse(x, y, down_event, mouse_button)
                _cg_event_post(e)
                e = _cg_event_create_mouse(x, y, up_event, mouse_button)
                _cg_event_post(e)
                time.sleep(0.05)  # 50ms between clicks for double-click detection
        else:
            e = _cg_event_create_mouse(x, y, down_event, mouse_button)
            _cg_event_post(e)
            if delay > 0:
                time.sleep(delay / 1000.0)
            e = _cg_event_create_mouse(x, y, up_event, mouse_button)
            _cg_event_post(e)

        _ok({"x": x, "y": y, "button": button})
    except Exception as e:
        _err(f"Click failed: {e}")


def cmd_move(x: float, y: float) -> None:
    """Move the mouse cursor to the given coordinates."""
    _require_macos()

    try:
        e = _cg_event_create_mouse(x, y, kCGEventMouseMoved, 0)
        _cg_event_post(e)
        _ok({"x": x, "y": y})
    except Exception as e:
        _err(f"Move failed: {e}")


def cmd_type(text: str, method: str) -> None:
    """Type text using the specified method (clipboard or cgevent)."""
    _require_macos()

    if not text:
        _err("No text provided")

    try:
        if method == "clipboard":
            _type_via_clipboard(text)
        else:
            _type_via_cgevent(text)
        _ok({"text": text, "method": method, "length": len(text)})
    except Exception as e:
        _err(f"Type failed: {e}")


def _type_via_clipboard(text: str) -> None:
    """Type text by copying to clipboard and simulating Cmd+V.

    This is the recommended method for CJK and special characters.
    Saves and restores the original clipboard contents.
    """
    # Save original clipboard
    try:
        original = subprocess.run(
            ["pbpaste"],
            capture_output=True,
            timeout=5,
        ).stdout
    except Exception:
        original = b""

    # Copy new text to clipboard
    subprocess.run(
        ["pbcopy"],
        input=text.encode("utf-8"),
        check=True,
        timeout=5,
    )

    # Small delay for clipboard to settle
    time.sleep(0.05)

    # Simulate Cmd+V
    cmd_flag = kCGEventFlagMaskCommand
    v_keycode = _KEYCODE_MAP["v"]

    # Key down with Cmd modifier
    e = _cg_event_create_keyboard(v_keycode, True)
    _cg_event_set_flags(e, cmd_flag)
    _cg_event_post(e)
    time.sleep(0.02)

    # Key up with Cmd modifier
    e = _cg_event_create_keyboard(v_keycode, False)
    _cg_event_set_flags(e, cmd_flag)
    _cg_event_post(e)
    time.sleep(0.05)

    # Restore original clipboard
    try:
        subprocess.run(
            ["pbcopy"],
            input=original,
            timeout=5,
        )
    except Exception:
        pass  # Best-effort restoration


def _type_via_cgevent(text: str) -> None:
    """Type text via CGEvent keyboard events.

    Only reliable for ASCII characters. Use clipboard method for CJK.
    """
    for char in text:
        keycode = _KEYCODE_MAP.get(char.lower())
        if keycode is None:
            # Fall back to clipboard for unsupported characters
            _type_via_clipboard(char)
            continue

        # Check if shift is needed for uppercase
        flags = 0
        if char.isupper():
            flags |= kCGEventFlagMaskShift

        e = _cg_event_create_keyboard(keycode, True)
        if flags:
            _cg_event_set_flags(e, flags)
        _cg_event_post(e)
        time.sleep(0.01)

        e = _cg_event_create_keyboard(keycode, False)
        if flags:
            _cg_event_set_flags(e, flags)
        _cg_event_post(e)
        time.sleep(0.01)


def cmd_key(key: str, modifiers: str) -> None:
    """Press a key with optional modifiers."""
    _require_macos()

    key_lower = key.lower()
    keycode = _KEYCODE_MAP.get(key_lower)
    if keycode is None:
        _err(f"Unknown key: {key}. Available keys: {', '.join(sorted(_KEYCODE_MAP.keys()))}")

    flags = _get_modifier_flags(modifiers)

    try:
        # Press modifier keys first (flags set on the event itself)
        e = _cg_event_create_keyboard(keycode, True)
        if flags:
            _cg_event_set_flags(e, flags)
        _cg_event_post(e)
        time.sleep(0.02)

        e = _cg_event_create_keyboard(keycode, False)
        if flags:
            _cg_event_set_flags(e, flags)
        _cg_event_post(e)

        _ok({"key": key, "modifiers": modifiers.split(",") if modifiers else []})
    except Exception as e:
        _err(f"Key press failed: {e}")


def cmd_window_info(app_name: str | None) -> None:
    """Get window bounds for the specified app (or frontmost app)."""
    _require_macos()

    if app_name:
        script = f'''
        tell application "System Events"
            set p to process "{app_name}"
            set w to front window of p
            set b to bounds of w
            return (item 1 of b as text) & "," & (item 2 of b as text) & "," & ((item 3 of b) - (item 1 of b) as text) & "," & ((item 4 of b) - (item 2 of b) as text)
        end tell
        '''
    else:
        script = '''
        tell application "System Events"
            set p to first process whose frontmost is true
            set w to front window of p
            set b to bounds of w
            return (item 1 of b as text) & "," & (item 2 of b as text) & "," & ((item 3 of b) - (item 1 of b) as text) & "," & ((item 4 of b) - (item 2 of b) as text)
        end tell
        '''

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            _err(f"Failed to get window info: {result.stderr.strip()}")

        # Parse "x,y,width,height"
        parts = result.stdout.strip().split(",")
        if len(parts) != 4:
            _err(f"Unexpected window bounds format: {result.stdout.strip()}")

        x, y, w, h = (float(p.strip()) for p in parts)
        _ok({"x": x, "y": y, "width": w, "height": h, "app": app_name or "frontmost"})
    except subprocess.TimeoutExpired:
        _err("osascript timed out")
    except Exception as e:
        _err(f"Window info failed: {e}")


def cmd_activate_app(app_name: str) -> None:
    """Bring the specified application to the foreground."""
    _require_macos()

    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''

    try:
        subprocess.run(
            ["osascript", "-e", script],
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        )
        # Small delay for app to come to foreground
        time.sleep(0.3)
        _ok({"app": app_name, "activated": True})
    except subprocess.CalledProcessError as e:
        _err(f"Failed to activate '{app_name}': {e.stderr.strip()}")
    except subprocess.TimeoutExpired:
        _err("osascript timed out")


def cmd_calibrate() -> None:
    """Detect Retina scaling factor by comparing screen dimensions."""
    _require_macos()

    try:
        # Get logical screen size via NSScreen
        script = '''
        use framework "AppKit"
        set mainScreen to current application's NSScreen's mainScreen()
        set frame to mainScreen's frame()
        set logicalWidth to (item 1 of frame's size) as text
        set logicalHeight to (item 2 of frame's size) as text
        return logicalWidth & "," & logicalHeight
        '''
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        logical_w, logical_h = (float(p.strip()) for p in result.stdout.strip().split(","))

        # Get pixel dimensions via CGDisplayPixelsWide / CGDisplayPixelsHigh
        main_display = _cg.CGMainDisplayID()
        pixel_w = _cg.CGDisplayPixelsWide(main_display)
        pixel_h = _cg.CGDisplayPixelsHigh(main_display)

        scale_x = pixel_w / logical_w if logical_w > 0 else 1.0
        scale_y = pixel_h / logical_h if logical_h > 0 else 1.0

        _ok({
            "logical_size": {"width": logical_w, "height": logical_h},
            "pixel_size": {"width": pixel_w, "height": pixel_h},
            "scale_factor": round(scale_x, 2),
            "is_retina": scale_x > 1.5,
            "note": "Screenshot pixel coordinates should be divided by scale_factor to get logical click coordinates",
        })
    except Exception as e:
        _err(f"Calibration failed: {e}")


def cmd_check_permissions() -> None:
    """Check if the current process has Accessibility permissions."""
    _require_macos()

    try:
        # Try to create and post a test event
        test_event = _cg.CGEventCreateMouseEvent(
            None,
            ctypes.c_uint32(kCGEventMouseMoved),
            ctypes.c_int32(0),
            ctypes.c_int32(0),
            ctypes.c_uint32(0),
        )

        has_access = test_event is not None
        if has_access:
            _ok({
                "accessibility": True,
                "note": "Accessibility permissions are granted",
            })
        else:
            _ok({
                "accessibility": False,
                "note": "Grant Accessibility permission in System Settings → Privacy & Security → Accessibility",
            })
    except Exception as e:
        _ok({
            "accessibility": False,
            "error": str(e),
            "note": "Grant Accessibility permission in System Settings → Privacy & Security → Accessibility",
        })


# ── CLI ───────────────────────────────────────────────────────────────────────


def main() -> None:
    parser = ArgumentParser(description="macOS screen/keyboard/mouse control")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # screenshot
    p = subparsers.add_parser("screenshot", help="Capture screenshot")
    p.add_argument("--output", "-o", help="Output file path (default: temp file)")
    p.add_argument("--region", "-r", help="Region X,Y,W,H in logical points")

    # click
    p = subparsers.add_parser("click", help="Click at coordinates")
    p.add_argument("x", type=float, help="X coordinate (logical points)")
    p.add_argument("y", type=float, help="Y coordinate (logical points)")
    p.add_argument("--button", choices=["left", "right", "double"], default="left")
    p.add_argument("--delay", type=int, default=0, help="Delay between down/up in ms")

    # move
    p = subparsers.add_parser("move", help="Move mouse to coordinates")
    p.add_argument("x", type=float, help="X coordinate (logical points)")
    p.add_argument("y", type=float, help="Y coordinate (logical points)")

    # type
    p = subparsers.add_parser("type", help="Type text (supports CJK via clipboard)")
    p.add_argument("text", help="Text to type")
    p.add_argument("--method", choices=["clipboard", "cgevent"], default="clipboard",
                   help="Input method (default: clipboard, supports CJK)")

    # key
    p = subparsers.add_parser("key", help="Press a key with optional modifiers")
    p.add_argument("key", help="Key name (e.g. return, tab, a-z, 0-9, f1-f12)")
    p.add_argument("--modifiers", "-m", default="", help="Modifier keys: cmd,shift,ctrl,alt (comma-separated)")

    # window-info
    p = subparsers.add_parser("window-info", help="Get window bounds")
    p.add_argument("--app", "-a", help="Application name (default: frontmost)")

    # activate-app
    p = subparsers.add_parser("activate-app", help="Bring application to foreground")
    p.add_argument("app_name", help="Application name")

    # calibrate
    subparsers.add_parser("calibrate", help="Detect Retina scaling factor")

    # check-permissions
    subparsers.add_parser("check-permissions", help="Check Accessibility permissions")

    args = parser.parse_args()

    cmd = args.command

    if cmd == "screenshot":
        cmd_screenshot(args.output, args.region)
    elif cmd == "click":
        cmd_click(args.x, args.y, args.button, args.delay)
    elif cmd == "move":
        cmd_move(args.x, args.y)
    elif cmd == "type":
        cmd_type(args.text, args.method)
    elif cmd == "key":
        cmd_key(args.key, args.modifiers)
    elif cmd == "window-info":
        cmd_window_info(args.app)
    elif cmd == "activate-app":
        cmd_activate_app(args.app_name)
    elif cmd == "calibrate":
        cmd_calibrate()
    elif cmd == "check-permissions":
        cmd_check_permissions()
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
