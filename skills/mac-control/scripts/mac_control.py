#!/usr/bin/env python3
"""
macOS Desktop Automation Control Module.

Provides mouse control, keyboard input, screenshot capture, window management,
and coordinate calibration for macOS using CGEvent (CoreGraphics) and
system commands. Designed for AI agent integration.

Platform: macOS only. Requires Accessibility permission in
System Settings → Privacy & Security → Accessibility.

Usage:
    python3 mac_control.py screenshot [--output PATH] [--region X,Y,W,H]
    python3 mac_control.py click X Y [--button left|right] [--double]
    python3 mac_control.py move X Y
    python3 mac_control.py drag FROM_X FROM_Y TO_X TO_Y [--duration SECS]
    python3 mac_control.py type TEXT [--use-clipboard]
    python3 mac_control.py key KEY [--modifiers CMD,SHIFT,...]
    python3 mac_control.py calibrate
    python3 mac_control.py window APP_NAME
    python3 mac_control.py activate APP_NAME
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any


# ---------------------------------------------------------------------------
# Platform check
# ---------------------------------------------------------------------------
if sys.platform != "darwin":
    print(json.dumps({"error": "mac_control only runs on macOS"}))
    sys.exit(1)

try:
    # pyobjc is required for CGEvent calls
    from Quartz import (
        CGEventCreateMouseEvent,
        CGEventPost,
        CGEventSourceCreate,
        CGEventCreateKeyboardEvent,
        CGEventSetFlags,
        CGEventSetType,
        kCGEventSourceStateHIDSystemState,
        kCGEventMouseMoved,
        kCGEventLeftMouseDown,
        kCGEventLeftMouseUp,
        kCGEventRightMouseDown,
        kCGEventRightMouseUp,
        kCGEventOtherMouseDown,
        kCGEventOtherMouseUp,
        kCGEventKeyDown,
        kCGEventKeyUp,
        kCGEventFlagsChanged,
        kCGEventFlagMaskCommand,
        kCGEventFlagMaskShift,
        kCGEventFlagMaskControl,
        kCGEventFlagMaskAlternate,
        kCGMouseButtonLeft,
        kCGMouseButtonRight,
        kCGHIDEventTap,
        NSScreen,
    )
except ImportError:
    print(json.dumps({
        "error": "pyobjc not installed. Run: pip install pyobjc-framework-Quartz"
    }))
    sys.exit(1)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MOUSE_EVENTS = {
    "left": {
        "down": kCGEventLeftMouseDown,
        "up": kCGEventLeftMouseUp,
        "button": kCGMouseButtonLeft,
    },
    "right": {
        "down": kCGEventRightMouseDown,
        "up": kCGEventRightMouseUp,
        "button": kCGMouseButtonRight,
    },
}

MODIFIER_FLAGS = {
    "cmd": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "ctrl": kCGEventFlagMaskControl,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
}

# macOS virtual key codes for common keys
KEY_CODES: dict[str, int] = {
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "space": 0x31,
    "delete": 0x33, "backspace": 0x33,
    "escape": 0x35, "esc": 0x35,
    "command": 0x37, "cmd": 0x37,
    "shift": 0x38,
    "capslock": 0x39,
    "option": 0x3A, "alt": 0x3A,
    "control": 0x3B, "ctrl": 0x3B,
    "rightshift": 0x3C,
    "rightoption": 0x3D, "rightalt": 0x3D,
    "rightcontrol": 0x3E, "rightctrl": 0x3E,
    "arrowup": 0x7E, "up": 0x7E,
    "arrowdown": 0x7D, "down": 0x7D,
    "arrowleft": 0x7B, "left": 0x7B,
    "arrowright": 0x7C, "right": 0x7C,
    "home": 0x73,
    "end": 0x77,
    "pageup": 0x74,
    "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "v": 0x09,  # Used for Cmd+V paste
}


# ---------------------------------------------------------------------------
# Source singleton
# ---------------------------------------------------------------------------
_source = CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
def _post_event(event: Any) -> None:
    """Post a CGEvent to the HID system."""
    CGEventPost(kCGHIDEventTap, event)


def _success(**kwargs: Any) -> dict[str, Any]:
    """Build a success response dict."""
    return {"success": True, **kwargs}


def _error(msg: str) -> dict[str, Any]:
    """Build an error response dict."""
    return {"success": False, "error": msg}


def _get_scale_factor() -> float:
    """Get the Retina backing scale factor from the main screen."""
    screen = NSScreen.mainScreen()
    if screen:
        return float(screen.backingScaleFactor())
    return 1.0


def _convert_coordinates(x: float, y: float) -> tuple[float, float]:
    """
    Convert screenshot (pixel) coordinates to CGEvent (logical point) coordinates.

    On Retina displays, screenshots are at pixel resolution (e.g., 2x),
    but CGEvent uses logical points. Division by backingScaleFactor converts
    pixel coords to point coords.

    Args:
        x: X coordinate in pixels (from screenshot).
        y: Y coordinate in pixels (from screenshot).

    Returns:
        Tuple of (logical_x, logical_y) for CGEvent.
    """
    scale = _get_scale_factor()
    return x / scale, y / scale


# ---------------------------------------------------------------------------
# Screenshot
# ---------------------------------------------------------------------------
def screenshot(
    output_path: str | None = None,
    region: tuple[int, int, int, int] | None = None,
    show_cursor: bool = False,
) -> dict[str, Any]:
    """
    Capture a screenshot.

    Args:
        output_path: File path to save the screenshot. If None, uses a temp file.
        region: Tuple of (x, y, width, height) to capture a specific region.
        show_cursor: Whether to include the cursor in the screenshot.

    Returns:
        Dict with 'path' to the saved screenshot file.
    """
    if output_path is None:
        fd, output_path = tempfile.mkstemp(suffix=".png")
        os.close(fd)

    cmd = ["screencapture", "-x"]  # -x: no sound
    if show_cursor:
        cmd.append("-C")
    if region:
        x, y, w, h = region
        cmd.extend(["-R", f"{x},{y},{w},{h}"])
    cmd.append(output_path)

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=10)
        return _success(path=output_path)
    except FileNotFoundError:
        return _error("screencapture command not found (not macOS?)")
    except subprocess.CalledProcessError as e:
        return _error(f"screencapture failed: {e.stderr.strip()}")
    except subprocess.TimeoutExpired:
        return _error("screencapture timed out")


# ---------------------------------------------------------------------------
# Mouse Control
# ---------------------------------------------------------------------------
def move(x: float, y: float) -> dict[str, Any]:
    """Move the mouse cursor to (x, y) in logical (CGEvent) coordinates."""
    lx, ly = _convert_coordinates(x, y)
    event = CGEventCreateMouseEvent(
        _source, kCGEventMouseMoved, (lx, ly), kCGMouseButtonLeft
    )
    _post_event(event)
    return _success(x=lx, y=ly)


def click(
    x: float,
    y: float,
    button: str = "left",
    double: bool = False,
    duration: float = 0.05,
) -> dict[str, Any]:
    """
    Click at (x, y) in pixel (screenshot) coordinates.

    Args:
        x: X coordinate in pixels.
        y: Y coordinate in pixels.
        button: 'left' or 'right'.
        double: Whether to double-click.
        duration: Seconds between down and up events.
    """
    if button not in MOUSE_EVENTS:
        return _error(f"Unknown button: {button}. Use 'left' or 'right'.")

    lx, ly = _convert_coordinates(x, y)
    events = MOUSE_EVENTS[button]

    def _do_click() -> None:
        down = CGEventCreateMouseEvent(
            _source, events["down"], (lx, ly), events["button"]
        )
        _post_event(down)
        time.sleep(duration)
        up = CGEventCreateMouseEvent(
            _source, events["up"], (lx, ly), events["button"]
        )
        _post_event(up)

    _do_click()
    if double:
        time.sleep(0.05)
        _do_click()

    return _success(x=lx, y=ly, button=button, double=double)


def drag(
    from_x: float,
    from_y: float,
    to_x: float,
    to_y: float,
    duration: float = 0.5,
    button: str = "left",
) -> dict[str, Any]:
    """
    Drag from (from_x, from_y) to (to_x, to_y) in pixel coordinates.

    Args:
        duration: Total drag duration in seconds.
    """
    if button not in MOUSE_EVENTS:
        return _error(f"Unknown button: {button}")

    flx, fly = _convert_coordinates(from_x, from_y)
    tlx, tly = _convert_coordinates(to_x, to_y)
    events = MOUSE_EVENTS[button]

    # Move to start
    move_event = CGEventCreateMouseEvent(
        _source, kCGEventMouseMoved, (flx, fly), events["button"]
    )
    _post_event(move_event)
    time.sleep(0.05)

    # Mouse down
    down = CGEventCreateMouseEvent(
        _source, events["down"], (flx, fly), events["button"]
    )
    _post_event(down)
    time.sleep(0.05)

    # Animate drag in steps
    steps = max(int(duration / 0.01), 10)
    for i in range(1, steps + 1):
        t = i / steps
        cx = flx + (tlx - flx) * t
        cy = fly + (tly - fly) * t
        drag_event = CGEventCreateMouseEvent(
            _source, events["down"], (cx, cy), events["button"]
        )
        _post_event(drag_event)
        time.sleep(duration / steps)

    # Mouse up
    up = CGEventCreateMouseEvent(
        _source, events["up"], (tlx, tly), events["button"]
    )
    _post_event(up)

    return _success(
        from_x=flx, from_y=fly, to_x=tlx, to_y=tly, duration=duration
    )


# ---------------------------------------------------------------------------
# Keyboard Input
# ---------------------------------------------------------------------------
def type_text(
    text: str,
    use_clipboard: bool = True,
    restore_clipboard: bool = True,
) -> dict[str, Any]:
    """
    Type text, supporting CJK and special characters.

    Strategy:
    - By default, uses clipboard paste (pbcopy + Cmd+V) which handles all
      Unicode including CJK, emoji, and combining marks.
    - If use_clipboard=False, uses CGEvent keystroke injection (ASCII only).

    Args:
        text: The text to type.
        use_clipboard: Use clipboard paste method (recommended).
        restore_clipboard: Save and restore clipboard contents.
    """
    if not text:
        return _error("Empty text")

    if use_clipboard:
        return _type_via_clipboard(text, restore_clipboard)
    else:
        return _type_via_keystrokes(text)


def _type_via_clipboard(
    text: str, restore_clipboard: bool = True
) -> dict[str, Any]:
    """Type text using pbcopy + Cmd+V. Handles all Unicode."""
    saved_clipboard = None
    if restore_clipboard:
        # Save current clipboard
        try:
            result = subprocess.run(
                ["pbpaste"],
                capture_output=True,
                timeout=5,
            )
            if result.returncode == 0:
                saved_clipboard = result.stdout
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass

    try:
        # Set clipboard content
        proc = subprocess.run(
            ["pbcopy"],
            input=text.encode("utf-8"),
            check=True,
            capture_output=True,
            timeout=5,
        )

        time.sleep(0.05)

        # Press Cmd+V
        _press_key("v", modifiers=["cmd"])
        time.sleep(0.1)

        return _success(method="clipboard", length=len(text))
    except subprocess.CalledProcessError as e:
        return _error(f"pbcopy failed: {e.stderr.decode()}")
    finally:
        # Restore clipboard after a short delay
        if saved_clipboard is not None:
            time.sleep(0.2)
            try:
                subprocess.run(
                    ["pbcopy"],
                    input=saved_clipboard,
                    capture_output=True,
                    timeout=5,
                )
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                pass


def _type_via_keystrokes(text: str) -> dict[str, Any]:
    """Type ASCII text via individual CGEvent keystrokes. Limited to ASCII."""
    for char in text:
        if ord(char) > 127:
            return _error(
                f"Non-ASCII character '{char}' - use clipboard method instead"
            )
        _press_char(char)
        time.sleep(0.02)
    return _success(method="keystroke", length=len(text))


def _press_char(char: str) -> None:
    """Press a single character key."""
    # Map character to virtual key code (simplified for common ASCII)
    char_lower = char.lower()
    # For a-z, key code = ord(char) - ord('a') + 0x04
    if 'a' <= char_lower <= 'z':
        key_code = ord(char_lower) - ord('a') + 0x04
    elif '0' <= char <= '9':
        key_code = ord(char) - ord('0') + 0x1D if char != '0' else 0x1D + 9
        # Fix: 1=0x12, 2=0x13, ..., 9=0x1C, 0=0x1D
        key_code = [0x1D, 0x12, 0x13, 0x14, 0x15, 0x17, 0x16, 0x1A, 0x1C, 0x19][int(char)]
    else:
        # For other ASCII, try direct Unicode
        _press_unicode_char(char)
        return

    need_shift = char.isupper()
    if need_shift:
        shift_down = CGEventCreateKeyboardEvent(_source, 0x38, True)  # shift key
        _post_event(shift_down)

    key_down = CGEventCreateKeyboardEvent(_source, key_code, True)
    _post_event(key_down)
    time.sleep(0.01)
    key_up = CGEventCreateKeyboardEvent(_source, key_code, False)
    _post_event(key_up)

    if need_shift:
        shift_up = CGEventCreateKeyboardEvent(_source, 0x38, False)
        _post_event(shift_up)


def _press_unicode_char(char: str) -> None:
    """Press a single Unicode character using CGEvent keyboard event."""
    # CGEventCreateKeyboardEvent with a virtual keycode, then set Unicode string
    key_down = CGEventCreateKeyboardEvent(_source, 0x00, True)
    key_up = CGEventCreateKeyboardEvent(_source, 0x00, False)
    # Set the unicode string on both events
    # Note: CGEventKeyboardSetUnicodeString only works reliably for single chars
    from Quartz import CGEventKeyboardSetUnicodeString
    CGEventKeyboardSetUnicodeString(key_down, len(char), char)
    CGEventKeyboardSetUnicodeString(key_up, len(char), char)
    _post_event(key_down)
    _post_event(key_up)


def _press_key(key: str, modifiers: list[str] | None = None) -> None:
    """Press a named key with optional modifiers."""
    key_lower = key.lower()
    if key_lower not in KEY_CODES:
        raise ValueError(f"Unknown key: {key}")

    key_code = KEY_CODES[key_lower]
    mod_flags = 0
    if modifiers:
        for mod in modifiers:
            mod_lower = mod.lower()
            if mod_lower in MODIFIER_FLAGS:
                mod_flags |= MODIFIER_FLAGS[mod_lower]

    # Press modifiers first
    if mod_flags:
        flags_event = CGEventCreateKeyboardEvent(_source, 0, True)
        CGEventSetFlags(flags_event, mod_flags)
        _post_event(flags_event)
        time.sleep(0.01)

    # Press the key
    key_down = CGEventCreateKeyboardEvent(_source, key_code, True)
    if mod_flags:
        CGEventSetFlags(key_down, mod_flags)
    _post_event(key_down)
    time.sleep(0.02)

    key_up = CGEventCreateKeyboardEvent(_source, key_code, False)
    if mod_flags:
        CGEventSetFlags(key_up, mod_flags)
    _post_event(key_up)

    # Release modifiers
    if mod_flags:
        flags_up = CGEventCreateKeyboardEvent(_source, 0, False)
        CGEventSetFlags(flags_up, 0)
        _post_event(flags_up)


def press_key(key: str, modifiers: list[str] | None = None) -> dict[str, Any]:
    """
    Press a named key with optional modifiers.

    Args:
        key: Key name (e.g., 'return', 'tab', 'v', 'f1').
        modifiers: List of modifier keys (e.g., ['cmd', 'shift']).
    """
    try:
        _press_key(key, modifiers)
        return _success(key=key, modifiers=modifiers or [])
    except ValueError as e:
        return _error(str(e))


# ---------------------------------------------------------------------------
# Coordinate Calibration
# ---------------------------------------------------------------------------
def calibrate() -> dict[str, Any]:
    """
    Get display calibration info: scale factor, screen size, coordinate info.

    Returns scale factor and screen dimensions in both pixel and point units.
    """
    scale = _get_scale_factor()
    screens_info = []

    for i, screen in enumerate(NSScreen.screens()):
        frame = screen.frame()
        backing = screen.backingScaleFactor()
        screens_info.append({
            "index": i,
            "is_main": screen == NSScreen.mainScreen(),
            "frame_points": {
                "x": frame.origin.x,
                "y": frame.origin.y,
                "width": frame.size.width,
                "height": frame.size.height,
            },
            "frame_pixels": {
                "x": int(frame.origin.x * backing),
                "y": int(frame.origin.y * backing),
                "width": int(frame.size.width * backing),
                "height": int(frame.size.height * backing),
            },
            "backing_scale_factor": backing,
        })

    return _success(
        primary_scale_factor=scale,
        screens=screens_info,
        note="Divide screenshot pixel coords by scale_factor to get CGEvent logical coords",
    )


# ---------------------------------------------------------------------------
# Window Management
# ---------------------------------------------------------------------------
def get_app_window(app_name: str) -> dict[str, Any]:
    """
    Get window bounds for an application using AppleScript.

    Returns window position and size in logical points.
    """
    script = f'''
    tell application "System Events"
        set p to first process whose name is "{app_name}"
        set w to front window of p
        set b to bounds of w
        return {{item 1 of b, item 2 of b, item 3 of b, item 4 of b}}
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
            return _error(
                f"Failed to get window bounds: {result.stderr.strip()}"
            )

        # Parse "x1, y1, x2, y2" format
        parts = result.stdout.strip().split(", ")
        if len(parts) != 4:
            return _error(f"Unexpected window bounds format: {result.stdout}")

        x1, y1, x2, y2 = [float(p.strip()) for p in parts]
        return _success(
            app=app_name,
            bounds_points={
                "x": x1, "y": y1,
                "width": x2 - x1, "height": y2 - y1,
            },
        )
    except subprocess.TimeoutExpired:
        return _error("osascript timed out")
    except Exception as e:
        return _error(f"Failed to get window: {e}")


def activate_app(app_name: str) -> dict[str, Any]:
    """Bring an application to the foreground."""
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''
    try:
        subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return _success(app=app_name, activated=True)
    except subprocess.TimeoutExpired:
        return _error("osascript timed out")
    except Exception as e:
        return _error(f"Failed to activate app: {e}")


# ---------------------------------------------------------------------------
# Accessibility: Find UI Elements (Phase 3 - basic)
# ---------------------------------------------------------------------------
def find_element(
    app_name: str,
    role: str | None = None,
    title: str | None = None,
    max_depth: int = 10,
) -> dict[str, Any]:
    """
    Find UI elements in an application using Accessibility API.

    Args:
        app_name: Application name.
        role: Optional AXRole filter (e.g., 'AXButton', 'AXTextField').
        title: Optional title/description filter.
        max_depth: Maximum tree traversal depth.

    Returns:
        List of matching elements with their properties.
    """
    conditions = []
    if role:
        conditions.append(f'its role is "{role}"')
    if title:
        conditions.append(f'its description contains "{title}"')

    where_clause = ""
    if conditions:
        where_clause = "where " + " and ".join(conditions)

    script = f'''
    tell application "System Events"
        set p to first process whose name is "{app_name}"
        set elements to every UI element of front window of p {where_clause}
        set result to {{}}
        repeat with e in elements
            set end of result to {{role of e, description of e, position of e, size of e}}
        end repeat
        return result
    end tell
    '''
    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode != 0:
            return _error(f"Accessibility query failed: {result.stderr.strip()}")

        return _success(
            app=app_name,
            raw_elements=result.stdout.strip(),
            note="Parsed element tree from Accessibility API",
        )
    except subprocess.TimeoutExpired:
        return _error("Accessibility query timed out")
    except Exception as e:
        return _error(f"Accessibility query failed: {e}")


# ---------------------------------------------------------------------------
# CLI Entry Point
# ---------------------------------------------------------------------------
def main() -> None:
    parser = argparse.ArgumentParser(
        description="macOS Desktop Automation Control"
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # screenshot
    ss_parser = subparsers.add_parser("screenshot", help="Capture a screenshot")
    ss_parser.add_argument("--output", "-o", help="Output file path")
    ss_parser.add_argument(
        "--region", help="Region x,y,w,h (pixel coordinates)"
    )
    ss_parser.add_argument(
        "--cursor", action="store_true", help="Include cursor"
    )

    # click
    click_parser = subparsers.add_parser("click", help="Click at coordinates")
    click_parser.add_argument("x", type=float, help="X (pixel coordinate)")
    click_parser.add_argument("y", type=float, help="Y (pixel coordinate)")
    click_parser.add_argument(
        "--button", default="left", choices=["left", "right"]
    )
    click_parser.add_argument("--double", action="store_true")
    click_parser.add_argument(
        "--duration", type=float, default=0.05, help="Click duration (seconds)"
    )

    # move
    move_parser = subparsers.add_parser("move", help="Move mouse cursor")
    move_parser.add_argument("x", type=float)
    move_parser.add_argument("y", type=float)

    # drag
    drag_parser = subparsers.add_parser("drag", help="Drag from A to B")
    drag_parser.add_argument("from_x", type=float)
    drag_parser.add_argument("from_y", type=float)
    drag_parser.add_argument("to_x", type=float)
    drag_parser.add_argument("to_y", type=float)
    drag_parser.add_argument("--duration", type=float, default=0.5)

    # type
    type_parser = subparsers.add_parser("type", help="Type text")
    type_parser.add_argument("text", help="Text to type")
    type_parser.add_argument(
        "--no-clipboard",
        action="store_true",
        help="Use keystroke injection instead of clipboard (ASCII only)",
    )

    # key
    key_parser = subparsers.add_parser("key", help="Press a key")
    key_parser.add_argument("key", help="Key name (e.g., return, tab, v)")
    key_parser.add_argument(
        "--modifiers", help="Comma-separated modifiers (cmd,shift,ctrl,alt)"
    )

    # calibrate
    subparsers.add_parser("calibrate", help="Get display calibration info")

    # window
    win_parser = subparsers.add_parser("window", help="Get app window bounds")
    win_parser.add_argument("app_name", help="Application name")

    # activate
    act_parser = subparsers.add_parser("activate", help="Activate an app")
    act_parser.add_argument("app_name", help="Application name")

    # find-element
    fe_parser = subparsers.add_parser(
        "find-element", help="Find UI elements via Accessibility API"
    )
    fe_parser.add_argument("app_name", help="Application name")
    fe_parser.add_argument("--role", help="AXRole filter")
    fe_parser.add_argument("--title", help="Title/description filter")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    result: dict[str, Any]

    if args.command == "screenshot":
        region = None
        if args.region:
            parts = [int(x) for x in args.region.split(",")]
            if len(parts) != 4:
                result = _error("Region must be x,y,w,h")
            else:
                region = tuple(parts)
        result = screenshot(
            output_path=args.output,
            region=region,
            show_cursor=args.cursor,
        )

    elif args.command == "click":
        result = click(
            args.x, args.y,
            button=args.button,
            double=args.double,
            duration=args.duration,
        )

    elif args.command == "move":
        result = move(args.x, args.y)

    elif args.command == "drag":
        result = drag(
            args.from_x, args.from_y,
            args.to_x, args.to_y,
            duration=args.duration,
        )

    elif args.command == "type":
        result = type_text(
            args.text,
            use_clipboard=not args.no_clipboard,
        )

    elif args.command == "key":
        modifiers = None
        if args.modifiers:
            modifiers = [m.strip() for m in args.modifiers.split(",")]
        result = press_key(args.key, modifiers)

    elif args.command == "calibrate":
        result = calibrate()

    elif args.command == "window":
        result = get_app_window(args.app_name)

    elif args.command == "activate":
        result = activate_app(args.app_name)

    elif args.command == "find-element":
        result = find_element(
            args.app_name,
            role=args.role,
            title=args.title,
        )

    else:
        result = _error(f"Unknown command: {args.command}")

    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
