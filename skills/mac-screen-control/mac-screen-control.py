#!/usr/bin/env python3
"""
mac-screen-control.py — macOS screen/keyboard/mouse control via CGEvent and Accessibility API.

No external dependencies. Uses only stdlib + ctypes for CoreGraphics calls.

Usage:
    python3 mac-screen-control.py screenshot [--output path] [--region x,y,w,h]
    python3 mac-screen-control.py click --x X --y Y [--button left|right|middle] [--double]
    python3 mac-screen-control.py move --x X --y Y
    python3 mac-screen-control.py drag --from-x X1 --from-y Y1 --to-x X2 --to-y Y2
    python3 mac-screen-control.py type --text "some text"
    python3 mac-screen-control.py key --key keyname [--modifiers cmd,shift,...]
    python3 mac-screen-control.py window --app "App Name" [--activate] [--bounds]
    python3 mac-screen-control.py find-element --app "App" --role ROLE [--name NAME] [--value VALUE]
    python3 mac-screen-control.py calibrate

Exit codes:
    0 — success (JSON output on stdout)
    1 — error (error message on stderr)
"""

import argparse
import json
import subprocess
import sys
import time
from typing import Any

# ---------------------------------------------------------------------------
# Platform check
# ---------------------------------------------------------------------------

if sys.platform != "darwin":
    print("ERROR: mac-screen-control only works on macOS", file=sys.stderr)
    sys.exit(1)

# ---------------------------------------------------------------------------
# CGEvent bindings via ctypes
# ---------------------------------------------------------------------------

import ctypes
import ctypes.util

lib = ctypes.CDLL(ctypes.util.find_library("ApplicationServices"))
libc = ctypes.CDLL(ctypes.util.find_library("c"))

# CGEvent types
CGEventRef = ctypes.c_void_p
CGEventSourceRef = ctypes.c_void_p
CGCharCode = ctypes.c_uint16
CGKeyCode = ctypes.c_uint16

# Event types
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventLeftMouseDragged = 6
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventRightMouseDragged = 7
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26
kCGEventMouseMoved = 5
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagsChanged = 12

# Mouse buttons
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGMouseButtonMiddle = 2

# Event fields
kCGMouseEventButtonNumber = 0
kCGMouseEventClickState = 1
kCGKeyboardEventKeycode = 9

# Event source state IDs
kCGEventSourceStateHIDSystemState = 1

# Modifier flags
kCGEventFlagMaskCommand = 0x00100000
kCGEventFlagMaskShift = 0x00020000
kCGEventFlagMaskControl = 0x00040000
kCGEventFlagMaskAlternate = 0x00080000

# CoreGraphics functions
lib.CGEventCreate.argtypes = [CGEventSourceRef]
lib.CGEventCreate.restype = CGEventRef

lib.CGEventCreateMouseEvent.argtypes = [
    CGEventSourceRef, ctypes.c_uint32,
    ctypes.c_double, ctypes.c_double, ctypes.c_uint32,
]
lib.CGEventCreateMouseEvent.restype = CGEventRef

lib.CGEventCreateKeyboardEvent.argtypes = [
    CGEventSourceRef, ctypes.c_uint16, ctypes.c_bool,
]
lib.CGEventCreateKeyboardEvent.restype = CGEventRef

lib.CGEventPost.argtypes = [ctypes.c_uint32, CGEventRef]
lib.CGEventPost.restype = None

lib.CGEventSetType.argtypes = [CGEventRef, ctypes.c_uint32]
lib.CGEventSetType.restype = None

lib.CGEventSetIntegerValueField.argtypes = [
    CGEventRef, ctypes.c_uint32, ctypes.c_int64,
]
lib.CGEventSetIntegerValueField.restype = None

lib.CGEventSetFlags.argtypes = [CGEventRef, ctypes.c_uint64]
lib.CGEventSetFlags.restype = None

lib.CGEventGetLocation.argtypes = [CGEventRef]
# CGPoint is two doubles
class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

lib.CGEventGetLocation.restype = CGPoint

lib.CGEventSourceCreate.argtypes = [ctypes.c_uint32]
lib.CGEventSourceCreate.restype = CGEventSourceRef

# CoreDisplay for screen size
core_graphics = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
if not core_graphics:
    core_graphics = lib

# Try to get main display ID and size
try:
    core_graphics.CGMainDisplayID.argtypes = []
    core_graphics.CGMainDisplayID.restype = ctypes.c_uint32
    core_graphics.CGDisplayPixelsWide.argtypes = [ctypes.c_uint32]
    core_graphics.CGDisplayPixelsWide.restype = ctypes.c_uint64
    core_graphics.CGDisplayPixelsHigh.argtypes = [ctypes.c_uint32]
    core_graphics.CGDisplayPixelsHigh.restype = ctypes.c_uint64
    HAS_DISPLAY_FUNCS = True
except Exception:
    HAS_DISPLAY_FUNCS = False

# Cocoa for backingScaleFactor
try:
    objc = ctypes.CDLL(ctypes.util.find_library("objc"))
    objc.objc_getClass.argtypes = [ctypes.c_char_p]
    objc.objc_getClass.restype = ctypes.c_void_p
    objc.sel_registerName.argtypes = [ctypes.c_char_p]
    objc.sel_registerName.restype = ctypes.c_void_p

    def _objc_msg_send(obj, sel, *args):
        """Send a message to an Objective-C object."""
        argtypes = []
        for a in args:
            if isinstance(a, int):
                argtypes.append(ctypes.c_void_p)
            elif isinstance(a, float):
                argtypes.append(ctypes.c_double)
            else:
                argtypes.append(ctypes.c_void_p)

        # Use objc_msgSend for simple returns, objc_msgSend_fpret for float/double
        if argtypes and argtypes[-1] == ctypes.c_double:
            objc.objc_msgSend_fpret.argtypes = [ctypes.c_void_p, ctypes.c_void_p] + argtypes
            objc.objc_msgSend_fpret.restype = ctypes.c_double
            return objc.objc_msgSend_fpret(obj, sel, *args)
        else:
            objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p] + argtypes
            objc.objc_msgSend.restype = ctypes.c_void_p
            return objc.objc_msgSend(obj, sel, *args)

    HAS_OBJC = True
except Exception:
    HAS_OBJC = False

# ---------------------------------------------------------------------------
# Key code mapping
# ---------------------------------------------------------------------------

KEY_MAP: dict[str, int] = {
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
    "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
    "command": 0x37, "cmd": 0x37, "shift": 0x38, "capslock": 0x39,
    "option": 0x3A, "alt": 0x3A, "control": 0x3B, "ctrl": 0x3B,
    "rightcommand": 0x36, "rightcmd": 0x36,
    "rightshift": 0x3C, "rightoption": 0x3D, "rightalt": 0x3D,
    "rightcontrol": 0x3E, "rightctrl": 0x3E,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "forwarddelete": 0x75, "help": 0x72, "insert": 0x72,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    # Letters
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E,
    "f": 0x03, "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26,
    "k": 0x28, "l": 0x25, "m": 0x2E, "n": 0x2D, "o": 0x1F,
    "p": 0x23, "q": 0x0C, "r": 0x0F, "s": 0x01, "t": 0x11,
    "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07, "y": 0x10,
    "z": 0x06,
    # Numbers
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
    # Symbols
    "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
    ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
    "`": 0x32,
}

MODIFIER_FLAG_MAP: dict[str, int] = {
    "cmd": kCGEventFlagMaskCommand,
    "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "ctrl": kCGEventFlagMaskControl,
    "control": kCGEventFlagMaskControl,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
}

# HID event tap location
kCGHIDEventTap = 0

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

_event_source = None

def get_event_source() -> CGEventSourceRef:
    global _event_source
    if _event_source is None:
        _event_source = lib.CGEventSourceCreate(kCGEventSourceStateHIDSystemState)
        if _event_source is None:
            print("ERROR: Cannot create CGEvent source. Check Accessibility permissions.",
                  file=sys.stderr)
            sys.exit(1)
    return _event_source


def get_screen_size() -> dict[str, int]:
    """Get main screen size in logical points."""
    if HAS_DISPLAY_FUNCS:
        try:
            display_id = core_graphics.CGMainDisplayID()
            width = core_graphics.CGDisplayPixelsWide(display_id)
            height = core_graphics.CGDisplayPixelsHigh(display_id)
            scale = get_scale_factor()
            return {"width": int(width / scale), "height": int(height / scale)}
        except Exception:
            pass
    # Fallback: use system_profiler or defaults
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10,
        )
        for line in result.stdout.splitlines():
            if "Resolution" in line:
                parts = line.split(":")[1].strip().split(" x ")
                return {"width": int(parts[0].strip()), "height": int(parts[1].strip())}
    except Exception:
        pass
    return {"width": 1440, "height": 900}


def get_scale_factor() -> float:
    """Get the Retina backing scale factor (1.0 or 2.0)."""
    if HAS_OBJC:
        try:
            ns_screen_class = objc.objc_getClass(b"NSScreen")
            screens = _objc_msg_send(ns_screen_class, objc.sel_registerName(b"screens"))
            main_screen = _objc_msg_send(screens, objc.sel_registerName(b"objectAtIndex:"), 0)
            scale = _objc_msg_send(main_screen, objc.sel_registerName(b"backingScaleFactor"))
            return float(scale)
        except Exception:
            pass
    # Fallback: check if screen capture at 2x
    return 2.0  # Default assumption for modern Macs


def validate_coordinates(x: float, y: float) -> None:
    """Check that coordinates are within screen bounds."""
    screen = get_screen_size()
    if x < 0 or y < 0:
        print(f"ERROR: Coordinates ({x}, {y}) are negative", file=sys.stderr)
        sys.exit(1)
    if x > screen["width"] or y > screen["height"]:
        print(
            f"ERROR: Coordinates ({x}, {y}) are outside screen bounds "
            f"({screen['width']}x{screen['height']})",
            file=sys.stderr,
        )
        sys.exit(1)


def output_json(data: dict[str, Any]) -> None:
    """Print JSON result to stdout."""
    print(json.dumps(data, ensure_ascii=False, indent=2))


# ---------------------------------------------------------------------------
# Command implementations
# ---------------------------------------------------------------------------

def cmd_screenshot(args: argparse.Namespace) -> None:
    """Take a screenshot using macOS screencapture."""
    output_path = args.output or "/tmp/screenshot.png"

    cmd = ["screencapture", "-x"]
    if args.region:
        try:
            parts = [float(p) for p in args.region.split(",")]
            if len(parts) != 4:
                raise ValueError("Need exactly 4 values: x,y,w,h")
            x, y, w, h = parts
            cmd.extend(["-R", f"{x},{y},{w},{h}"])
        except ValueError as e:
            print(f"ERROR: Invalid region format: {e}. Use x,y,w,h", file=sys.stderr)
            sys.exit(1)

    cmd.append(output_path)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            print(f"ERROR: screencapture failed: {result.stderr}", file=sys.stderr)
            sys.exit(1)
        output_json({"success": True, "path": output_path})
    except FileNotFoundError:
        print("ERROR: screencapture command not found (not macOS?)", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print("ERROR: screencapture timed out", file=sys.stderr)
        sys.exit(1)


def cmd_click(args: argparse.Namespace) -> None:
    """Perform a mouse click at the specified coordinates."""
    x, y = float(args.x), float(args.y)
    validate_coordinates(x, y)

    button_map = {"left": kCGMouseButtonLeft, "right": kCGMouseButtonRight, "middle": kCGMouseButtonMiddle}
    button = button_map.get(args.button, kCGMouseButtonLeft)

    # Map button to event types
    if button == kCGMouseButtonLeft:
        down_event = kCGEventLeftMouseDown
        up_event = kCGEventLeftMouseUp
        drag_event = kCGEventLeftMouseDragged
    elif button == kCGMouseButtonRight:
        down_event = kCGEventRightMouseDown
        up_event = kCGEventRightMouseUp
        drag_event = kCGEventRightMouseDragged
    else:
        down_event = kCGEventOtherMouseDown
        up_event = kCGEventOtherMouseUp
        drag_event = kCGEventOtherMouseDown  # fallback

    source = get_event_source()
    click_count = 2 if args.double else 1

    # Move to position first
    move_event = lib.CGEventCreateMouseEvent(source, kCGEventMouseMoved, x, y, button)
    lib.CGEventPost(kCGHIDEventTap, move_event)

    # Click down
    event = lib.CGEventCreateMouseEvent(source, down_event, x, y, button)
    lib.CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.01)

    # Click up
    event = lib.CGEventCreateMouseEvent(source, up_event, x, y, button)
    lib.CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_count)
    lib.CGEventPost(kCGHIDEventTap, event)

    action = "double-click" if args.double else "click"
    output_json({"success": True, "action": action, "x": x, "y": y, "button": args.button})


def cmd_move(args: argparse.Namespace) -> None:
    """Move the mouse cursor to the specified coordinates."""
    x, y = float(args.x), float(args.y)
    validate_coordinates(x, y)

    source = get_event_source()
    event = lib.CGEventCreateMouseEvent(source, kCGEventMouseMoved, x, y, kCGMouseButtonLeft)
    lib.CGEventPost(kCGHIDEventTap, event)

    output_json({"success": True, "action": "move", "x": x, "y": y})


def cmd_drag(args: argparse.Namespace) -> None:
    """Drag from one point to another."""
    x1, y1 = float(args.from_x), float(args.from_y)
    x2, y2 = float(args.to_x), float(args.to_y)
    validate_coordinates(x1, y1)
    validate_coordinates(x2, y2)

    source = get_event_source()

    # Move to start
    event = lib.CGEventCreateMouseEvent(source, kCGEventMouseMoved, x1, y1, kCGMouseButtonLeft)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.05)

    # Mouse down
    event = lib.CGEventCreateMouseEvent(source, kCGEventLeftMouseDown, x1, y1, kCGMouseButtonLeft)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.05)

    # Drag
    event = lib.CGEventCreateMouseEvent(source, kCGEventLeftMouseDragged, x2, y2, kCGMouseButtonLeft)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.05)

    # Mouse up
    event = lib.CGEventCreateMouseEvent(source, kCGEventLeftMouseUp, x2, y2, kCGMouseButtonLeft)
    lib.CGEventPost(kCGHIDEventTap, event)

    output_json({"success": True, "action": "drag", "from": {"x": x1, "y": y1}, "to": {"x": x2, "y": y2}})


def cmd_type(args: argparse.Namespace) -> None:
    """Type text, supporting CJK characters via clipboard paste."""
    text = args.text
    if not text:
        print("ERROR: --text is required and cannot be empty", file=sys.stderr)
        sys.exit(1)

    # Check if text contains non-ASCII characters
    has_non_ascii = any(ord(c) > 127 for c in text)

    if has_non_ascii:
        # Use clipboard paste method for CJK / special characters
        _type_via_clipboard(text)
    else:
        # For ASCII-only text, use CGEvent keystroke injection
        _type_via_cgevent(text)

    output_json({"success": True, "action": "type", "length": len(text)})


def _type_via_clipboard(text: str) -> None:
    """Type text by saving to clipboard and pasting (Cmd+V).

    This handles CJK characters, emoji, and special characters that
    CGEvent cannot inject directly.
    """
    source = get_event_source()

    # Save current clipboard
    try:
        old_clipboard = subprocess.run(
            ["pbpaste"], capture_output=True, text=True, timeout=5,
        ).stdout
    except Exception:
        old_clipboard = ""

    # Copy new text to clipboard
    subprocess.run(["pbcopy"], input=text, text=True, timeout=5)

    time.sleep(0.05)

    # Simulate Cmd+V
    cmd_keycode = KEY_MAP["cmd"]
    v_keycode = KEY_MAP["v"]

    # Cmd down
    event = lib.CGEventCreateKeyboardEvent(source, cmd_keycode, True)
    lib.CGEventSetFlags(event, kCGEventFlagMaskCommand)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.02)

    # V down
    event = lib.CGEventCreateKeyboardEvent(source, v_keycode, True)
    lib.CGEventSetFlags(event, kCGEventFlagMaskCommand)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.02)

    # V up
    event = lib.CGEventCreateKeyboardEvent(source, v_keycode, False)
    lib.CGEventSetFlags(event, kCGEventFlagMaskCommand)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.02)

    # Cmd up
    event = lib.CGEventCreateKeyboardEvent(source, cmd_keycode, False)
    lib.CGEventPost(kCGHIDEventTap, event)

    time.sleep(0.1)

    # Restore old clipboard
    try:
        subprocess.run(["pbcopy"], input=old_clipboard, text=True, timeout=5)
    except Exception:
        pass


def _type_via_cgevent(text: str) -> None:
    """Type ASCII text character by character via CGEvent."""
    source = get_event_source()

    for char in text:
        # Find the key code for this character
        key_lower = char.lower()
        shift_needed = char.isupper() or char in '!@#$%^&*()_+{}|:"<>?~'

        keycode = KEY_MAP.get(key_lower) or KEY_MAP.get(char)
        if keycode is None:
            # Fallback: use clipboard for unknown characters
            _type_via_clipboard(char)
            continue

        flags = kCGEventFlagMaskShift if shift_needed else 0

        # Key down
        event = lib.CGEventCreateKeyboardEvent(source, keycode, True)
        if flags:
            lib.CGEventSetFlags(event, flags)
        lib.CGEventPost(kCGHIDEventTap, event)
        time.sleep(0.005)

        # Key up
        event = lib.CGEventCreateKeyboardEvent(source, keycode, False)
        if flags:
            lib.CGEventSetFlags(event, flags)
        lib.CGEventPost(kCGHIDEventTap, event)
        time.sleep(0.005)


def cmd_key(args: argparse.Namespace) -> None:
    """Press a key, optionally with modifiers."""
    key_name = args.key.lower()
    keycode = KEY_MAP.get(key_name)
    if keycode is None:
        print(f"ERROR: Unknown key '{args.key}'. Available keys: {', '.join(sorted(KEY_MAP.keys()))}",
              file=sys.stderr)
        sys.exit(1)

    source = get_event_source()

    # Parse modifiers
    modifier_flags = 0
    modifier_keycodes = []
    if args.modifiers:
        for mod in args.modifiers.split(","):
            mod = mod.strip().lower()
            flag = MODIFIER_FLAG_MAP.get(mod)
            mod_keycode = KEY_MAP.get(mod)
            if flag is not None:
                modifier_flags |= flag
            if mod_keycode is not None:
                modifier_keycodes.append(mod_keycode)

    # Press modifier keys
    for kc in modifier_keycodes:
        event = lib.CGEventCreateKeyboardEvent(source, kc, True)
        lib.CGEventPost(kCGHIDEventTap, event)
        time.sleep(0.01)

    # Press the main key
    event = lib.CGEventCreateKeyboardEvent(source, keycode, True)
    if modifier_flags:
        lib.CGEventSetFlags(event, modifier_flags)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.01)

    # Release the main key
    event = lib.CGEventCreateKeyboardEvent(source, keycode, False)
    if modifier_flags:
        lib.CGEventSetFlags(event, modifier_flags)
    lib.CGEventPost(kCGHIDEventTap, event)
    time.sleep(0.01)

    # Release modifier keys (reverse order)
    for kc in reversed(modifier_keycodes):
        event = lib.CGEventCreateKeyboardEvent(source, kc, False)
        lib.CGEventPost(kCGHIDEventTap, event)
        time.sleep(0.01)

    output_json({
        "success": True,
        "action": "key",
        "key": key_name,
        "modifiers": args.modifiers.split(",") if args.modifiers else [],
    })


def cmd_window(args: argparse.Namespace) -> None:
    """Get window info or activate an application."""
    app_name = args.app
    if not app_name:
        print("ERROR: --app is required", file=sys.stderr)
        sys.exit(1)

    result: dict[str, Any] = {"success": True, "app": app_name}

    if args.activate:
        # Activate (bring to front) the application
        script = f'''
        tell application "{app_name}"
            activate
        end tell
        '''
        try:
            subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=10,
            )
            result["activated"] = True
        except subprocess.TimeoutExpired:
            result["activated"] = False
            result["error"] = "Timeout activating application"
        except Exception as e:
            result["activated"] = False
            result["error"] = str(e)

    if args.bounds:
        # Get window bounds
        script = f'''
        tell application "System Events"
            tell process "{app_name}"
                set frontWin to front window
                set b to bounds of frontWin
                return (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b)
            end tell
        end tell
        '''
        try:
            proc = subprocess.run(
                ["osascript", "-e", script],
                capture_output=True, text=True, timeout=10,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                parts = [float(p.strip()) for p in proc.stdout.strip().split(",")]
                if len(parts) == 4:
                    result["bounds"] = {
                        "x": parts[0], "y": parts[1],
                        "width": parts[2] - parts[0],
                        "height": parts[3] - parts[1],
                    }
                else:
                    result["bounds_error"] = f"Unexpected output: {proc.stdout.strip()}"
            else:
                result["bounds_error"] = proc.stderr.strip() or "Unknown error"
        except subprocess.TimeoutExpired:
            result["bounds_error"] = "Timeout getting window bounds"
        except Exception as e:
            result["bounds_error"] = str(e)

    output_json(result)


def cmd_find_element(args: argparse.Namespace) -> None:
    """Find UI elements via Accessibility API."""
    app_name = args.app
    if not app_name:
        print("ERROR: --app is required", file=sys.stderr)
        sys.exit(1)

    conditions = []
    if args.role:
        conditions.append(f'role is "{args.role}"')
    if args.name:
        conditions.append(f'name contains "{args.name}"')
    if args.value:
        conditions.append(f'value contains "{args.value}"')

    if not conditions:
        print("ERROR: At least one of --role, --name, or --value is required", file=sys.stderr)
        sys.exit(1)

    condition_str = " and ".join(conditions)

    # Build AppleScript to find elements
    script = f'''
    tell application "System Events"
        tell process "{app_name}"
            set frontWin to front window
            set allUI to every UI element of frontWin
            set results to {{}}
            repeat with elem in allUI
                try
                    set elemRole to role of elem
                    set elemName to name of elem
                    set elemValue to value of elem
                    set elemPos to position of elem
                    set elemSize to size of elem
                    set end of results to elemRole & "|" & elemName & "|" & elemValue & "|" & (item 1 of elemPos) & "," & (item 2 of elemPos) & "|" & (item 1 of elemSize) & "," & (item 2 of elemSize)
                end try
            end repeat
            return results
        end tell
    end tell
    '''

    try:
        proc = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, text=True, timeout=30,
        )
        if proc.returncode != 0:
            print(f"ERROR: {proc.stderr.strip()}", file=sys.stderr)
            sys.exit(1)

        elements = []
        for line in proc.stdout.strip().split(", "):
            parts = line.strip().split("|")
            if len(parts) >= 5:
                elem = {
                    "role": parts[0],
                    "name": parts[1] if len(parts) > 1 else "",
                    "value": parts[2] if len(parts) > 2 else "",
                    "position": parts[3] if len(parts) > 3 else "",
                    "size": parts[4] if len(parts) > 4 else "",
                }
                # Filter by conditions
                match = True
                if args.role and args.role.lower() not in elem["role"].lower():
                    match = False
                if args.name and args.name.lower() not in elem["name"].lower():
                    match = False
                if args.value and args.value.lower() not in elem["value"].lower():
                    match = False
                if match:
                    elements.append(elem)

        output_json({
            "success": True,
            "app": app_name,
            "elements": elements,
            "count": len(elements),
        })
    except subprocess.TimeoutExpired:
        print("ERROR: Timeout finding elements", file=sys.stderr)
        sys.exit(1)


def cmd_calibrate(args: argparse.Namespace) -> None:
    """Calibrate screen coordinate system."""
    scale = get_scale_factor()
    screen = get_screen_size()

    # Get current mouse position
    source = get_event_source()
    point = lib.CGEventGetLocation(None)
    mouse_x, mouse_y = point.x, point.y

    output_json({
        "success": True,
        "scale_factor": scale,
        "screen_logical": screen,
        "screen_physical": {
            "width": int(screen["width"] * scale),
            "height": int(screen["height"] * scale),
        },
        "current_mouse_position": {"x": mouse_x, "y": mouse_y},
        "notes": (
            "Coordinates in CGEvent are logical points (not Retina pixels). "
            "Screenshot images may be at physical resolution. "
            "To convert screenshot pixel coords to logical points: divide by scale_factor."
        ),
    })


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="macOS screen/keyboard/mouse control via CGEvent",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # screenshot
    p = subparsers.add_parser("screenshot", help="Take a screenshot")
    p.add_argument("--output", default="/tmp/screenshot.png", help="Output file path")
    p.add_argument("--region", help="Region x,y,w,h in logical points")

    # click
    p = subparsers.add_parser("click", help="Click at coordinates")
    p.add_argument("--x", required=True, type=float, help="X coordinate (logical points)")
    p.add_argument("--y", required=True, type=float, help="Y coordinate (logical points)")
    p.add_argument("--button", default="left", choices=["left", "right", "middle"])
    p.add_argument("--double", action="store_true", help="Double-click")

    # move
    p = subparsers.add_parser("move", help="Move mouse to coordinates")
    p.add_argument("--x", required=True, type=float, help="X coordinate")
    p.add_argument("--y", required=True, type=float, help="Y coordinate")

    # drag
    p = subparsers.add_parser("drag", help="Drag from one point to another")
    p.add_argument("--from-x", required=True, type=float, help="Start X")
    p.add_argument("--from-y", required=True, type=float, help="Start Y")
    p.add_argument("--to-x", required=True, type=float, help="End X")
    p.add_argument("--to-y", required=True, type=float, help="End Y")

    # type
    p = subparsers.add_parser("type", help="Type text (supports CJK)")
    p.add_argument("--text", required=True, help="Text to type")

    # key
    p = subparsers.add_parser("key", help="Press a key with optional modifiers")
    p.add_argument("--key", required=True, help="Key name (e.g. return, tab, c)")
    p.add_argument("--modifiers", help="Comma-separated modifiers (cmd,shift,alt,ctrl)")

    # window
    p = subparsers.add_parser("window", help="Window management")
    p.add_argument("--app", required=True, help="Application name")
    p.add_argument("--activate", action="store_true", help="Bring app to front")
    p.add_argument("--bounds", action="store_true", help="Get window bounds")

    # find-element
    p = subparsers.add_parser("find-element", help="Find UI elements via Accessibility API")
    p.add_argument("--app", required=True, help="Application name")
    p.add_argument("--role", help="Element role (e.g. button, text field)")
    p.add_argument("--name", help="Element name (substring match)")
    p.add_argument("--value", help="Element value (substring match)")

    # calibrate
    subparsers.add_parser("calibrate", help="Show screen calibration info")

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
        "window": cmd_window,
        "find-element": cmd_find_element,
        "calibrate": cmd_calibrate,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
