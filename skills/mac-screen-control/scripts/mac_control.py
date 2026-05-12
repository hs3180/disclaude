#!/usr/bin/env python3
"""
macOS screen/keyboard/mouse control via CGEvent (CoreGraphics).

Uses Python ctypes to call CoreGraphics CGEvent APIs directly — zero external
dependencies.  Requires "Accessibility" permission in System Settings > Privacy &
Security.

Usage (invoked by the skill via Bash):
    python3 mac_control.py screenshot [--output PATH] [--region X,Y,W,H]
    python3 mac_control.py click    X Y [--button left|right] [--double]
    python3 mac_control.py move     X Y
    python3 mac_control.py drag     X1 Y1 X2 Y2 [--duration MS]
    python3 mac_control.py type     "text to type"
    python3 mac_control.py key      key [--modifier CMD,SHIFT,...]
    python3 mac_control.py scale
    python3 mac_control.py windows  [--app NAME]
    python3 mac_control.py activate APP_NAME
"""

import argparse
import ctypes
import ctypes.util
import json
import os
import subprocess
import sys
import tempfile
import time

# ---------------------------------------------------------------------------
# CoreGraphics bindings via ctypes
# ---------------------------------------------------------------------------

_lib_path = ctypes.util.find_library("CoreGraphics")
if not _lib_path:
    print(json.dumps({"error": "CoreGraphics not found — not running on macOS?"}))
    sys.exit(1)

CG = ctypes.CDLL(_lib_path)

# CGEventTypes
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
kCGEventNull = 0

# CGMouseButton
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1

# CGEventField
kCGMouseEventNumber = 0
kCGKeyboardEventKeycode = 9

# Virtual key codes
VK_MAP = {
    "RETURN": 0x24, "ENTER": 0x24, "TAB": 0x30, "SPACE": 0x31,
    "DELETE": 0x33, "BACKSPACE": 0x33, "ESCAPE": 0x35, "ESC": 0x35,
    "COMMAND": 0x37, "CMD": 0x37, "SHIFT": 0x38, "CAPSLOCK": 0x39,
    "OPTION": 0x3A, "ALT": 0x3A, "CONTROL": 0x3B, "CTRL": 0x3B,
    "RIGHT_SHIFT": 0x3C, "RIGHT_OPTION": 0x3D, "RIGHT_CONTROL": 0x3E,
    "UP": 0x7E, "DOWN": 0x7D, "LEFT": 0x7B, "RIGHT": 0x7C,
    "F1": 0x7A, "F2": 0x78, "F3": 0x76, "F4": 0x72,
    "F5": 0x70, "F6": 0x6D, "F7": 0x67, "F8": 0x6F,
    "F9": 0x6B, "F10": 0x71, "F11": 0x6A, "F12": 0x69,
    "HOME": 0x73, "END": 0x77, "PAGEUP": 0x74, "PAGEDOWN": 0x79,
    "FORWARDDELETE": 0x75, "HELP": 0x72,
}

# Modifier flags
MOD_FLAGS = {
    "CMD": 1 << 20, "COMMAND": 1 << 20,
    "SHIFT": 1 << 17,
    "ALT": 1 << 19, "OPTION": 1 << 19,
    "CTRL": 1 << 18, "CONTROL": 1 << 18,
}

# Nullable return type for CGEventCreateMouseEvent etc.
CG.CGEventCreateMouseEvent.restype = ctypes.c_void_p
CG.CGEventCreateMouseEvent.argtypes = [
    ctypes.c_void_p,  # source (nullable)
    ctypes.c_uint32,  # type
    ctypes.c_int32,   # x (CGPoint.x as int32 on 64-bit is fine for coordinates)
    ctypes.c_uint32,  # button
]
CG.CGEventPost.restype = None
CG.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
CG.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
CG.CGEventCreateKeyboardEvent.argtypes = [
    ctypes.c_void_p, ctypes.c_uint16, ctypes.c_bool,
]
CG.CGEventSetFlags.restype = None
CG.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
CG.CGEventSetType.restype = None
CG.CGEventSetType.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
CG.CGEventSetIntegerValueField.restype = None
CG.CGEventSetIntegerValueField.argtypes = [
    ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int64,
]
CG.CGEventGetLocation.restype = ctypes.c_void_p  # returns CGPoint
CG.CGEventGetLocation.argtypes = [ctypes.c_void_p]

# kCGHIDEventTap = 0
kCGHIDEventTap = 0


def _point_from_ints(x, y):
    """Pack x, y into a CGPoint-like 2-int64 struct for 64-bit macOS."""
    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
    return CGPoint(x, y)


def _post_event(event_type, x, y, button=kCGMouseButtonLeft):
    """Create and post a mouse event."""
    pt = _point_from_ints(float(x), float(y))
    # CGEventCreateMouseEvent takes CGPoint directly in the struct
    # but ctypes passes int args — need to use a different approach
    # Re-configure argtypes for the CGPoint variant
    original_argtypes = CG.CGEventCreateMouseEvent.argtypes
    try:
        class CGPoint(ctypes.Structure):
            _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]
        CG.CGEventCreateMouseEvent.argtypes = [
            ctypes.c_void_p, ctypes.c_uint32, CGPoint, ctypes.c_uint32,
        ]
        event = CG.CGEventCreateMouseEvent(None, event_type, pt, button)
    finally:
        CG.CGEventCreateMouseEvent.argtypes = original_argtypes

    if event:
        CG.CGEventPost(kCGHIDEventTap, event)
        return True
    return False


def _get_scale_factor():
    """Get the main screen's backing scale factor."""
    try:
        app_kit = ctypes.CDLL(ctypes.util.find_library("AppKit"))
        # Use NSScreen.mainScreen.backingScaleFactor
        # This is complex via ctypes, fall back to system_profiler
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10,
        )
        if "Retina" in result.stdout:
            return 2.0
    except Exception:
        pass
    # Default: check if UI scale is 2x via defaults
    try:
        result = subprocess.run(
            ["defaults", "read", "NSGlobalDomain", "AppleDisplayScaleFactor"],
            capture_output=True, text=True, timeout=5,
        )
        scale = float(result.stdout.strip())
        if scale > 0:
            return scale
    except Exception:
        pass
    return 2.0  # Modern Macs default to Retina


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_scale(args):
    """Return display scale factor for coordinate conversion."""
    scale = _get_scale_factor()
    print(json.dumps({"scale_factor": scale, "note": "Divide screenshot pixel coords by this to get CGEvent coords"}))


def cmd_screenshot(args):
    """Take a screenshot using macOS screencapture."""
    output = args.output or os.path.join(tempfile.gettempdir(), f"screenshot_{int(time.time())}.png")

    cmd = ["screencapture", "-x"]  # -x = no sound
    if args.region:
        cmd.extend(["-R", args.region])
    cmd.append(output)

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
    if result.returncode != 0:
        print(json.dumps({"error": f"screencapture failed: {result.stderr}"}))
        sys.exit(1)

    print(json.dumps({
        "success": True,
        "path": output,
        "note": "Pixel coordinates in this image should be divided by scale_factor for CGEvent input",
    }))


def cmd_click(args):
    """Click at (x, y) using CGEvent."""
    x, y = args.x, args.y
    button = kCGMouseButtonRight if args.button == "right" else kCGMouseButtonLeft
    down = kCGEventRightMouseDown if args.button == "right" else kCGEventLeftMouseDown
    up = kCGEventRightMouseUp if args.button == "right" else kCGEventLeftMouseUp

    _post_event(down, x, y, button)
    time.sleep(0.02)
    _post_event(up, x, y, button)

    if args.double:
        time.sleep(0.05)
        _post_event(down, x, y, button)
        time.sleep(0.02)
        _post_event(up, x, y, button)

    print(json.dumps({"success": True, "action": "double_click" if args.double else "click", "x": x, "y": y}))


def cmd_move(args):
    """Move mouse to (x, y)."""
    _post_event(kCGEventMouseMoved, args.x, args.y)
    print(json.dumps({"success": True, "action": "move", "x": args.x, "y": args.y}))


def cmd_drag(args):
    """Drag from (x1,y1) to (x2,y2)."""
    duration = (args.duration or 300) / 1000.0  # ms to seconds
    _post_event(kCGEventLeftMouseDown, args.x1, args.y1)
    steps = max(10, int(duration / 0.01))
    for i in range(1, steps + 1):
        t = i / steps
        cx = args.x1 + (args.x2 - args.x1) * t
        cy = args.y1 + (args.y2 - args.y1) * t
        _post_event(kCGEventLeftMouseDragged, int(cx), int(cy))
        time.sleep(duration / steps)
    _post_event(kCGEventLeftMouseUp, args.x2, args.y2)
    print(json.dumps({"success": True, "action": "drag", "from": [args.x1, args.y1], "to": [args.x2, args.y2]}))


def cmd_type(args):
    """Type text using clipboard paste (supports Chinese/CJK/emoji)."""
    text = args.text

    # Save current clipboard
    old_clipboard = ""
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=5)
        old_clipboard = result.stdout
    except Exception:
        pass

    # Set clipboard to text
    subprocess.run(["pbcopy"], input=text, text=True, timeout=5)

    # Small delay for clipboard to settle
    time.sleep(0.05)

    # Simulate Cmd+V
    event = CG.CGEventCreateKeyboardEvent(None, VK_MAP["CMD"], True)
    CG.CGEventSetFlags(event, ctypes.c_uint64(MOD_FLAGS["CMD"]))
    CG.CGEventPost(kCGHIDEventTap, event)

    v_event = CG.CGEventCreateKeyboardEvent(None, 9, True)  # V key = keycode 9
    CG.CGEventSetFlags(v_event, ctypes.c_uint64(MOD_FLAGS["CMD"]))
    CG.CGEventPost(kCGHIDEventTap, v_event)

    v_up = CG.CGEventCreateKeyboardEvent(None, 9, False)
    CG.CGEventSetFlags(v_up, ctypes.c_uint64(MOD_FLAGS["CMD"]))
    CG.CGEventPost(kCGHIDEventTap, v_up)

    cmd_up = CG.CGEventCreateKeyboardEvent(None, VK_MAP["CMD"], False)
    CG.CGEventPost(kCGHIDEventTap, cmd_up)

    time.sleep(0.1)

    # Restore clipboard
    try:
        subprocess.run(["pbcopy"], input=old_clipboard, text=True, timeout=5)
    except Exception:
        pass

    print(json.dumps({"success": True, "action": "type", "length": len(text)}))


def cmd_key(args):
    """Press a key with optional modifiers."""
    key_name = args.key.upper()
    if key_name not in VK_MAP:
        print(json.dumps({"error": f"Unknown key: {args.key}. Available: {', '.join(sorted(VK_MAP.keys()))}"}))
        sys.exit(1)

    keycode = VK_MAP[key_name]
    flags = 0
    if args.modifier:
        for mod in args.modifier.split(","):
            mod = mod.strip().upper()
            if mod in MOD_FLAGS:
                flags |= MOD_FLAGS[mod]

    # Key down
    event = CG.CGEventCreateKeyboardEvent(None, keycode, True)
    if flags:
        CG.CGEventSetFlags(event, ctypes.c_uint64(flags))
    CG.CGEventPost(kCGHIDEventTap, event)

    time.sleep(0.02)

    # Key up
    event = CG.CGEventCreateKeyboardEvent(None, keycode, False)
    if flags:
        CG.CGEventSetFlags(event, ctypes.c_uint64(flags))
    CG.CGEventPost(kCGHIDEventTap, event)

    mods = args.modifier or "none"
    print(json.dumps({"success": True, "action": "key", "key": args.key, "modifiers": mods}))


def cmd_windows(args):
    """Get window info using AppleScript."""
    if args.app:
        script = f'''
        tell application "System Events"
            set p to process "{args.app}"
            set winList to {{}}
            repeat with w in windows of p
                set end of winList to {{name:name of w, position:position of w, size:size of w}}
            end repeat
            return winList
        end tell
        '''
    else:
        script = '''
        tell application "System Events"
            set winList to {}
            repeat with p in processes
                if visible of p then
                    repeat with w in windows of p
                        set end of winList to {process:name of p, name:name of w, position:position of w, size:size of w}
                    end repeat
                end if
            end repeat
            return winList
        end tell
        '''

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        print(json.dumps({"error": f"AppleScript failed: {result.stderr.strip()}"}))
        sys.exit(1)

    # Parse osascript output
    print(json.dumps({"success": True, "raw_output": result.stdout.strip()}))


def cmd_activate(args):
    """Bring an application to front."""
    script = f'''
    tell application "{args.app}"
        activate
    end tell
    '''
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=10,
    )
    if result.returncode != 0:
        print(json.dumps({"error": f"Failed to activate {args.app}: {result.stderr.strip()}"}))
        sys.exit(1)

    time.sleep(0.3)  # Wait for app to come to front
    print(json.dumps({"success": True, "action": "activate", "app": args.app}))


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="macOS screen control via CGEvent")
    sub = parser.add_subparsers(dest="command", required=True)

    # screenshot
    p = sub.add_parser("screenshot", help="Take a screenshot")
    p.add_argument("--output", help="Output file path")
    p.add_argument("--region", help="Region as X,Y,W,H")

    # click
    p = sub.add_parser("click", help="Click at coordinates")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)
    p.add_argument("--button", choices=["left", "right"], default="left")
    p.add_argument("--double", action="store_true", help="Double click")

    # move
    p = sub.add_parser("move", help="Move mouse")
    p.add_argument("x", type=int)
    p.add_argument("y", type=int)

    # drag
    p = sub.add_parser("drag", help="Drag from A to B")
    p.add_argument("x1", type=int)
    p.add_argument("y1", type=int)
    p.add_argument("x2", type=int)
    p.add_argument("y2", type=int)
    p.add_argument("--duration", type=int, default=300, help="Duration in ms")

    # type
    p = sub.add_parser("type", help="Type text (clipboard paste, supports CJK)")
    p.add_argument("text")

    # key
    p = sub.add_parser("key", help="Press a key with optional modifiers")
    p.add_argument("key")
    p.add_argument("--modifier", help="Comma-separated: CMD,SHIFT,ALT,CTRL")

    # scale
    sub.add_parser("scale", help="Get display scale factor")

    # windows
    p = sub.add_parser("windows", help="List windows")
    p.add_argument("--app", help="Filter by app name")

    # activate
    p = sub.add_parser("activate", help="Bring app to front")
    p.add_argument("app")

    args = parser.parse_args()

    commands = {
        "screenshot": cmd_screenshot,
        "click": cmd_click,
        "move": cmd_move,
        "drag": cmd_drag,
        "type": cmd_type,
        "key": cmd_key,
        "scale": cmd_scale,
        "windows": cmd_windows,
        "activate": cmd_activate,
    }

    commands[args.command](args)


if __name__ == "__main__":
    main()
