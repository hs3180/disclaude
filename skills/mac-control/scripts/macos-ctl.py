#!/usr/bin/env python3
"""
macOS native automation via CGEvent (CoreGraphics) + AppleScript.

Zero-dependency macOS mouse/keyboard automation at the hardware event level.
Uses Python 3 stdlib ctypes to call CoreGraphics directly — no pip installs needed.

Requires: macOS + Accessibility permission for the calling process.
  System Settings → Privacy & Security → Accessibility → add Terminal/app

Usage:
  python3 macos-ctl.py click <x> <y>
  python3 macos-ctl.py doubleclick <x> <y>
  python3 macos-ctl.py rightclick <x> <y>
  python3 macos-ctl.py move <x> <y>
  python3 macos-ctl.py drag <x1> <y1> <x2> <y2>
  python3 macos-ctl.py screenshot [path]
  python3 macos-ctl.py type <text>
  python3 macos-ctl.py key <key> [modifier1,modifier2]
  python3 macos-ctl.py window <app_name>
  python3 macos-ctl.py windows <app_name>
  python3 macos-ctl.py activate <app_name>
  python3 macos-ctl.py calibrate
  python3 macos-ctl.py scale-factor
  python3 macos-ctl.py list-apps
"""

import ctypes
import ctypes.util
import subprocess
import sys
import os
import json
import tempfile
import time

# ─── CoreGraphics bindings ────────────────────────────────────────────────────

def _load_coregraphics():
    """Load CoreGraphics framework via ctypes."""
    path = ctypes.util.find_library("CoreGraphics")
    if not path:
        raise RuntimeError("CoreGraphics not found — this tool requires macOS")
    return ctypes.cdll.LoadLibrary(path)

_cg = None

def _cg():
    global _cg
    if _cg is None:
        _cg = _load_coregraphics()
    return _cg


# ─── Event types and constants ────────────────────────────────────────────────

kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26
kCGEventKeyDown = 10
kCGEventKeyUp = 11
kCGEventFlagsChanged = 12
kCGEventSourceStateHIDSystemState = 1
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGMouseButtonCenter = 2
kCGHIDEventTap = 0

kCGEventFlagMaskCommand = 1 << 3   # 0x0008
kCGEventFlagMaskShift = 1 << 1     # 0x0002
kCGEventFlagMaskAlternate = 1 << 5 # 0x0020
kCGEventFlagMaskControl = 1 << 0   # 0x0001


def _create_event_source():
    """Create a CGEventSource from the HID system state."""
    return _cg().CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


def _event_set_location(event, x, y):
    """Set the (x, y) location of a CGEvent (uses CGPoint struct)."""
    # CGPoint is two doubles: x, y
    _cg().CGEventSetLocation(event, ctypes.c_double(x), ctypes.c_double(y))


# ─── Mouse control ────────────────────────────────────────────────────────────

def move(x, y):
    """Move cursor to (x, y) without clicking."""
    cg = _cg()
    src = _create_event_source()
    event = cg.CGEventCreateMouseEvent(src, kCGEventMouseMoved,
                                        ctypes.c_double(x), ctypes.c_double(y),
                                        kCGMouseButtonLeft)
    cg.CGEventPost(kCGHIDEventTap, event)
    # CFRelease(event)


def click(x, y):
    """Left-click at (x, y)."""
    cg = _cg()
    src = _create_event_source()
    down = cg.CGEventCreateMouseEvent(src, kCGEventLeftMouseDown,
                                       ctypes.c_double(x), ctypes.c_double(y),
                                       kCGMouseButtonLeft)
    up = cg.CGEventCreateMouseEvent(src, kCGEventLeftMouseUp,
                                     ctypes.c_double(x), ctypes.c_double(y),
                                     kCGMouseButtonLeft)
    cg.CGEventPost(kCGHIDEventTap, down)
    time.sleep(0.01)  # Brief pause between down and up
    cg.CGEventPost(kCGHIDEventTap, up)


def doubleclick(x, y):
    """Double-click at (x, y)."""
    click(x, y)
    time.sleep(0.05)
    click(x, y)


def rightclick(x, y):
    """Right-click at (x, y)."""
    cg = _cg()
    src = _create_event_source()
    down = cg.CGEventCreateMouseEvent(src, kCGEventRightMouseDown,
                                       ctypes.c_double(x), ctypes.c_double(y),
                                       kCGMouseButtonRight)
    up = cg.CGEventCreateMouseEvent(src, kCGEventRightMouseUp,
                                     ctypes.c_double(x), ctypes.c_double(y),
                                     kCGMouseButtonRight)
    cg.CGEventPost(kCGHIDEventTap, down)
    time.sleep(0.01)
    cg.CGEventPost(kCGHIDEventTap, up)


def drag(x1, y1, x2, y2, duration=0.3):
    """Click-drag from (x1, y1) to (x2, y2)."""
    cg = _cg()
    src = _create_event_source()
    down = cg.CGEventCreateMouseEvent(src, kCGEventLeftMouseDown,
                                       ctypes.c_double(x1), ctypes.c_double(y1),
                                       kCGMouseButtonLeft)
    cg.CGEventPost(kCGHIDEventTap, down)
    time.sleep(0.05)

    # Animate drag movement
    steps = max(10, int(duration * 60))
    for i in range(1, steps + 1):
        t = i / steps
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t
        moved = cg.CGEventCreateMouseEvent(src, kCGEventMouseMoved,
                                            ctypes.c_double(cx), ctypes.c_double(cy),
                                            kCGMouseButtonLeft)
        cg.CGEventSetType(moved, kCGEventLeftMouseDown)  # Keep button held
        cg.CGEventPost(kCGHIDEventTap, moved)
        time.sleep(duration / steps)

    up = cg.CGEventCreateMouseEvent(src, kCGEventLeftMouseUp,
                                     ctypes.c_double(x2), ctypes.c_double(y2),
                                     kCGMouseButtonLeft)
    cg.CGEventPost(kCGHIDEventTap, up)


def get_cursor_pos():
    """Get current cursor position as (x, y)."""
    cg = _cg()
    event = cg.CGEventCreate(None)
    x = ctypes.c_double(0)
    y = ctypes.c_double(0)
    # Use CGEventCreate to get current cursor location
    loc = cg.CGEventGetLocation(event)
    return loc.x if hasattr(loc, 'x') else (0, 0), loc.y if hasattr(loc, 'y') else (0, 0)


# ─── Keyboard control ─────────────────────────────────────────────────────────

# macOS virtual key codes for common keys
KEY_MAP = {
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "escape": 0x35, "esc": 0x35,
    "delete": 0x33, "backspace": 0x33,
    "forward-delete": 0x75,
    "space": 0x31,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
    "cmd": 0x37, "command": 0x37,
    "shift": 0x38,
    "option": 0x3A, "alt": 0x3A,
    "control": 0x3B, "ctrl": 0x3B,
    "capslock": 0x39,
}

MODIFIER_FLAGS = {
    "cmd": kCGEventFlagMaskCommand,
    "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
    "ctrl": kCGEventFlagMaskControl,
    "control": kCGEventFlagMaskControl,
}


def key_press(key_name, modifiers=None):
    """Press a key with optional modifiers using CGEvent."""
    cg = _cg()
    src = _create_event_source()
    key_lower = key_name.lower()

    if key_lower in KEY_MAP:
        key_code = KEY_MAP[key_lower]
    elif len(key_name) == 1:
        # Single character — convert to virtual key code
        key_code = _char_to_keycode(key_name)
    else:
        raise ValueError(f"Unknown key: {key_name}")

    # Build flags for modifiers
    flags = 0
    if modifiers:
        for mod in modifiers:
            mod_lower = mod.lower().strip()
            if mod_lower in MODIFIER_FLAGS:
                flags |= MODIFIER_FLAGS[mod_lower]

    # Press key
    down = cg.CGEventCreateKeyboardEvent(src, ctypes.c_uint(key_code), True)
    if flags:
        cg.CGEventSetFlags(down, ctypes.c_uint64(flags))
    cg.CGEventPost(kCGHIDEventTap, down)

    time.sleep(0.02)

    # Release key
    up = cg.CGEventCreateKeyboardEvent(src, ctypes.c_uint(key_code), False)
    if flags:
        cg.CGEventSetFlags(up, ctypes.c_uint64(flags))
    cg.CGEventPost(kCGHIDEventTap, up)


def _char_to_keycode(char):
    """Convert a single ASCII character to a macOS virtual key code."""
    # Simplified US keyboard layout mapping
    mapping = {
        'a': 0x00, 'b': 0x0B, 'c': 0x08, 'd': 0x02, 'e': 0x0E,
        'f': 0x03, 'g': 0x05, 'h': 0x04, 'i': 0x22, 'j': 0x26,
        'k': 0x28, 'l': 0x25, 'm': 0x2E, 'n': 0x2D, 'o': 0x1F,
        'p': 0x23, 'q': 0x0C, 'r': 0x0F, 's': 0x01, 't': 0x11,
        'u': 0x20, 'v': 0x09, 'w': 0x0D, 'x': 0x07, 'y': 0x10,
        'z': 0x06,
        '0': 0x1D, '1': 0x12, '2': 0x13, '3': 0x14, '4': 0x15,
        '5': 0x17, '6': 0x16, '7': 0x1A, '8': 0x1C, '9': 0x19,
        '-': 0x1B, '=': 0x18, '[': 0x21, ']': 0x1E, '\\': 0x2A,
        ';': 0x29, "'": 0x27, '`': 0x32, ',': 0x2B, '.': 0x2F,
        '/': 0x2C,
    }
    return mapping.get(char.lower(), 0x00)


# ─── Text input (clipboard-based for CJK support) ────────────────────────────

def type_text(text):
    """
    Type text via clipboard paste (pbcopy + Cmd+V).

    This approach handles all Unicode including CJK, emoji, and composed characters.
    CGEvent Unicode input only works for single characters and breaks with composed sequences.
    """
    # Save current clipboard
    old_clipboard = ""
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, text=True)
        old_clipboard = result.stdout
    except Exception:
        pass

    # Set clipboard to the text we want to type
    process = subprocess.run(["pbcopy"], input=text, text=True, check=True)

    # Small delay for clipboard to update
    time.sleep(0.1)

    # Paste with Cmd+V
    key_press("v", ["cmd"])

    # Wait for paste to complete
    time.sleep(0.2)

    # Restore old clipboard (best effort)
    try:
        subprocess.run(["pbcopy"], input=old_clipboard, text=True)
    except Exception:
        pass


# ─── Screenshot ────────────────────────────────────────────────────────────────

def screenshot(path=None):
    """Capture a screenshot using the built-in screencapture command."""
    if path is None:
        path = os.path.join(tempfile.gettempdir(), "disclaude-screenshot.png")
    subprocess.run(["/usr/sbin/screencapture", "-x", path], check=True)
    return path


def screenshot_window(app_name, path=None):
    """Capture a screenshot of a specific app's front window."""
    if path is None:
        path = os.path.join(tempfile.gettempdir(), f"disclaude-{app_name}.png")

    # Get window ID via AppleScript
    escaped = app_name.replace('"', '\\"')
    script = f'''
    tell application "System Events"
        tell process "{escaped}"
            return id of front window
        end tell
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script],
                            capture_output=True, text=True)
    if result.returncode != 0:
        # Fallback: activate app and take full screenshot
        activate(app_name)
        time.sleep(0.5)
        return screenshot(path)

    window_id = result.stdout.strip()
    subprocess.run(["/usr/sbin/screencapture", "-x", "-l", window_id, "-o", path],
                   check=True)
    return path


# ─── Window management ────────────────────────────────────────────────────────

def get_window(app_name):
    """Get the front window bounds for an app: {x, y, w, h}."""
    escaped = app_name.replace('"', '\\"')
    script = f'''
    tell application "{escaped}"
        set b to bounds of front window
        return (item 1 of b as text) & "," & (item 2 of b as text) & "," & ((item 3 of b) - (item 1 of b) as text) & "," & ((item 4 of b) - (item 2 of b) as text)
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return None

    parts = result.stdout.strip().split(",")
    if len(parts) != 4:
        return None

    return {
        "app": app_name,
        "x": int(float(parts[0])),
        "y": int(float(parts[1])),
        "w": int(float(parts[2])),
        "h": int(float(parts[3])),
    }


def get_all_windows(app_name):
    """List all windows for an app with titles and bounds."""
    escaped = app_name.replace('"', '\\"')
    script = f'''
    tell application "{escaped}"
        set output to ""
        repeat with w in (every window)
            set b to bounds of w
            set output to output & (name of w as text) & "|" & (item 1 of b as text) & "," & (item 2 of b as text) & "," & ((item 3 of b) - (item 1 of b) as text) & "," & ((item 4 of b) - (item 2 of b) as text) & linefeed
        end repeat
        return output
    end tell
    '''
    result = subprocess.run(["osascript", "-e", script],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return []

    windows = []
    for line in result.stdout.strip().split("\n"):
        if "|" not in line:
            continue
        title, dims = line.rsplit("|", 1)
        parts = dims.split(",")
        if len(parts) != 4:
            continue
        windows.append({
            "title": title.strip(),
            "x": int(float(parts[0])),
            "y": int(float(parts[1])),
            "w": int(float(parts[2])),
            "h": int(float(parts[3])),
        })
    return windows


def activate(app_name):
    """Bring an app to the foreground."""
    escaped = app_name.replace('"', '\\"')
    subprocess.run(["osascript", "-e",
                    f'tell application "{escaped}" to activate'],
                   check=True)


def list_apps():
    """List all running GUI applications."""
    script = 'tell application "System Events" to get name of every process whose background only is false'
    result = subprocess.run(["osascript", "-e", script],
                            capture_output=True, text=True)
    if result.returncode != 0:
        return []
    return [name.strip() for name in result.stdout.strip().split(",")]


# ─── Coordinate calibration ───────────────────────────────────────────────────

def get_scale_factor():
    """Get the main display's backing scale factor."""
    # On macOS, NSScreen.main backingScaleFactor tells us 1x or 2x
    # Accessible via Python objc or via the ratio of screen resolution
    script = '''
    use framework "AppKit"
    set scaleFactor to current application's NSScreen's mainScreen()'s backingScaleFactor() as real
    return scaleFactor as text
    '''
    result = subprocess.run(["osascript", "-e", script],
                            capture_output=True, text=True)
    if result.returncode == 0:
        return float(result.stdout.strip())
    return 1.0  # Default to 1x


def calibrate():
    """
    Run coordinate calibration: move cursor to known positions and verify.

    Returns calibration info including scale factor and screen dimensions.
    """
    info = {}

    # Get scale factor
    scale = get_scale_factor()
    info["scale_factor"] = scale

    # Get main screen dimensions via AppleScript
    script = '''
    tell application "System Events"
        set d to desktop
        set dims to {word 3 of (do shell script "system_profiler SPDisplaysDataType | grep Resolution"), word 5 of (do shell script "system_profiler SPDisplaysDataType | grep Resolution")}
        return (item 1 of dims as text) & "x" & (item 2 of dims as text)
    end tell
    '''
    try:
        result = subprocess.run(["osascript", "-e", script],
                                capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            info["display_resolution"] = result.stdout.strip()
    except Exception:
        pass

    # Get screen size via CGDisplay API
    try:
        cg = _cg()
        main_display = cg.CGMainDisplayID()
        width = cg.CGDisplayPixelsWide(main_display)
        height = cg.CGDisplayPixelsHigh(main_display)
        info["physical_pixels"] = f"{width}x{height}"
        info["logical_pixels"] = f"{width // int(scale)}x{height // int(scale)}"
    except Exception:
        pass

    info["coordinate_note"] = (
        f"Scale factor: {scale}x. "
        f"Screenshots are in physical pixels. "
        f"CGEvent/cliclick coordinates are in logical pixels. "
        f"Convert: logical_coord = physical_coord / {scale}"
    )

    return info


# ─── CLI entry point ──────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1].lower()

    try:
        if cmd == "click" and len(sys.argv) >= 4:
            click(int(sys.argv[2]), int(sys.argv[3]))

        elif cmd == "doubleclick" and len(sys.argv) >= 4:
            doubleclick(int(sys.argv[2]), int(sys.argv[3]))

        elif cmd == "rightclick" and len(sys.argv) >= 4:
            rightclick(int(sys.argv[2]), int(sys.argv[3]))

        elif cmd == "move" and len(sys.argv) >= 4:
            move(int(sys.argv[2]), int(sys.argv[3]))

        elif cmd == "drag" and len(sys.argv) >= 6:
            drag(int(sys.argv[2]), int(sys.argv[3]),
                 int(sys.argv[4]), int(sys.argv[5]))

        elif cmd == "type" and len(sys.argv) >= 3:
            type_text(sys.argv[2])

        elif cmd == "key" and len(sys.argv) >= 3:
            modifiers = sys.argv[3].split(",") if len(sys.argv) >= 4 else None
            key_press(sys.argv[2], modifiers)

        elif cmd == "screenshot":
            path = sys.argv[2] if len(sys.argv) >= 3 else None
            result = screenshot(path)
            print(result)

        elif cmd == "screenshot-window" and len(sys.argv) >= 3:
            path = sys.argv[3] if len(sys.argv) >= 4 else None
            result = screenshot_window(sys.argv[2], path)
            print(result)

        elif cmd == "window" and len(sys.argv) >= 3:
            result = get_window(sys.argv[2])
            if result:
                print(f"{sys.argv[2]}: x={result['x']}, y={result['y']}, "
                      f"w={result['w']}, h={result['h']}")
            else:
                print(f"Could not get window info for: {sys.argv[2]}",
                      file=sys.stderr)
                sys.exit(1)

        elif cmd == "windows" and len(sys.argv) >= 3:
            windows = get_all_windows(sys.argv[2])
            for i, w in enumerate(windows):
                print(f'[{i}] x={w["x"]}, y={w["y"]}, '
                      f'w={w["w"]}, h={w["h"]} "{w["title"]}"')

        elif cmd == "activate" and len(sys.argv) >= 3:
            activate(sys.argv[2])
            print(f"Activated: {sys.argv[2]}")

        elif cmd == "list-apps":
            apps = list_apps()
            for app in apps:
                print(f"  - {app}")

        elif cmd == "calibrate":
            info = calibrate()
            print(json.dumps(info, indent=2))

        elif cmd == "scale-factor":
            sf = get_scale_factor()
            print(f"Scale factor: {sf}x")

        else:
            print(f"Unknown command or missing arguments: {cmd}",
                  file=sys.stderr)
            print(__doc__)
            sys.exit(1)

    except RuntimeError as e:
        if "CoreGraphics not found" in str(e):
            print(f"Error: {e}", file=sys.stderr)
            print("This tool requires macOS with CoreGraphics framework.",
                  file=sys.stderr)
            sys.exit(2)
        raise


if __name__ == "__main__":
    main()
