#!/usr/bin/env python3
"""
macOS Screen Control Script — CGEvent-based desktop automation.

Uses Python ctypes to call CoreGraphics CGEvent APIs for mouse/keyboard control,
subprocess for screenshots and clipboard, and osascript for window management.

Platform: macOS only. Exits with code 1 on other platforms.
"""

import sys
import os
import json
import subprocess
import struct
import platform

# ─── Platform Guard ───────────────────────────────────────────────────────────

if platform.system() != "Darwin":
    print(json.dumps({"error": "macOS only. This script requires Darwin/macOS."}))
    sys.exit(1)

# ─── ctypes imports for CoreGraphics ─────────────────────────────────────────

import ctypes
import ctypes.util

# Load CoreGraphics framework
_cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreGraphics"))
_foundation = ctypes.cdll.LoadLibrary(ctypes.util.find_library("Foundation"))

# CGEvent types
CGEventRef = ctypes.c_void_p
CGDirectDisplayID = ctypes.c_uint32

# ─── Constants ────────────────────────────────────────────────────────────────

# Mouse buttons
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGMouseButtonCenter = 2

# Mouse event types
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventLeftMouseDragged = 6
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26

# Keyboard event types
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagsChanged = 12

# Modifier flags
kCGEventFlagMaskCommand = 1 << 3   # 0x0008
kCGEventFlagMaskShift = 1 << 0     # 0x0001
kCGEventFlagMaskAlternate = 1 << 2 # 0x0004  (Option/Alt)
kCGEventFlagMaskControl = 1 << 1   # 0x0002

# Event tap location
kCGHIDEventTap = 0
kCGSessionEventTap = 1

# Virtual key codes
KEY_MAP = {
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "escape": 0x35, "esc": 0x35,
    "delete": 0x75, "forward_delete": 0x75,
    "backspace": 0x33,
    "space": 0x31,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77,
    "page_up": 0x74, "page_down": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
}

MODIFIER_MAP = {
    "cmd": kCGEventFlagMaskCommand,
    "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
    "ctrl": kCGEventFlagMaskControl,
    "control": kCGEventFlagMaskControl,
}


# ─── Core CGEvent Wrappers ───────────────────────────────────────────────────

def cg_event_create_mouse_event(source, mouse_type, x, y, button):
    """Create a CGEvent mouse event."""
    _cg.CGEventCreateMouseEvent.restype = CGEventRef
    _cg.CGEventCreateMouseEvent.argtypes = [
        ctypes.c_void_p,  # source
        ctypes.c_uint32,  # mouseType
        ctypes.c_int32,   # x (CGPoint.x as int32)
        ctypes.c_int32,   # y (CGPoint.y as int32)
        ctypes.c_uint32,  # mouseButton
    ]
    # Pack x, y into a CGPoint (two int32s on 64-bit: actually two doubles)
    # Actually CGPoint is two CGFloat which is double on 64-bit
    _cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    # Use the struct approach for CGPoint
    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    _cg.CGEventCreateMouseEvent.restype = ctypes.c_void_p
    _cg.CGEventCreateMouseEvent.argtypes = [
        ctypes.c_void_p,           # source (NULL)
        ctypes.c_uint32,           # mouseType
        CGPoint,                   # point
        ctypes.c_uint32,           # mouseButton
    ]
    point = CGPoint(x, y)
    return _cg.CGEventCreateMouseEvent(None, mouse_type, point, button)


def cg_event_post(event):
    """Post a CGEvent to the HID event tap."""
    _cg.CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    _cg.CGEventPost(kCGHIDEventTap, event)


def cg_event_create_keyboard_event(source, key_code, down):
    """Create a CGEvent keyboard event."""
    _cg.CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
    _cg.CGEventCreateKeyboardEvent.argtypes = [
        ctypes.c_void_p,  # source
        ctypes.c_uint16,  # virtualKey
        ctypes.c_bool,    # keyDown
    ]
    return _cg.CGEventCreateKeyboardEvent(source, key_code, down)


def cg_event_set_flags(event, flags):
    """Set modifier flags on a CGEvent."""
    _cg.CGEventSetFlags.argtypes = [ctypes.c_void_p, ctypes.c_uint64]
    _cg.CGEventSetFlags(event, flags)


def cg_event_get_flags(event):
    """Get modifier flags from a CGEvent."""
    _cg.CGEventGetFlags.restype = ctypes.c_uint64
    _cg.CGEventGetFlags.argtypes = [ctypes.c_void_p]
    return _cg.CGEventGetFlags(event)


def cg_event_release(event):
    """Release a CGEvent."""
    _cg.CGEventRelease.argtypes = [ctypes.c_void_p]
    _cg.CGEventRelease(event)


# ─── Mouse Commands ──────────────────────────────────────────────────────────

def cmd_click(x, y, button=kCGMouseButtonLeft, count=1):
    """Click at (x, y) using CGEvent."""
    x, y = float(x), float(y)
    down_type = {
        kCGMouseButtonLeft: kCGEventLeftMouseDown,
        kCGMouseButtonRight: kCGEventRightMouseDown,
        kCGMouseButtonCenter: kCGEventOtherMouseDown,
    }[button]
    up_type = {
        kCGMouseButtonLeft: kCGEventLeftMouseUp,
        kCGMouseButtonRight: kCGEventRightMouseUp,
        kCGMouseButtonCenter: kCGEventOtherMouseUp,
    }[button]

    for _ in range(count):
        down_event = cg_event_create_mouse_event(None, down_type, x, y, button)
        cg_event_post(down_event)
        cg_event_release(down_event)

        up_event = cg_event_create_mouse_event(None, up_type, x, y, button)
        cg_event_post(up_event)
        cg_event_release(up_event)


def cmd_double_click(x, y):
    """Double left click at (x, y)."""
    cmd_click(x, y, kCGMouseButtonLeft, count=2)


def cmd_right_click(x, y):
    """Right click at (x, y)."""
    cmd_click(x, y, kCGMouseButtonRight, count=1)


def cmd_move(x, y):
    """Move mouse to (x, y) without clicking."""
    event = cg_event_create_mouse_event(None, kCGEventMouseMoved, float(x), float(y), kCGMouseButtonLeft)
    cg_event_post(event)
    cg_event_release(event)


def cmd_drag(x1, y1, x2, y2, duration=0.3):
    """Drag from (x1, y1) to (x2, y2)."""
    import time
    x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)

    # Move to start
    cmd_move(x1, y1)
    time.sleep(0.05)

    # Mouse down at start
    down_event = cg_event_create_mouse_event(None, kCGEventLeftMouseDown, x1, y1, kCGMouseButtonLeft)
    cg_event_post(down_event)
    cg_event_release(down_event)

    # Animate drag
    steps = 20
    for i in range(1, steps + 1):
        t = i / steps
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t
        drag_event = cg_event_create_mouse_event(
            None, kCGEventLeftMouseDragged, cx, cy, kCGMouseButtonLeft
        )
        cg_event_post(drag_event)
        cg_event_release(drag_event)
        time.sleep(duration / steps)

    # Mouse up at end
    up_event = cg_event_create_mouse_event(None, kCGEventLeftMouseUp, x2, y2, kCGMouseButtonLeft)
    cg_event_post(up_event)
    cg_event_release(up_event)


# ─── Keyboard Commands ────────────────────────────────────────────────────────

def _resolve_key_code(key_name):
    """Resolve a key name string to a macOS virtual key code."""
    key_lower = key_name.lower()
    if key_lower in KEY_MAP:
        return KEY_MAP[key_lower]
    # Single character
    if len(key_lower) == 1:
        # Map letter to virtual key code (US keyboard layout)
        if key_lower.isalpha():
            # A=0x00, S=0x01, D=0x02, F=0x03, H=0x04, G=0x05, Z=0x06, X=0x07,
            # C=0x08, V=0x09, B=0x0B, Q=0x0C, W=0x0D, E=0x0E, R=0x0F, Y=0x10,
            # T=0x11, 1=0x12, 2=0x13, 3=0x14, 4=0x15, 6=0x16, 5=0x17,
            # =0x18, 9=0x19, 7=0x1A, -0x1B, 8=0x1C, 0=0x1D, ]=0x1E, O=0x1F,
            # U=0x20, [=0x21, I=0x22, P=0x23, L=0x25, J=0x26, '=0x27, K=0x28,
            # ;0x29, \=0x2A, ,=0x2B, /=0x2C, N=0x2D, M=0x2E, .=0x2F, `=0x32
            letter_key_codes = {
                'a': 0x00, 's': 0x01, 'd': 0x02, 'f': 0x03, 'h': 0x04,
                'g': 0x05, 'z': 0x06, 'x': 0x07, 'c': 0x08, 'v': 0x09,
                'b': 0x0B, 'q': 0x0C, 'w': 0x0D, 'e': 0x0E, 'r': 0x0F,
                'y': 0x10, 't': 0x11, 'o': 0x1F, 'u': 0x20, 'i': 0x22,
                'p': 0x23, 'l': 0x25, 'j': 0x26, 'k': 0x28, 'n': 0x2D,
                'm': 0x2E,
            }
            if key_lower in letter_key_codes:
                return letter_key_codes[key_lower]
        if key_lower.isdigit():
            digit_key_codes = {
                '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15, '5': 0x17,
                '6': 0x16, '7': 0x1A, '8': 0x1C, '9': 0x19, '0': 0x1D,
            }
            if key_lower in digit_key_codes:
                return digit_key_codes[key_lower]
    raise ValueError(f"Unknown key: {key_name}")


def _parse_modifiers(mod_names):
    """Parse modifier key names into a CGEvent flags bitmask."""
    flags = 0
    for mod in mod_names:
        mod_lower = mod.lower()
        if mod_lower in MODIFIER_MAP:
            flags |= MODIFIER_MAP[mod_lower]
        else:
            raise ValueError(f"Unknown modifier: {mod}")
    return flags


def cmd_key(key_name, modifiers=None):
    """Press a key with optional modifiers."""
    key_code = _resolve_key_code(key_name)
    modifier_flags = _parse_modifiers(modifiers) if modifiers else 0

    # Key down
    down_event = cg_event_create_keyboard_event(None, key_code, True)
    if modifier_flags:
        cg_event_set_flags(down_event, modifier_flags)
    cg_event_post(down_event)
    cg_event_release(down_event)

    # Key up
    up_event = cg_event_create_keyboard_event(None, key_code, False)
    if modifier_flags:
        cg_event_set_flags(up_event, modifier_flags)
    cg_event_post(up_event)
    cg_event_release(up_event)


def cmd_type_text(text):
    """Type text using clipboard paste method (supports CJK and all Unicode).

    This saves the current clipboard, sets the new text, sends Cmd+V, then
    restores the original clipboard.
    """
    import time

    # Save current clipboard
    try:
        old_clipboard = subprocess.run(
            ["pbpaste"],
            capture_output=True, text=True, timeout=2
        ).stdout
    except Exception:
        old_clipboard = ""

    # Set new clipboard content
    subprocess.run(
        ["pbcopy"],
        input=text, text=True, check=True, timeout=2
    )

    # Small delay to ensure clipboard is set
    time.sleep(0.05)

    # Paste (Cmd+V)
    cmd_key("v", ["cmd"])

    # Small delay before restoring
    time.sleep(0.1)

    # Restore original clipboard
    try:
        subprocess.run(
            ["pbcopy"],
            input=old_clipboard, text=True, timeout=2
        )
    except Exception:
        pass  # Non-critical if restore fails


# ─── Screenshot Commands ─────────────────────────────────────────────────────

def cmd_screenshot(output_path="/tmp/screenshot.png"):
    """Capture full screen screenshot."""
    subprocess.run(
        ["screencapture", "-x", output_path],
        check=True, timeout=10
    )
    return {"path": output_path, "full_screen": True}


def cmd_screenshot_region(x, y, w, h, output_path="/tmp/screenshot_region.png"):
    """Capture a region of the screen."""
    region = f"-R{int(x)},{int(y)},{int(w)},{int(h)}"
    subprocess.run(
        ["screencapture", "-x", region, output_path],
        check=True, timeout=10
    )
    return {"path": output_path, "region": {"x": int(x), "y": int(y), "w": int(w), "h": int(h)}}


# ─── Window Management Commands ──────────────────────────────────────────────

def _osascript(script):
    """Run an AppleScript and return stdout."""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip())
    return result.stdout.strip()


def cmd_get_frontmost_app():
    """Get the name and window bounds of the frontmost application."""
    script = '''
    tell application "System Events"
        set frontApp to name of first application process whose frontmost is true
        try
            set windowBounds to {0, 0, 0, 0}
            tell process frontApp
                if (count of windows) > 0 then
                    set windowBounds to {¬
                        (get x of position of window 1), ¬
                        (get y of position of window 1), ¬
                        (get width of size of window 1), ¬
                        (get height of size of window 1)}
                end if
            end tell
            return frontApp & "," & (item 1 of windowBounds as text) & "," & (item 2 of windowBounds as text) & "," & (item 3 of windowBounds as text) & "," & (item 4 of windowBounds as text)
        on error
            return frontApp & ",0,0,0,0"
        end try
    end tell
    '''
    output = _osascript(script)
    parts = output.split(",")
    return {
        "app": parts[0].strip(),
        "window": {
            "x": int(parts[1]),
            "y": int(parts[2]),
            "width": int(parts[3]),
            "height": int(parts[4]),
        }
    }


def cmd_activate_app(app_name):
    """Bring an application to the foreground."""
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''
    try:
        _osascript(script)
        return {"activated": app_name}
    except RuntimeError as e:
        return {"error": f"Could not activate '{app_name}': {e}"}


def cmd_get_window_bounds(app_name):
    """Get the window bounds of an application's main window."""
    script = f'''
    tell application "System Events"
        tell process "{app_name}"
            if (count of windows) > 0 then
                set windowBounds to {{¬
                    (get x of position of window 1), ¬
                    (get y of position of window 1), ¬
                    (get width of size of window 1), ¬
                    (get height of size of window 1)}}
                return (item 1 of windowBounds as text) & "," & (item 2 of windowBounds as text) & "," & (item 3 of windowBounds as text) & "," & (item 4 of windowBounds as text)
            else
                error "No windows found"
            end if
        end tell
    end tell
    '''
    try:
        output = _osascript(script)
        parts = output.split(",")
        return {
            "app": app_name,
            "x": int(parts[0]),
            "y": int(parts[1]),
            "width": int(parts[2]),
            "height": int(parts[3]),
        }
    except RuntimeError as e:
        return {"error": f"Could not get window bounds for '{app_name}': {e}"}


def cmd_list_windows():
    """List all visible windows with their positions."""
    script = '''
    tell application "System Events"
        set windowList to {}
        repeat with proc in (every application process whose background only is false)
            try
                tell proc
                    repeat with w in (every window)
                        set end of windowList to (name of proc) & "|" & (name of w) & "|" & ¬
                            (get x of position of w) & "," & (get y of position of w) & "," & ¬
                            (get width of size of w) & "," & (get height of size of w)
                    end repeat
                end tell
            end try
        end repeat
        set AppleScript's text item delimiters to linefeed
        return windowList as text
    end tell
    '''
    try:
        output = _osascript(script)
        windows = []
        if output:
            for line in output.split("\n"):
                if not line.strip():
                    continue
                parts = line.split("|")
                if len(parts) >= 2:
                    app_name = parts[0].strip()
                    win_name = parts[1].strip()
                    coords = parts[2].split(",") if len(parts) > 2 else ["0", "0", "0", "0"]
                    windows.append({
                        "app": app_name,
                        "window": win_name,
                        "x": int(coords[0]),
                        "y": int(coords[1]),
                        "width": int(coords[2]),
                        "height": int(coords[3]),
                    })
        return {"windows": windows}
    except RuntimeError as e:
        return {"error": f"Could not list windows: {e}"}


# ─── Coordinate Utility Commands ─────────────────────────────────────────────

def cmd_get_scale_factor():
    """Get the Retina backing scale factor for the main screen."""
    script = '''
    tell application "System Events"
        -- Use NSScreen via Python for reliability
    end tell
    '''
    # Use Python with PyObjC or system_profiler
    try:
        result = subprocess.run(
            ["python3", "-c",
             "import ctypes, ctypes.util; "
             "objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library('objc')); "
             "objc.sel_registerName.restype = ctypes.c_void_p; "
             "objc.objc_getClass.restype = ctypes.c_void_p; "
             "objc.objc_msgSend.restype = ctypes.c_void_p; "
             "objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]; "
             "NSScreen = objc.objc_getClass(b'NSScreen'); "
             "screen = objc.objc_msgSend(NSScreen, objc.sel_registerName(b'mainScreen')); "
             "objc.objc_msgSend.restype = ctypes.c_double; "
             "scale = objc.objc_msgSend(screen, objc.sel_registerName(b'backingScaleFactor')); "
             "print(scale)"
            ],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode == 0 and result.stdout.strip():
            return {"scale_factor": float(result.stdout.strip())}
    except Exception:
        pass

    # Fallback: use system_profiler
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10
        )
        if "Retina" in result.stdout:
            return {"scale_factor": 2.0}
    except Exception:
        pass

    # Default assumption
    return {"scale_factor": 1.0, "note": "Could not determine; assuming 1x (non-Retina)"}


def cmd_screen_to_logical(x, y):
    """Convert screen pixel coordinates to logical (point) coordinates."""
    scale = cmd_get_scale_factor()["scale_factor"]
    return {
        "logical_x": float(x) / scale,
        "logical_y": float(y) / scale,
        "scale_factor": scale,
    }


def cmd_logical_to_screen(x, y):
    """Convert logical (point) coordinates to screen pixel coordinates."""
    scale = cmd_get_scale_factor()["scale_factor"]
    return {
        "pixel_x": float(x) * scale,
        "pixel_y": float(y) * scale,
        "scale_factor": scale,
    }


def cmd_get_mouse_position():
    """Get current mouse position in logical coordinates using CGEvent."""
    _cg.CGEventGetLocation.restype = None

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    point = CGPoint()
    _cg.CGEventGetLocation(ctypes.byref(point))
    return {"x": point.x, "y": point.y}


# ─── Command Router ──────────────────────────────────────────────────────────

COMMANDS = {
    # Mouse
    "click": lambda args: cmd_click(*[float(a) for a in args[:2]]),
    "double_click": lambda args: cmd_double_click(*[float(a) for a in args[:2]]),
    "right_click": lambda args: cmd_right_click(*[float(a) for a in args[:2]]),
    "move": lambda args: cmd_move(*[float(a) for a in args[:2]]),
    "drag": lambda args: cmd_drag(*[float(a) for a in args[:4]]),

    # Keyboard
    "type_text": lambda args: cmd_type_text(" ".join(args)),
    "key": lambda args: cmd_key(
        args[0],
        [a for a in args[1:] if a] if len(args) > 1 else None
    ),

    # Screenshot
    "screenshot": lambda args: cmd_screenshot(args[0] if args else "/tmp/screenshot.png"),
    "screenshot_region": lambda args: cmd_screenshot_region(
        *[float(a) for a in args[:4]],
        args[4] if len(args) > 4 else "/tmp/screenshot_region.png"
    ),

    # Window
    "get_frontmost_app": lambda args: cmd_get_frontmost_app(),
    "activate_app": lambda args: cmd_activate_app(" ".join(args)),
    "get_window_bounds": lambda args: cmd_get_window_bounds(" ".join(args)),
    "list_windows": lambda args: cmd_list_windows(),

    # Coordinates
    "get_scale_factor": lambda args: cmd_get_scale_factor(),
    "screen_to_logical": lambda args: cmd_screen_to_logical(*[float(a) for a in args[:2]]),
    "logical_to_screen": lambda args: cmd_logical_to_screen(*[float(a) for a in args[:2]]),
    "get_mouse_position": lambda args: cmd_get_mouse_position(),
}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "error": "Usage: mac_control.py <command> [args...]",
            "commands": sorted(COMMANDS.keys()),
        }))
        sys.exit(1)

    command = sys.argv[1]
    args = sys.argv[2:]

    if command not in COMMANDS:
        print(json.dumps({
            "error": f"Unknown command: {command}",
            "available_commands": sorted(COMMANDS.keys()),
        }))
        sys.exit(1)

    try:
        result = COMMANDS[command](args)
        if result is not None:
            print(json.dumps(result, ensure_ascii=False))
        else:
            print(json.dumps({"ok": True}))
    except Exception as e:
        print(json.dumps({"error": str(e), "command": command}))
        sys.exit(1)


if __name__ == "__main__":
    main()
