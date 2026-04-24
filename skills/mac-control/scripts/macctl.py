#!/usr/bin/env python3
"""
macctl — macOS screen control CLI for AI agents.

Zero-dependency Python tool that uses ctypes to call CoreGraphics CGEvent
for mouse/keyboard control, plus subprocess for screencapture/osascript.

Works exclusively on macOS. Fails gracefully on other platforms with clear
error messages.

Usage:
    macctl screenshot [output_path]          # Capture screenshot
    macctl click <x> <y>                     # Left click
    macctl double-click <x> <y>              # Double click
    macctl right-click <x> <y>               # Right click
    macctl move <x> <y>                      # Move mouse
    macctl drag <x1> <y1> <x2> <y2>          # Drag from A to B
    macctl type <text>                       # Type text (clipboard paste)
    macctl key <key> [mod1 mod2 ...]         # Press key with modifiers
    macctl window <app_name>                 # Get window bounds
    macctl activate <app_name>               # Bring app to front
    macctl calibrate                         # Show calibration info
    macctl scale                             # Get Retina scale factor
    macctl mouse-pos                         # Get current mouse position

Reference: https://github.com/hs3180/disclaude/issues/2216
"""

import sys
import os
import json
import subprocess
import tempfile
import time

# ── Platform check ────────────────────────────────────────────────────────────

if sys.platform != "darwin":
    print(json.dumps({"ok": False, "error": "macctl requires macOS"}))
    sys.exit(1)

import ctypes
import ctypes.util

# ── CoreGraphics bindings via ctypes ─────────────────────────────────────────

_lib_path = ctypes.util.find_library("CoreGraphics")
if not _lib_path:
    print(json.dumps({"ok": False, "error": "CoreGraphics not found"}))
    sys.exit(1)

CG = ctypes.cdll.LoadLibrary(_lib_path)

# CGEvent types
CGEventRef = ctypes.c_void_p
CGEventSourceRef = ctypes.c_void_p
CGFloat = ctypes.c_double

# CGEventSourceStateID
kCGEventSourceStateHIDSystemState = 1

# CGEventType
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26
kCGEventLeftMouseDragged = 6
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagsChanged = 12

# CGMouseButton
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGMouseButtonCenter = 2

# Modifier key codes
kVK_Shift = 56
kVK_Control = 59
kVK_Option = 58
kVK_Command = 55
kVK_CapsLock = 57

# Virtual key codes for common keys
KEY_MAP = {
    "return": 0x24, "enter": 0x24, "tab": 0x30, "space": 0x31,
    "delete": 0x33, "backspace": 0x33, "escape": 0x35, "esc": 0x35,
    "command": 55, "cmd": 55, "shift": 56, "control": 59, "ctrl": 59,
    "option": 58, "alt": 58, "capslock": 57,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77, "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76, "f5": 0x60,
    "f6": 0x61, "f7": 0x62, "f8": 0x64, "f9": 0x65, "f10": 0x6D,
    "f11": 0x67, "f12": 0x6F,
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

MODIFIER_MAP = {
    "shift": 0x20100, "cmd": 0x100000, "command": 0x100000,
    "ctrl": 0x40000, "control": 0x40000,
    "alt": 0x80000, "option": 0x80000,
    "capslock": 0x10000,
}


def _create_source():
    """Create a CGEventSource from the HID system state."""
    return CG.CGEventSourceCreate(
        ctypes.c_uint32(kCGEventSourceStateHIDSystemState)
    )


def _post_event(event):
    """Post a CGEvent and release it."""
    CG.CGEventPost(ctypes.c_uint32(0), event)  # kCGHIDEventTap = 0
    CG.CFRelease(event)


# ── Mouse operations ─────────────────────────────────────────────────────────


def _mouse_event(x, y, event_type, button=kCGMouseButtonLeft):
    """Create and post a mouse event at given coordinates."""
    source = _create_source()
    point = CGFloat * 2
    location = point(x, y)

    event = CG.CGEventCreateMouseEvent(
        source,
        ctypes.c_uint32(event_type),
        location,
        ctypes.c_uint32(button),
    )
    _post_event(event)
    CG.CFRelease(source)


def cmd_click(args):
    """Left click at (x, y)."""
    if len(args) < 2:
        return {"ok": False, "error": "Usage: macctl click <x> <y>"}
    x, y = float(args[0]), float(args[1])
    _mouse_event(x, y, kCGEventMouseMoved)
    time.sleep(0.02)
    _mouse_event(x, y, kCGEventLeftMouseDown)
    _mouse_event(x, y, kCGEventLeftMouseUp)
    return {"ok": True, "action": "click", "x": x, "y": y}


def cmd_double_click(args):
    """Double click at (x, y)."""
    if len(args) < 2:
        return {"ok": False, "error": "Usage: macctl double-click <x> <y>"}
    x, y = float(args[0]), float(args[1])
    _mouse_event(x, y, kCGEventMouseMoved)
    time.sleep(0.02)
    for _ in range(2):
        _mouse_event(x, y, kCGEventLeftMouseDown)
        _mouse_event(x, y, kCGEventLeftMouseUp)
        time.sleep(0.05)
    return {"ok": True, "action": "double-click", "x": x, "y": y}


def cmd_right_click(args):
    """Right click at (x, y)."""
    if len(args) < 2:
        return {"ok": False, "error": "Usage: macctl right-click <x> <y>"}
    x, y = float(args[0]), float(args[1])
    _mouse_event(x, y, kCGEventMouseMoved)
    time.sleep(0.02)
    _mouse_event(x, y, kCGEventRightMouseDown, kCGMouseButtonRight)
    _mouse_event(x, y, kCGEventRightMouseUp, kCGMouseButtonRight)
    return {"ok": True, "action": "right-click", "x": x, "y": y}


def cmd_move(args):
    """Move mouse to (x, y) without clicking."""
    if len(args) < 2:
        return {"ok": False, "error": "Usage: macctl move <x> <y>"}
    x, y = float(args[0]), float(args[1])
    _mouse_event(x, y, kCGEventMouseMoved)
    return {"ok": True, "action": "move", "x": x, "y": y}


def cmd_drag(args):
    """Drag from (x1, y1) to (x2, y2)."""
    if len(args) < 4:
        return {"ok": False, "error": "Usage: macctl drag <x1> <y1> <x2> <y2>"}
    x1, y1 = float(args[0]), float(args[1])
    x2, y2 = float(args[2]), float(args[3])
    steps = 20
    _mouse_event(x1, y1, kCGEventMouseMoved)
    time.sleep(0.02)
    _mouse_event(x1, y1, kCGEventLeftMouseDown)
    time.sleep(0.05)
    for i in range(1, steps + 1):
        t = i / steps
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t
        _mouse_event(cx, cy, kCGEventLeftMouseDragged)
        time.sleep(0.01)
    _mouse_event(x2, y2, kCGEventLeftMouseUp)
    return {"ok": True, "action": "drag", "from": [x1, y1], "to": [x2, y2]}


def cmd_mouse_pos(args):
    """Get current mouse cursor position."""
    source = _create_source()
    event = CG.CGEventCreate(source)
    loc = (CGFloat * 2)()
    CG.CGEventGetLocation(event, loc)
    CG.CFRelease(event)
    CG.CFRelease(source)
    return {"ok": True, "x": loc[0], "y": loc[1]}


# ── Keyboard operations ──────────────────────────────────────────────────────


def _key_event(keycode, flags=0, down=True):
    """Create and post a keyboard event."""
    source = _create_source()
    event = CG.CGEventCreateKeyboardEvent(
        source, ctypes.c_uint16(keycode), ctypes.c_bool(down)
    )
    if flags:
        CG.CGEventSetFlags(event, ctypes.c_uint64(flags))
    _post_event(event)
    CG.CFRelease(source)


def _resolve_keycode(key):
    """Resolve a key name to a virtual key code."""
    k = key.lower()
    if k in KEY_MAP:
        return KEY_MAP[k]
    # Single character
    if len(key) == 1:
        # Check if it's in the map
        if key in KEY_MAP:
            return KEY_MAP[key]
    return None


def _resolve_modifiers(mod_list):
    """Resolve modifier key names to CGEventFlags bitmask."""
    flags = 0
    for mod in mod_list:
        m = mod.lower()
        if m in MODIFIER_MAP:
            flags |= MODIFIER_MAP[m]
    return flags


def cmd_type(args):
    """Type text using clipboard paste method (supports CJK)."""
    if not args:
        return {"ok": False, "error": "Usage: macctl type <text>"}
    text = " ".join(args)

    # Save current clipboard
    try:
        old_clipboard = subprocess.run(
            ["pbpaste", "-Prefer", "txt"],
            capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        old_clipboard = ""

    # Copy text to clipboard
    subprocess.run(["pbcopy"], input=text, text=True, check=True)
    time.sleep(0.05)

    # Cmd+V to paste
    cmd_flag = MODIFIER_MAP["cmd"]
    _key_event(KEY_MAP["v"], flags=cmd_flag, down=True)
    time.sleep(0.02)
    _key_event(KEY_MAP["v"], flags=cmd_flag, down=False)
    time.sleep(0.05)

    # Restore old clipboard (async, don't block)
    try:
        subprocess.run(["pbcopy"], input=old_clipboard, text=True, timeout=5)
    except Exception:
        pass

    return {"ok": True, "action": "type", "length": len(text)}


def cmd_key(args):
    """Press a key with optional modifiers."""
    if not args:
        return {"ok": False, "error": "Usage: macctl key <key> [mod1 mod2 ...]"}

    key = args[0]
    modifiers = args[1:] if len(args) > 1 else []
    keycode = _resolve_keycode(key)

    if keycode is None:
        return {"ok": False, "error": f"Unknown key: {key}"}

    flags = _resolve_modifiers(modifiers)

    # Press modifiers first
    if flags:
        for mod in modifiers:
            mod_lower = mod.lower()
            if mod_lower in MODIFIER_MAP:
                mod_code = _resolve_keycode(mod_lower)
                if mod_code is not None:
                    _key_event(mod_code, flags=flags, down=True)

    # Press and release key
    _key_event(keycode, flags=flags, down=True)
    time.sleep(0.02)
    _key_event(keycode, flags=flags, down=False)

    # Release modifiers
    if flags:
        for mod in reversed(modifiers):
            mod_lower = mod.lower()
            if mod_lower in MODIFIER_MAP:
                mod_code = _resolve_keycode(mod_lower)
                if mod_code is not None:
                    _key_event(mod_code, down=False)

    return {
        "ok": True,
        "action": "key",
        "key": key,
        "modifiers": modifiers,
    }


# ── Screenshot ───────────────────────────────────────────────────────────────


def cmd_screenshot(args):
    """Capture a screenshot."""
    output = args[0] if args else os.path.join(
        tempfile.gettempdir(), f"screenshot_{int(time.time())}.png"
    )
    try:
        subprocess.run(
            ["screencapture", "-x", output],
            check=True, capture_output=True, timeout=10
        )
        return {"ok": True, "path": output}
    except FileNotFoundError:
        return {"ok": False, "error": "screencapture not found (requires macOS)"}
    except subprocess.CalledProcessError as e:
        return {"ok": False, "error": f"screencapture failed: {e.stderr.decode()}"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "screencapture timed out"}


# ── Window management ────────────────────────────────────────────────────────


def _osascript(script):
    """Run an AppleScript snippet and return stdout."""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def cmd_window(args):
    """Get window bounds for an application."""
    if not args:
        return {"ok": False, "error": "Usage: macctl window <app_name>"}
    app_name = " ".join(args)
    script = f'''
    tell application "System Events"
        tell process "{app_name}"
            set p to position of window 1
            set s to size of window 1
            return (item 1 of p) & "," & (item 2 of p) & "," & (item 1 of s) & "," & (item 2 of s)
        end tell
    end tell
    '''
    try:
        output = _osascript(script)
        parts = [float(x.strip()) for x in output.split(",")]
        return {
            "ok": True,
            "app": app_name,
            "x": parts[0],
            "y": parts[1],
            "width": parts[2],
            "height": parts[3],
        }
    except Exception as e:
        return {"ok": False, "error": str(e)}


def cmd_activate(args):
    """Bring an application to the foreground."""
    if not args:
        return {"ok": False, "error": "Usage: macctl activate <app_name>"}
    app_name = " ".join(args)
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''
    try:
        _osascript(script)
        return {"ok": True, "action": "activate", "app": app_name}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Calibration ──────────────────────────────────────────────────────────────


def cmd_calibrate(args):
    """Show calibration info (Retina scaling, screen bounds)."""
    info = {}

    # Get scale factor via NSScreen
    script = '''
    use framework "AppKit"
    set scaleFactor to current application's NSScreen's mainScreen()'s backingScaleFactor() as real
    return scaleFactor
    '''
    try:
        output = _osascript(script)
        info["scale_factor"] = float(output)
    except Exception:
        info["scale_factor"] = "unknown"

    # Get screen dimensions
    script2 = '''
    tell application "Finder"
        set b to bounds of window of desktop
        return (item 1 of b) & "," & (item 2 of b) & "," & (item 3 of b) & "," & (item 4 of b)
    end tell
    '''
    try:
        output = _osascript(script2)
        parts = [float(x.strip()) for x in output.split(",")]
        info["screen"] = {
            "x": parts[0], "y": parts[1],
            "width": parts[2], "height": parts[3],
        }
    except Exception as e:
        info["screen"] = {"error": str(e)}

    info["note"] = (
        "Screenshot pixel coords / scale_factor = CGEvent logical coords. "
        "CGEvent uses logical (point) coordinates, screencapture gives pixel coordinates."
    )
    return {"ok": True, "calibration": info}


def cmd_scale(args):
    """Get Retina backing scale factor."""
    script = '''
    use framework "AppKit"
    set scaleFactor to current application's NSScreen's mainScreen()'s backingScaleFactor() as real
    return scaleFactor
    '''
    try:
        output = _osascript(script)
        return {"ok": True, "scale_factor": float(output)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── CLI dispatch ─────────────────────────────────────────────────────────────

COMMANDS = {
    "screenshot": cmd_screenshot,
    "click": cmd_click,
    "double-click": cmd_double_click,
    "right-click": cmd_right_click,
    "move": cmd_move,
    "drag": cmd_drag,
    "type": cmd_type,
    "key": cmd_key,
    "window": cmd_window,
    "activate": cmd_activate,
    "calibrate": cmd_calibrate,
    "scale": cmd_scale,
    "mouse-pos": cmd_mouse_pos,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help", "help"):
        print(__doc__)
        sys.exit(0)

    command = sys.argv[1]
    args = sys.argv[2:]

    if command not in COMMANDS:
        result = {"ok": False, "error": f"Unknown command: {command}. Available: {', '.join(COMMANDS)}"}
        print(json.dumps(result))
        sys.exit(1)

    try:
        result = COMMANDS[command](args)
        print(json.dumps(result))
        sys.exit(0 if result.get("ok") else 1)
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()
