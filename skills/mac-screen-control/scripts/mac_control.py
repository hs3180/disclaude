#!/usr/bin/env python3
"""macOS screen control via CGEvent and Accessibility API.

Provides mouse, keyboard, screenshot, window management, and UI element
finding for desktop automation on macOS.

Usage:
    mac_control.py screenshot --output /tmp/screen.png [--x X --y Y --width W --height H]
    mac_control.py click --x X --y Y [--double] [--right]
    mac_control.py move --x X --y Y
    mac_control.py drag --from-x X --from-y Y --to-x X --to-y Y
    mac_control.py type --text "text to type"
    mac_control.py key --key KEY [--modifiers "cmd,shift"]
    mac_control.py window --app "App Name"
    mac_control.py activate --app "App Name"
    mac_control.py list-windows
    mac_control.py calibrate
    mac_control.py find-element --app "App Name" [--role ROLE] [--text TEXT]
"""

import argparse
import json
import subprocess
import sys
import time
import tempfile
import os

# Try importing Quartz (PyObjC). Fall back to ctypes if not available.
try:
    import Quartz
    HAS_QUARTZ = True
except ImportError:
    HAS_QUARTZ = False

HAS_QUARTZ = False  # Force ctypes path for zero-dependency usage

# --- CGEvent via ctypes ---

def _load_coregraphics():
    """Load CoreGraphics and HIToolbox frameworks via ctypes."""
    import ctypes
    import ctypes.util

    cg_path = ctypes.util.find_library("CoreGraphics")
    if not cg_path:
        raise RuntimeError("CoreGraphics not found — not on macOS?")

    cg = ctypes.cdll.LoadLibrary(cg_path)

    hitoolbox_path = ctypes.util.find_library("HIToolbox")
    if hitoolbox_path:
        hitoolbox = ctypes.cdll.LoadLibrary(hitoolbox_path)
    else:
        # Fallback: load from known location
        hitoolbox = ctypes.cdll.LoadLibrary(
            "/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox"
        )

    return cg, hitoolbox


def _get_cg():
    """Get CoreGraphics library handle (lazy loaded)."""
    if not hasattr(_get_cg, "_cg"):
        cg, hitoolbox = _load_coregraphics()
        _get_cg._cg = cg
        _get_cg._hitoolbox = hitoolbox
    return _get_cg._cg, _get_cg._hitoolbox


# --- Virtual key codes ---
KEY_CODES = {
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "escape": 0x35, "esc": 0x35,
    "delete": 0x33, "backspace": 0x33,
    "forwarddelete": 0x75,
    "space": 0x31,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
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
}

MODIFIER_FLAGS = {
    "command": 0x1000, "cmd": 0x1000,
    "shift": 0x200,
    "option": 0x800, "alt": 0x800,
    "control": 0x1000, "ctrl": 0x1000,
}

# kCGEventLeftMouseDown = 1, kCGEventLeftMouseUp = 2
# kCGEventRightMouseDown = 3, kCGEventRightMouseUp = 4
# kCGEventMouseMoved = 5, kCGEventLeftMouseDragged = 6
# kCGEventKeyDown = 10, kCGEventKeyUp = 11
# kCGEventFlagMaskCommand = 0x1000, etc.

CG_EVENT_TYPES = {
    "left_down": 1, "left_up": 2,
    "right_down": 3, "right_up": 4,
    "mouse_moved": 5, "left_dragged": 6,
    "key_down": 10, "key_up": 11,
    "flags_changed": 12,
}

CG_MOUSE_BUTTON_LEFT = 0
CG_MOUSE_BUTTON_RIGHT = 1


def _create_mouse_event(cg, event_type, x, y, button=CG_MOUSE_BUTTON_LEFT):
    """Create a CGEvent mouse event."""
    event = cg.CGEventCreateMouseEvent(None, event_type, (x, y), button)
    if event is None:
        raise RuntimeError(f"Failed to create mouse event at ({x}, {y})")
    return event


def _post_event(cg, event, tap_location=0):
    """Post a CGEvent to the event tap. tap_location=0 is HID (kCGHIDEventTap)."""
    cg.CGEventPost(tap_location, event)


# --- Screenshot ---

def cmd_screenshot(args):
    """Take a screenshot using the macOS screencapture command."""
    output = args.output
    cmd = ["screencapture", "-x"]  # -x = no sound

    if args.x is not None and args.y is not None:
        region = f"{args.x},{args.y},{args.width or 9999},{args.height or 9999}"
        cmd.extend(["-R", region])

    cmd.append(output)

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"success": False, "error": result.stderr.strip()}))
        sys.exit(1)

    print(json.dumps({"success": True, "output": output}))


# --- Mouse ---

def cmd_click(args):
    """Click at the given coordinates."""
    cg, _ = _get_cg()
    x, y = float(args.x), float(args.y)

    if args.right:
        down_type = CG_EVENT_TYPES["right_down"]
        up_type = CG_EVENT_TYPES["right_up"]
        button = CG_MOUSE_BUTTON_RIGHT
    else:
        down_type = CG_EVENT_TYPES["left_down"]
        up_type = CG_EVENT_TYPES["left_up"]
        button = CG_MOUSE_BUTTON_LEFT

    clicks = 2 if args.double else 1

    for _ in range(clicks):
        event = _create_mouse_event(cg, down_type, x, y, button)
        _post_event(cg, event)
        event = _create_mouse_event(cg, up_type, x, y, button)
        _post_event(cg, event)
        if clicks > 1:
            time.sleep(0.05)

    print(json.dumps({"success": True, "action": "click", "x": x, "y": y, "double": args.double, "right": args.right}))


def cmd_move(args):
    """Move mouse to coordinates without clicking."""
    cg, _ = _get_cg()
    x, y = float(args.x), float(args.y)

    event = _create_mouse_event(cg, CG_EVENT_TYPES["mouse_moved"], x, y)
    _post_event(cg, event)

    print(json.dumps({"success": True, "action": "move", "x": x, "y": y}))


def cmd_drag(args):
    """Drag from one point to another."""
    cg, _ = _get_cg()
    fx, fy = float(args.from_x), float(args.from_y)
    tx, ty = float(args.to_x), float(args.to_y)

    # Move to start
    event = _create_mouse_event(cg, CG_EVENT_TYPES["mouse_moved"], fx, fy)
    _post_event(cg, event)
    time.sleep(0.05)

    # Mouse down
    event = _create_mouse_event(cg, CG_EVENT_TYPES["left_down"], fx, fy)
    _post_event(cg, event)
    time.sleep(0.05)

    # Drag (interpolate for smoothness)
    steps = 20
    for i in range(1, steps + 1):
        cx = fx + (tx - fx) * i / steps
        cy = fy + (ty - fy) * i / steps
        event = _create_mouse_event(cg, CG_EVENT_TYPES["left_dragged"], cx, cy)
        _post_event(cg, event)
        time.sleep(0.01)

    # Mouse up
    event = _create_mouse_event(cg, CG_EVENT_TYPES["left_up"], tx, ty)
    _post_event(cg, event)

    print(json.dumps({"success": True, "action": "drag", "from": [fx, fy], "to": [tx, ty]}))


# --- Keyboard ---

def cmd_type(args):
    """Type text using clipboard-based injection (pbcopy + Cmd+V)."""
    text = args.text
    if not text:
        print(json.dumps({"success": False, "error": "No text provided"}))
        sys.exit(1)

    # Save current clipboard
    try:
        old_clipboard = subprocess.run(["pbpaste"], capture_output=True).stdout
    except Exception:
        old_clipboard = b""

    # Set clipboard content
    process = subprocess.run(["pbcopy"], input=text.encode("utf-8"), capture_output=True)
    if process.returncode != 0:
        print(json.dumps({"success": False, "error": "pbcopy failed"}))
        sys.exit(1)

    time.sleep(0.05)

    # Simulate Cmd+V
    cg, _ = _get_cg()
    cmd_flag = 0x1000  # kCGEventFlagMaskCommand
    v_keycode = KEY_CODES["v"]

    # Key down with Cmd
    event = cg.CGEventCreateKeyboardEvent(None, v_keycode, True)
    cg.CGEventSetFlags(event, cmd_flag)
    _post_event(cg, event)
    time.sleep(0.02)

    # Key up with Cmd
    event = cg.CGEventCreateKeyboardEvent(None, v_keycode, False)
    cg.CGEventSetFlags(event, cmd_flag)
    _post_event(cg, event)
    time.sleep(0.05)

    # Restore clipboard
    try:
        subprocess.run(["pbcopy"], input=old_clipboard, capture_output=True)
    except Exception:
        pass

    print(json.dumps({"success": True, "action": "type", "length": len(text)}))


def cmd_key(args):
    """Press a key, optionally with modifiers."""
    key_name = args.key.lower()
    keycode = KEY_CODES.get(key_name)
    if keycode is None:
        # Try single character
        if len(key_name) == 1:
            keycode = KEY_CODES.get(key_name)
        if keycode is None:
            print(json.dumps({"success": False, "error": f"Unknown key: {args.key}"}))
            sys.exit(1)

    cg, _ = _get_cg()

    # Calculate modifier flags
    flags = 0
    modifiers = []
    if args.modifiers:
        for mod in args.modifiers.split(","):
            mod = mod.strip().lower()
            if mod in MODIFIER_FLAGS:
                flags |= MODIFIER_FLAGS[mod]
                modifiers.append(mod)

    # Press modifier keys first (via flags_changed or just set flags on the event)
    # Key down
    event = cg.CGEventCreateKeyboardEvent(None, keycode, True)
    if flags:
        cg.CGEventSetFlags(event, flags)
    _post_event(cg, event)
    time.sleep(0.02)

    # Key up
    event = cg.CGEventCreateKeyboardEvent(None, keycode, False)
    if flags:
        cg.CGEventSetFlags(event, flags)
    _post_event(cg, event)

    print(json.dumps({"success": True, "action": "key", "key": args.key, "modifiers": modifiers}))


# --- Window Management ---

def cmd_window(args):
    """Get window bounds for an application."""
    app_name = args.app
    script = f'''
    tell application "System Events"
        set p to process "{app_name}"
        if exists p then
            set frontmost of p to true
            set winList to {{}}
            repeat with w in every window of p
                set winInfo to {{name:name of w, position:position of w, size:size of w}}
                set end of winList to winInfo
            end repeat
            return winList
        else
            return "NOT_FOUND"
        end if
    end tell
    '''

    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"success": False, "error": result.stderr.strip()}))
        sys.exit(1)

    output = result.stdout.strip()
    if output == "NOT_FOUND":
        print(json.dumps({"success": False, "error": f"Application '{app_name}' not found"}))
        sys.exit(1)

    # Parse AppleScript output
    windows = []
    try:
        # AppleScript returns: name of win, x, y, width, height, ...
        # Format varies; try to parse structured output
        parts = output.split(", ")
        # Simple heuristic: pairs of (name, position, size) groups
        # The output format is typically: windowName, x, y, width, height
        if len(parts) >= 4:
            i = 0
            while i < len(parts):
                try:
                    name = parts[i].strip()
                    x = int(float(parts[i + 1]))
                    y = int(float(parts[i + 2]))
                    w = int(float(parts[i + 3]))
                    h = int(float(parts[i + 4])) if i + 4 < len(parts) else 0
                    windows.append({
                        "name": name,
                        "x": x, "y": y,
                        "width": w, "height": h
                    })
                    i += 5
                except (ValueError, IndexError):
                    i += 1
    except Exception:
        windows = [{"raw": output}]

    print(json.dumps({"success": True, "app": app_name, "windows": windows}))


def cmd_activate(args):
    """Bring an application to the foreground."""
    app_name = args.app
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''

    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"success": False, "error": result.stderr.strip()}))
        sys.exit(1)

    time.sleep(0.3)  # Wait for app to come to foreground
    print(json.dumps({"success": True, "action": "activate", "app": app_name}))


def cmd_list_windows(args):
    """List all visible windows."""
    script = '''
    tell application "System Events"
        set output to ""
        repeat with p in every process whose visible is true
            try
                set pName to name of p
                repeat with w in every window of p
                    set wName to name of w
                    set wPos to position of w
                    set wSize to size of w
                    set output to output & pName & "|" & wName & "|" & (item 1 of wPos) & "," & (item 2 of wPos) & "|" & (item 1 of wSize) & "," & (item 2 of wSize) & linefeed
                end repeat
            end try
        end repeat
        return output
    end tell
    '''

    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"success": False, "error": result.stderr.strip()}))
        sys.exit(1)

    windows = []
    for line in result.stdout.strip().split("\n"):
        if not line.strip():
            continue
        parts = line.strip().split("|")
        if len(parts) >= 4:
            try:
                pos = parts[2].split(",")
                size = parts[3].split(",")
                windows.append({
                    "app": parts[0],
                    "window": parts[1],
                    "x": int(float(pos[0])),
                    "y": int(float(pos[1])),
                    "width": int(float(size[0])),
                    "height": int(float(size[1]))
                })
            except (ValueError, IndexError):
                continue

    print(json.dumps({"success": True, "windows": windows}))


# --- Calibration ---

def cmd_calibrate(args):
    """Get screen information including resolution and scale factor."""
    script = '''
    tell application "System Events"
        set output to ""
        repeat with s in every desktop
            set sName to name of s
            set sBounds to bounds of s
            set output to output & sName & "|" & (item 1 of sBounds) & "," & (item 2 of sBounds) & "|" & (item 3 of sBounds) & "," & (item 4 of sBounds) & linefeed
        end repeat
        return output
    end tell
    '''

    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    screens = []

    if result.returncode == 0:
        for line in result.stdout.strip().split("\n"):
            if not line.strip():
                continue
            parts = line.strip().split("|")
            if len(parts) >= 3:
                try:
                    origin = parts[1].split(",")
                    size = parts[2].split(",")
                    screens.append({
                        "name": parts[0],
                        "x": int(float(origin[0])),
                        "y": int(float(origin[1])),
                        "width": int(float(size[0])),
                        "height": int(float(size[1])),
                    })
                except (ValueError, IndexError):
                    continue

    # Try to detect Retina scaling
    try:
        dpi_result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True
        )
        # Look for Retina indicator
        for line in dpi_result.stdout.split("\n"):
            if "Retina" in line:
                for s in screens:
                    s["scaleFactor"] = 2
                break
        else:
            for s in screens:
                s["scaleFactor"] = 1
    except Exception:
        for s in screens:
            s.setdefault("scaleFactor", 1)

    if not screens:
        # Fallback: use system_profiler
        try:
            res_result = subprocess.run(
                ["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'],
                capture_output=True, text=True
            )
            if res_result.returncode == 0:
                parts = res_result.stdout.strip().split(", ")
                screens.append({
                    "width": int(float(parts[2])),
                    "height": int(float(parts[3])),
                    "scaleFactor": 1,
                    "primary": True
                })
        except Exception:
            pass

    print(json.dumps({
        "success": True,
        "screens": screens,
        "note": "CGEvent uses logical points (width x height). Screenshot pixels = logical * scaleFactor"
    }, indent=2))


# --- Accessibility API ---

def cmd_find_element(args):
    """Find UI elements using Accessibility API."""
    app_name = args.app

    if args.role and args.text:
        script = f'''
        tell application "System Events"
            set p to process "{app_name}"
            set results to {{}}
            set allElements to every UI element of entire contents of front window of p whose role description is "{args.role}" and value contains "{args.text}"
            repeat with e in allElements
                set ePos to position of e
                set eSize to size of e
                set eDesc to description of e
                set eRole to role of e
                set end of results to eRole & "|" & eDesc & "|" & (item 1 of ePos) & "," & (item 2 of ePos) & "|" & (item 1 of eSize) & "," & (item 2 of eSize)
            end repeat
            return results
        end tell
        '''
    elif args.role:
        script = f'''
        tell application "System Events"
            set p to process "{app_name}"
            set results to {{}}
            set allElements to every UI element of entire contents of front window of p whose role description is "{args.role}"
            repeat with e in allElements
                set ePos to position of e
                set eSize to size of e
                set eDesc to description of e
                set eRole to role of e
                set end of results to eRole & "|" & eDesc & "|" & (item 1 of ePos) & "," & (item 2 of ePos) & "|" & (item 1 of eSize) & "," & (item 2 of eSize)
            end repeat
            return results
        end tell
        '''
    elif args.text:
        script = f'''
        tell application "System Events"
            set p to process "{app_name}"
            set results to {{}}
            set allElements to every UI element of entire contents of front window of p whose value contains "{args.text}"
            repeat with e in allElements
                set ePos to position of e
                set eSize to size of e
                set eDesc to description of e
                set eRole to role of e
                set end of results to eRole & "|" & eDesc & "|" & (item 1 of ePos) & "," & (item 2 of ePos) & "|" & (item 1 of eSize) & "," & (item 2 of eSize)
            end repeat
            return results
        end tell
        '''
    else:
        print(json.dumps({"success": False, "error": "Provide --role or --text (or both)"}))
        sys.exit(1)

    result = subprocess.run(["osascript", "-e", script], capture_output=True, text=True)
    if result.returncode != 0:
        print(json.dumps({"success": False, "error": result.stderr.strip()}))
        sys.exit(1)

    elements = []
    for line in result.stdout.strip().split(", "):
        parts = line.strip().split("|")
        if len(parts) >= 4:
            try:
                pos = parts[2].split(",")
                size = parts[3].split(",")
                elements.append({
                    "role": parts[0],
                    "description": parts[1],
                    "x": int(float(pos[0])),
                    "y": int(float(pos[1])),
                    "width": int(float(size[0])),
                    "height": int(float(size[1]))
                })
            except (ValueError, IndexError):
                continue

    print(json.dumps({"success": True, "app": app_name, "elements": elements}))


# --- CLI ---

def main():
    parser = argparse.ArgumentParser(description="macOS screen control via CGEvent")
    subparsers = parser.add_subparsers(dest="command")

    # screenshot
    p = subparsers.add_parser("screenshot")
    p.add_argument("--output", required=True, help="Output file path")
    p.add_argument("--x", type=int, default=None)
    p.add_argument("--y", type=int, default=None)
    p.add_argument("--width", type=int, default=None)
    p.add_argument("--height", type=int, default=None)

    # click
    p = subparsers.add_parser("click")
    p.add_argument("--x", required=True, type=float)
    p.add_argument("--y", required=True, type=float)
    p.add_argument("--double", action="store_true")
    p.add_argument("--right", action="store_true")

    # move
    p = subparsers.add_parser("move")
    p.add_argument("--x", required=True, type=float)
    p.add_argument("--y", required=True, type=float)

    # drag
    p = subparsers.add_parser("drag")
    p.add_argument("--from-x", required=True, type=float)
    p.add_argument("--from-y", required=True, type=float)
    p.add_argument("--to-x", required=True, type=float)
    p.add_argument("--to-y", required=True, type=float)

    # type
    p = subparsers.add_parser("type")
    p.add_argument("--text", required=True)

    # key
    p = subparsers.add_parser("key")
    p.add_argument("--key", required=True)
    p.add_argument("--modifiers", default=None, help="Comma-separated: command,shift,option,control")

    # window
    p = subparsers.add_parser("window")
    p.add_argument("--app", required=True)

    # activate
    p = subparsers.add_parser("activate")
    p.add_argument("--app", required=True)

    # list-windows
    subparsers.add_parser("list-windows")

    # calibrate
    subparsers.add_parser("calibrate")

    # find-element
    p = subparsers.add_parser("find-element")
    p.add_argument("--app", required=True)
    p.add_argument("--role", default=None, help="Accessibility role (e.g., 'button', 'text field')")
    p.add_argument("--text", default=None, help="Text to match in element value")

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
        "activate": cmd_activate,
        "list-windows": cmd_list_windows,
        "calibrate": cmd_calibrate,
        "find-element": cmd_find_element,
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
