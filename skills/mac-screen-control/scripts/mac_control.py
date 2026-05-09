#!/usr/bin/env python3
"""
mac_control.py — macOS screen/keyboard/mouse control via CGEvent and AppleScript.

Provides CLI interface for:
  - screenshot: Capture full screen or region
  - click: Left/right/double-click at coordinates
  - move: Move mouse cursor
  - drag: Drag from one point to another
  - type: Type text (CJK supported via clipboard injection)
  - key: Press key with optional modifiers
  - activate: Bring application to front
  - window: Get application window bounds
  - calibrate: Detect Retina scale factor

Platform: macOS only
Requirements: Python 3 (stdlib only), Accessibility permission
"""

import argparse
import json
import os
import subprocess
import sys
import time
import tempfile

# ---------------------------------------------------------------------------
# Platform check
# ---------------------------------------------------------------------------

if sys.platform != "darwin":
    print("ERROR: mac_control.py requires macOS. Current platform: " + sys.platform, file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# CGEvent bindings via ctypes
# ---------------------------------------------------------------------------

import ctypes
import ctypes.util

lib = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
app_kit = ctypes.cdll.LoadLibrary(ctypes.util.find_library("AppKit"))

# CGEvent types
CGEventRef = ctypes.c_void_p
CGDirectDisplayID = ctypes.c_uint32

# Event types
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventLeftMouseDragged = 6
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventRightMouseDragged = 7
kCGEventMouseMoved = 5
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagsChanged = 12

# Mouse buttons
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1

# Event fields
kCGMouseEventNumber = 0
kCGMouseEventClickState = 1

# Key codes
KEYCODE_MAP = {
    "return": 36, "enter": 36,
    "tab": 48,
    "space": 49,
    "delete": 51, "backspace": 51,
    "escape": 53, "esc": 53,
    "up": 126, "down": 125, "left": 123, "right": 124,
    "home": 115, "end": 119,
    "pageup": 116, "pagedown": 121,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118,
    "f5": 96, "f6": 97, "f7": 98, "f8": 100,
    "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    "cmd": 55, "command": 55,
    "shift": 56, "control": 59, "option": 58, "alt": 58,
}

# Modifier flags
kCGEventFlagMaskCmd = 1 << 3    # 0x0008
kCGEventFlagMaskShift = 1 << 1  # 0x0002
kCGEventFlagMaskControl = 1 << 0  # 0x0001
kCGEventFlagMaskAlt = 1 << 2    # 0x0004

MODIFIER_MAP = {
    "cmd": kCGEventFlagMaskCmd,
    "command": kCGEventFlagMaskCmd,
    "shift": kCGEventFlagMaskShift,
    "control": kCGEventFlagMaskControl,
    "ctrl": kCGEventFlagMaskControl,
    "option": kCGEventFlagMaskAlt,
    "alt": kCGEventFlagMaskAlt,
}

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

def _get_main_display_id():
    """Get the main display ID."""
    return lib.CGMainDisplayID()


def _get_cursor_pos():
    """Get current mouse cursor position."""
    point = ctypes.c_int64(0)
    lib.CGGetLastMouseDelta(ctypes.byref(point), None)
    # Use CGEvent to get absolute cursor position
    event = lib.CGEventCreate(None)
    if not event:
        return (0, 0)
    x = lib.CGEventGetIntegerValueField(event, 116)  # kCGMouseEventDeltaX is not right; use cursor position
    y = lib.CGEventGetIntegerValueField(event, 117)
    lib.CFRelease(event)
    return (x, y)


def _create_mouse_event(event_type, x, y, button=kCGMouseButtonLeft, click_count=1):
    """Create a CGEvent for mouse operations."""
    # CGEventCreateMouseEvent(source, type, point, button)
    # point is CGPoint = (x, y) packed as two doubles in a struct
    point = ctypes.c_double * 2
    p = point(float(x), float(y))
    event = lib.CGEventCreateMouseEvent(None, event_type, p, button)
    if event and click_count > 1:
        lib.CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)
    return event


def _post_event(event):
    """Post event and release it."""
    if event:
        lib.CGEventPost(0, event)  # kCGHIDEventTap = 0
        lib.CFRelease(event)


# ---------------------------------------------------------------------------
# Command implementations
# ---------------------------------------------------------------------------

def cmd_screenshot(args):
    """Capture screenshot of full screen or a region."""
    output = args.output
    if not output:
        output = os.path.join(tempfile.gettempdir(), "screenshot.png")

    cmd = ["screencapture", "-x"]  # -x = no sound

    if args.region:
        # Parse region: x,y,w,h
        parts = args.region.split(",")
        if len(parts) != 4:
            print("ERROR: --region must be x,y,w,h format", file=sys.stderr)
            sys.exit(1)
        try:
            x, y, w, h = [int(p.strip()) for p in parts]
        except ValueError:
            print("ERROR: --region values must be integers", file=sys.stderr)
            sys.exit(1)
        cmd.extend(["-R", f"{x},{y},{w},{h}"])

    if args.cursor:
        cmd.append("-C")  # include cursor

    cmd.append(output)

    try:
        subprocess.run(cmd, check=True, capture_output=True, text=True, timeout=10)
        print(json.dumps({
            "success": True,
            "path": output,
            "region": args.region or "fullscreen"
        }))
    except FileNotFoundError:
        print("ERROR: screencapture command not found (requires macOS)", file=sys.stderr)
        sys.exit(1)
    except subprocess.CalledProcessError as e:
        print(f"ERROR: screencapture failed: {e.stderr}", file=sys.stderr)
        sys.exit(1)


def cmd_click(args):
    """Click at specified coordinates."""
    x, y = args.x, args.y
    button = kCGMouseButtonRight if args.button == "right" else kCGMouseButtonLeft
    count = args.count

    down_type = kCGEventRightMouseDown if args.button == "right" else kCGEventLeftMouseDown
    up_type = kCGEventRightMouseUp if args.button == "right" else kCGEventLeftMouseUp

    # Click: down then up
    event = _create_mouse_event(down_type, x, y, button, count)
    _post_event(event)
    time.sleep(0.01)
    event = _create_mouse_event(up_type, x, y, button, count)
    _post_event(event)

    print(json.dumps({
        "success": True,
        "action": "click",
        "x": x,
        "y": y,
        "button": args.button,
        "count": count
    }))


def cmd_move(args):
    """Move mouse cursor to coordinates."""
    x, y = args.x, args.y

    event = _create_mouse_event(kCGEventMouseMoved, x, y)
    _post_event(event)

    print(json.dumps({
        "success": True,
        "action": "move",
        "x": x,
        "y": y
    }))


def cmd_drag(args):
    """Drag from one point to another."""
    from_x, from_y = args.from_x, args.from_y
    to_x, to_y = args.to_x, args.to_y

    # Move to start position
    event = _create_mouse_event(kCGEventMouseMoved, from_x, from_y)
    _post_event(event)
    time.sleep(0.05)

    # Mouse down
    event = _create_mouse_event(kCGEventLeftMouseDown, from_x, from_y)
    _post_event(event)
    time.sleep(0.05)

    # Drag in steps for smoother movement
    steps = max(10, int(((to_x - from_x) ** 2 + (to_y - from_y) ** 2) ** 0.5 / 10))
    for i in range(1, steps + 1):
        t = i / steps
        cx = from_x + (to_x - from_x) * t
        cy = from_y + (to_y - from_y) * t
        event = _create_mouse_event(kCGEventLeftMouseDragged, cx, cy)
        _post_event(event)
        time.sleep(0.005)

    # Mouse up
    event = _create_mouse_event(kCGEventLeftMouseUp, to_x, to_y)
    _post_event(event)

    print(json.dumps({
        "success": True,
        "action": "drag",
        "from": {"x": from_x, "y": from_y},
        "to": {"x": to_x, "y": to_y}
    }))


def cmd_type(args):
    """Type text using clipboard injection (supports CJK)."""
    text = args.text
    delay_ms = args.delay or 0

    # Save current clipboard
    try:
        old_clipboard = subprocess.run(
            ["pbpaste"],
            capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        old_clipboard = ""

    # Set clipboard to text
    try:
        subprocess.run(
            ["pbcopy"],
            input=text, text=True, check=True, timeout=5
        )
    except Exception as e:
        print(f"ERROR: pbcopy failed: {e}", file=sys.stderr)
        sys.exit(1)

    # Small delay for clipboard to settle
    time.sleep(0.05)

    # Cmd+V to paste
    _press_key_with_modifiers("v", [kCGEventFlagMaskCmd])

    if delay_ms:
        time.sleep(delay_ms / 1000.0)

    # Restore clipboard after a short delay
    time.sleep(0.1)
    try:
        subprocess.run(
            ["pbcopy"],
            input=old_clipboard, text=True, timeout=5
        )
    except Exception:
        pass  # Best effort restore

    print(json.dumps({
        "success": True,
        "action": "type",
        "length": len(text),
        "method": "clipboard"
    }))


def _press_key_with_modifiers(key, modifier_flags=None):
    """Press a key with optional modifier flags."""
    # Resolve key code
    key_lower = key.lower()
    if key_lower in KEYCODE_MAP:
        keycode = KEYCODE_MAP[key_lower]
    elif len(key) == 1 and key.isalnum():
        keycode = ord(key.upper()) - 36 if key.isdigit() else ord(key.upper()) - 64
        # Handle edge cases
        if keycode < 0:
            keycode = ord(key.upper())
    else:
        print(f"ERROR: Unknown key '{key}'", file=sys.stderr)
        sys.exit(1)

    # Key down
    event = lib.CGEventCreateKeyboardEvent(None, keycode, True)
    if event and modifier_flags:
        flags = 0
        for f in modifier_flags:
            flags |= f
        lib.CGEventSetFlags(event, flags)
    _post_event(event)

    time.sleep(0.02)

    # Key up
    event = lib.CGEventCreateKeyboardEvent(None, keycode, False)
    if event and modifier_flags:
        flags = 0
        for f in modifier_flags:
            flags |= f
        lib.CGEventSetFlags(event, flags)
    _post_event(event)


def cmd_key(args):
    """Press a key with optional modifiers."""
    key = args.key
    modifier_flags = []

    if args.modifiers:
        for mod in args.modifiers.split(","):
            mod = mod.strip().lower()
            if mod in MODIFIER_MAP:
                modifier_flags.append(MODIFIER_MAP[mod])
            else:
                print(f"ERROR: Unknown modifier '{mod}'", file=sys.stderr)
                sys.exit(1)

    _press_key_with_modifiers(key, modifier_flags if modifier_flags else None)

    print(json.dumps({
        "success": True,
        "action": "key",
        "key": key,
        "modifiers": args.modifiers.split(",") if args.modifiers else []
    }))


def cmd_activate(args):
    """Bring application to foreground."""
    app_name = args.app

    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''

    try:
        subprocess.run(
            ["osascript", "-e", script],
            check=True, capture_output=True, text=True, timeout=10
        )
        time.sleep(0.3)  # Wait for app to come to foreground
        print(json.dumps({
            "success": True,
            "action": "activate",
            "app": app_name
        }))
    except subprocess.CalledProcessError as e:
        print(f"ERROR: Failed to activate '{app_name}': {e.stderr}", file=sys.stderr)
        sys.exit(1)


def cmd_window(args):
    """Get application window bounds."""
    app_name = args.app

    script = f'''
    tell application "System Events"
        tell process "{app_name}"
            set p to position of front window
            set s to size of front window
            return (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s)
        end tell
    end tell
    '''

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10
        )
        if result.returncode != 0:
            print(f"ERROR: {result.stderr}", file=sys.stderr)
            sys.exit(1)

        parts = result.stdout.strip().split(", ")
        if len(parts) != 4:
            print(f"ERROR: Unexpected window bounds format: {result.stdout}", file=sys.stderr)
            sys.exit(1)

        x, y, w, h = [int(p.strip()) for p in parts]
        print(json.dumps({
            "success": True,
            "app": app_name,
            "window": {
                "x": x,
                "y": y,
                "width": w,
                "height": h
            }
        }))
    except subprocess.CalledProcessError as e:
        print(f"ERROR: Failed to get window bounds for '{app_name}': {e.stderr}", file=sys.stderr)
        sys.exit(1)


def cmd_calibrate(args):
    """Detect Retina scale factor and display info."""
    script = '''
    use framework "AppKit"
    set mainScreen to current application's NSScreen's mainScreen()
    set frame to mainScreen's frame()
    set backing to mainScreen's backingScaleFactor()
    set visibleFrame to mainScreen's visibleFrame()
    return (x of origin of frame) & "," & (y of origin of frame) & "," & (width of |size| of frame) & "," & (height of |size| of frame) & "," & backing & "," & (width of |size| of visibleFrame) & "," & (height of |size| of visibleFrame)
    '''

    try:
        result = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=10
        )

        if result.returncode != 0:
            # Fallback: use simpler approach
            return _calibrate_fallback()

        parts = result.stdout.strip().split(", ")
        if len(parts) < 5:
            return _calibrate_fallback()

        x, y, w, h = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        scale = float(parts[4])
        vw = int(parts[5]) if len(parts) > 5 else w
        vh = int(parts[6]) if len(parts) > 6 else h

        print(json.dumps({
            "success": True,
            "mainScreen": {
                "x": x, "y": y,
                "width": w, "height": h,
                "pixelWidth": int(w * scale),
                "pixelHeight": int(h * scale)
            },
            "visibleFrame": {
                "width": vw, "height": vh
            },
            "backingScaleFactor": scale,
            "isRetina": scale > 1.5,
            "coordinateNote": "CGEvent uses logical points (divide screenshot pixels by scale factor)"
        }))
    except Exception:
        return _calibrate_fallback()


def _calibrate_fallback():
    """Fallback calibration using system_profiler."""
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10
        )
        output = result.stdout

        # Parse Retina info
        is_retina = "Retina" in output

        print(json.dumps({
            "success": True,
            "isRetina": is_retina,
            "backingScaleFactor": 2.0 if is_retina else 1.0,
            "coordinateNote": "CGEvent uses logical points (divide screenshot pixels by scale factor)",
            "source": "system_profiler (fallback)"
        }))
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "coordinateNote": "Could not detect scale factor. Default: assume 2.0 for Retina, 1.0 for non-Retina."
        }))


# ---------------------------------------------------------------------------
# CLI Argument Parser
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="macOS screen/keyboard/mouse control via CGEvent"
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # screenshot
    p = subparsers.add_parser("screenshot", help="Capture screenshot")
    p.add_argument("--output", "-o", help="Output file path (default: /tmp/screenshot.png)")
    p.add_argument("--region", "-r", help="Region x,y,w,h (default: fullscreen)")
    p.add_argument("--cursor", "-C", action="store_true", help="Include cursor in screenshot")

    # click
    p = subparsers.add_parser("click", help="Click at coordinates")
    p.add_argument("x", type=int, help="X coordinate")
    p.add_argument("y", type=int, help="Y coordinate")
    p.add_argument("--button", choices=["left", "right"], default="left", help="Mouse button")
    p.add_argument("--count", type=int, default=1, help="Click count (1=single, 2=double)")

    # move
    p = subparsers.add_parser("move", help="Move mouse cursor")
    p.add_argument("x", type=int, help="X coordinate")
    p.add_argument("y", type=int, help="Y coordinate")

    # drag
    p = subparsers.add_parser("drag", help="Drag from point to point")
    p.add_argument("from_x", type=int, help="Start X coordinate")
    p.add_argument("from_y", type=int, help="Start Y coordinate")
    p.add_argument("to_x", type=int, help="End X coordinate")
    p.add_argument("to_y", type=int, help="End Y coordinate")

    # type
    p = subparsers.add_parser("type", help="Type text (CJK supported via clipboard)")
    p.add_argument("text", help="Text to type")
    p.add_argument("--delay", type=int, help="Delay after typing (milliseconds)")

    # key
    p = subparsers.add_parser("key", help="Press a key with optional modifiers")
    p.add_argument("key", help="Key name (return, tab, space, a-z, 0-9, etc.)")
    p.add_argument("--modifiers", "-m", help="Comma-separated modifiers (cmd,shift,control,option)")

    # activate
    p = subparsers.add_parser("activate", help="Bring application to foreground")
    p.add_argument("app", help="Application name")

    # window
    p = subparsers.add_parser("window", help="Get application window bounds")
    p.add_argument("app", help="Application name")

    # calibrate
    subparsers.add_parser("calibrate", help="Detect Retina scale factor")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "screenshot": cmd_screenshot,
        "click": cmd_click,
        "move": cmd_move,
        "drag": cmd_drag,
        "type": cmd_type,
        "key": cmd_key,
        "activate": cmd_activate,
        "window": cmd_window,
        "calibrate": cmd_calibrate,
    }

    fn = commands.get(args.command)
    if fn:
        fn(args)
    else:
        print(f"ERROR: Unknown command '{args.command}'", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
