#!/usr/bin/env python3
"""
mac_control.py — Mac screen/keyboard/mouse control via CGEvent + Accessibility API
Zero dependencies. Python 3 stdlib only. macOS only.

Implements Phase 1 + Phase 2 of Issue #2216:
  - Phase 1: Basic tool wrappers (mouse, screenshot, coordinates, window bounds)
  - Phase 2: Chinese text input (clipboard-based, bypasses IME)

Usage:
    python3 mac_control.py <command> [args...]

Commands:
    click <x> <y>                    Left-click at (x, y)
    click --from-screenshot <x> <y>  Click at screenshot coords (auto Retina scale)
    doubleclick <x> <y>              Double-click at (x, y)
    rightclick <x> <y>               Right-click at (x, y)
    move <x> <y>                     Move cursor to (x, y)
    drag <x1> <y1> <x2> <y2>        Drag from (x1,y1) to (x2,y2)
    type "<text>"                    Type text via clipboard (CJK/emoji safe)
    key "<key>" [modifiers]          Press key with optional modifiers
    screenshot [path]                Capture screenshot
    window "<App>"                   Get front window bounds
    windows "<App>"                  List all windows with titles
    activate "<App>"                 Bring app to foreground
    find-element "<App>" "<name>"    Find UI element by accessibility label
    calibrate                        Detect Retina scaling factor
    cursor                           Get current cursor position
"""

import sys
import os
import platform
import subprocess
import shutil
import json
import re
import tempfile
import time

# ─── Platform Guard ────────────────────────────────────────────────────────────

def ensure_macos():
    """Exit gracefully if not on macOS."""
    if platform.system() != "Darwin":
        print(f"ERROR: mac_control requires macOS. Current platform: {platform.system()}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists("/usr/sbin/screencapture"):
        print("ERROR: screencapture not found. Is this a headless macOS?", file=sys.stderr)
        sys.exit(1)


# ─── CGEvent Bindings (Zero Dependencies) ──────────────────────────────────────

# CGEvent types
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

# CGEvent fields
kCGMouseEventClickState = 1
kCGMouseEventDeltaX = 2
kCGMouseEventDeltaY = 3
kCGKeyboardEventKeycode = 9

# CGEvent flags (modifier keys)
kCGEventFlagMaskCommand = 1 << 20
kCGEventFlagMaskShift = 1 << 17
kCGEventFlagMaskControl = 1 << 18
kCGEventFlagMaskAlternate = 1 << 19

# HID post location
kCGHIDEventTap = 0

# CoreGraphics library name
_CG_LIB = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"

_cg = None


def _get_cg():
    """Lazy-load CoreGraphics via ctypes."""
    global _cg
    if _cg is None:
        try:
            import ctypes
            _cg = ctypes.cdll.LoadLibrary(_CG_LIB)
        except OSError as e:
            print(f"ERROR: Cannot load CoreGraphics: {e}", file=sys.stderr)
            print("Make sure you're running on macOS with CoreGraphics available.", file=sys.stderr)
            sys.exit(1)
    return _cg


def _create_mouse_event(event_type, x, y):
    """Create a CGEvent mouse event at (x, y)."""
    cg = _get_cg()
    event = cg.CGEventCreateMouseEvent(None, event_type, (x, y), 0)
    if event is None:
        print(f"ERROR: Failed to create mouse event. Is Accessibility enabled?", file=sys.stderr)
        sys.exit(1)
    return event


def _post_event(event):
    """Post a CGEvent to the HID event tap."""
    cg = _get_cg()
    cg.CGEventPost(kCGHIDEventTap, event)
    # Flush the event
    cg.CFRelease(event)


# ─── Mouse Control ─────────────────────────────────────────────────────────────

def click(x, y):
    """Left-click at (x, y)."""
    down = _create_mouse_event(kCGEventLeftMouseDown, x, y)
    _get_cg().CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1)
    _post_event(down)

    up = _create_mouse_event(kCGEventLeftMouseUp, x, y)
    _get_cg().CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1)
    _post_event(up)


def double_click(x, y):
    """Double-click at (x, y)."""
    # First click
    down1 = _create_mouse_event(kCGEventLeftMouseDown, x, y)
    _get_cg().CGEventSetIntegerValueField(down1, kCGMouseEventClickState, 1)
    _post_event(down1)

    up1 = _create_mouse_event(kCGEventLeftMouseUp, x, y)
    _get_cg().CGEventSetIntegerValueField(up1, kCGMouseEventClickState, 1)
    _post_event(up1)

    # Second click
    down2 = _create_mouse_event(kCGEventLeftMouseDown, x, y)
    _get_cg().CGEventSetIntegerValueField(down2, kCGMouseEventClickState, 2)
    _post_event(down2)

    up2 = _create_mouse_event(kCGEventLeftMouseUp, x, y)
    _get_cg().CGEventSetIntegerValueField(up2, kCGMouseEventClickState, 2)
    _post_event(up2)


def right_click(x, y):
    """Right-click at (x, y)."""
    down = _create_mouse_event(kCGEventRightMouseDown, x, y)
    _get_cg().CGEventSetIntegerValueField(down, kCGMouseEventClickState, 1)
    _post_event(down)

    up = _create_mouse_event(kCGEventRightMouseUp, x, y)
    _get_cg().CGEventSetIntegerValueField(up, kCGMouseEventClickState, 1)
    _post_event(up)


def move(x, y):
    """Move cursor to (x, y) without clicking."""
    event = _create_mouse_event(kCGEventMouseMoved, x, y)
    _post_event(event)


def drag(x1, y1, x2, y2, steps=20):
    """Drag from (x1, y1) to (x2, y2)."""
    # Mouse down at start
    down = _create_mouse_event(kCGEventLeftMouseDown, x1, y1)
    _post_event(down)

    # Interpolate drag
    for i in range(1, steps + 1):
        t = i / steps
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t
        drag_event = _create_mouse_event(kCGEventLeftMouseDragged, cx, cy)
        _post_event(drag_event)
        time.sleep(0.01)

    # Mouse up at end
    up = _create_mouse_event(kCGEventLeftMouseUp, x2, y2)
    _post_event(up)


# ─── Keyboard Control ──────────────────────────────────────────────────────────

# Key name to virtual keycode mapping (macOS)
KEY_MAP = {
    "return": 36, "enter": 36, "tab": 48, "space": 49,
    "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "shift": 56, "capslock": 57,
    "option": 58, "alt": 58, "control": 59, "ctrl": 59,
    "right-shift": 60, "right-option": 61, "right-alt": 61,
    "right-control": 62, "right-ctrl": 62, "fn": 63,
    "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96,
    "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109,
    "f11": 103, "f12": 111,
    "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
    "left-arrow": 123, "right-arrow": 124, "down-arrow": 125, "up-arrow": 126,
    "left": 123, "right": 124, "down": 125, "up": 126,
}

# Modifier flags
MODIFIER_FLAGS = {
    "cmd": kCGEventFlagMaskCommand,
    "command": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "ctrl": kCGEventFlagMaskControl,
    "control": kCGEventFlagMaskControl,
    "alt": kCGEventFlagMaskAlternate,
    "option": kCGEventFlagMaskAlternate,
}


def _get_keycode(key_name):
    """Get macOS virtual keycode for a key name."""
    key_lower = key_name.lower()

    # Check key map
    if key_lower in KEY_MAP:
        return KEY_MAP[key_lower]

    # Single character
    if len(key_name) == 1:
        # Use osascript for character keycodes (simpler and more reliable)
        return None  # Will use osascript fallback

    raise ValueError(f"Unknown key: {key_name}")


def press_key(key_name, modifiers=None):
    """Press a key with optional modifiers using CGEvent."""
    cg = _get_cg()
    modifiers = modifiers or []
    mod_flags = 0
    for mod in modifiers:
        mod_lower = mod.lower()
        if mod_lower not in MODIFIER_FLAGS:
            raise ValueError(f"Unknown modifier: {mod}")
        mod_flags |= MODIFIER_FLAGS[mod_lower]

    # If it's a single character, use osascript for reliability
    if len(key_name) == 1 and key_name.isalnum():
        _press_key_osascript(key_name, modifiers)
        return

    keycode = _get_keycode(key_name)
    if keycode is None:
        _press_key_osascript(key_name, modifiers)
        return

    # Set modifier flags if any
    if mod_flags:
        flags_event = cg.CGEventCreateKeyboardEvent(None, 0, True)
        cg.CGEventSetFlags(flags_event, mod_flags)
        cg.CGEventPost(kCGHIDEventTap, flags_event)
        cg.CFRelease(flags_event)

    # Key down
    down = cg.CGEventCreateKeyboardEvent(None, keycode, True)
    if mod_flags:
        cg.CGEventSetFlags(down, mod_flags)
    cg.CGEventPost(kCGHIDEventTap, down)
    cg.CFRelease(down)

    # Key up
    up = cg.CGEventCreateKeyboardEvent(None, keycode, False)
    if mod_flags:
        cg.CGEventSetFlags(up, mod_flags)
    cg.CGEventPost(kCGHIDEventTap, up)
    cg.CFRelease(up)

    # Release modifier flags
    if mod_flags:
        flags_event = cg.CGEventCreateKeyboardEvent(None, 0, False)
        cg.CGEventSetFlags(flags_event, 0)
        cg.CGEventPost(kCGHIDEventTap, flags_event)
        cg.CFRelease(flags_event)


def _press_key_osascript(key_name, modifiers=None):
    """Press a key using osascript (AppleScript). More reliable for character keys."""
    modifiers = modifiers or []
    using_parts = []
    for mod in modifiers:
        using_parts.append(f"{mod.lower()} down")
    using_str = " using {" + ", ".join(using_parts) + "}" if using_parts else ""

    # Sanitize key_name for osascript
    if len(key_name) == 1 and key_name.isalpha():
        key_char = key_name.lower()
    elif key_name.lower() in ("return", "enter", "tab", "space", "escape", "esc"):
        key_char = key_name.lower()
    else:
        key_char = f'key code {KEY_MAP.get(key_name.lower(), 0)}'
        if using_str:
            script = f'tell application "System Events" to {key_char}{using_str}'
        else:
            script = f'tell application "System Events" to {key_char}'
        _run_osascript(script)
        return

    script = f'tell application "System Events" to keystroke "{key_char}"{using_str}'
    _run_osascript(script)


# ─── Text Input (Clipboard-based, CJK-safe) ────────────────────────────────────

def type_text(text):
    """Type text via clipboard (pbcopy + Cmd+V). Bypasses IME for CJK input."""

    # 1. Save current clipboard
    saved_clipboard = ""
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, text=True, timeout=2)
        saved_clipboard = result.stdout
    except Exception:
        pass  # Clipboard might be empty or unavailable

    # 2. Copy text to clipboard
    try:
        subprocess.run(["pbcopy"], input=text, text=True, check=True, timeout=2)
    except FileNotFoundError:
        print("ERROR: pbcopy not found. This requires macOS.", file=sys.stderr)
        sys.exit(1)

    # 3. Small delay for clipboard to settle
    time.sleep(0.05)

    # 4. Paste via Cmd+V (CGEvent)
    cg = _get_cg()

    # Cmd down
    cmd_down = cg.CGEventCreateKeyboardEvent(None, 55, True)  # 55 = Cmd keycode
    cg.CGEventSetFlags(cmd_down, kCGEventFlagMaskCommand)
    cg.CGEventPost(kCGHIDEventTap, cmd_down)
    cg.CFRelease(cmd_down)

    # V down
    v_down = cg.CGEventCreateKeyboardEvent(None, 9, True)  # 9 = V keycode
    cg.CGEventSetFlags(v_down, kCGEventFlagMaskCommand)
    cg.CGEventPost(kCGHIDEventTap, v_down)
    cg.CFRelease(v_down)

    # V up
    v_up = cg.CGEventCreateKeyboardEvent(None, 9, False)
    cg.CGEventSetFlags(v_up, kCGEventFlagMaskCommand)
    cg.CGEventPost(kCGHIDEventTap, v_up)
    cg.CFRelease(v_up)

    # Cmd up
    cmd_up = cg.CGEventCreateKeyboardEvent(None, 55, False)
    cg.CGEventPost(kCGHIDEventTap, cmd_up)
    cg.CFRelease(cmd_up)

    # 5. Restore clipboard after a delay
    time.sleep(0.1)
    try:
        subprocess.run(["pbcopy"], input=saved_clipboard, text=True, timeout=2)
    except Exception:
        pass


# ─── Screenshot ─────────────────────────────────────────────────────────────────

def screenshot(path="/tmp/screen.png"):
    """Capture screenshot using macOS screencapture."""
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)

    result = subprocess.run(
        ["/usr/sbin/screencapture", "-x", path],
        capture_output=True, text=True, timeout=10
    )

    if result.returncode != 0:
        print(f"ERROR: screencapture failed: {result.stderr}", file=sys.stderr)
        sys.exit(1)

    if not os.path.exists(path):
        print(f"ERROR: Screenshot file not created: {path}", file=sys.stderr)
        sys.exit(1)

    print(f"Screenshot saved: {path}")


# ─── Window Management ─────────────────────────────────────────────────────────

def _sanitize_app_name(name):
    """Sanitize app name to prevent AppleScript injection."""
    # Remove dangerous characters
    cleaned = re.sub(r'[\\\"\'\n\r]', '', name)
    return cleaned


def _run_osascript(script):
    """Run an osascript command safely."""
    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=10
    )
    if result.returncode != 0:
        print(f"ERROR: osascript failed: {result.stderr.strip()}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def get_window(app_name):
    """Get front window bounds for an app."""
    app = _sanitize_app_name(app_name)
    script = f'''
    tell application "{app}"
        set windowBounds to bounds of front window
        return windowBounds as text
    end tell
    '''
    output = _run_osascript(script)
    # Parse "0, 38, 1440, 900" format (left, top, right, bottom)
    parts = [p.strip() for p in output.split(",")]
    if len(parts) == 4:
        left, top, right, bottom = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        w = right - left
        h = bottom - top
        print(f'{app}: x={left}, y={top}, w={w}, h={h}')
        return {"x": left, "y": top, "w": w, "h": h}
    else:
        print(f"Unexpected window bounds format: {output}", file=sys.stderr)
        sys.exit(1)


def get_all_windows(app_name):
    """List all windows with titles for an app."""
    app = _sanitize_app_name(app_name)
    script = f'''
    tell application "{app}"
        set output to ""
        set winCount to count of windows
        repeat with i from 1 to winCount
            set winBounds to bounds of window i
            set winTitle to name of window i
            set output to output & "[" & (i - 1) & "] " & (item 1 of winBounds) & ", " & (item 2 of winBounds) & ", " & (item 3 of winBounds) & ", " & (item 4 of winBounds) & " \\"" & winTitle & "\\"" & linefeed
        end repeat
        return output
    end tell
    '''
    output = _run_osascript(script)
    print(output)
    return output


def activate_app(app_name):
    """Bring an app to the foreground."""
    app = _sanitize_app_name(app_name)
    _run_osascript(f'tell application "{app}" to activate')
    print(f"Activated: {app}")


# ─── UI Element Discovery (Accessibility API) ─────────────────────────────────

def find_element(app_name, element_name):
    """Find a UI element by accessibility label/name."""
    app = _sanitize_app_name(app_name)
    elem = _sanitize_app_name(element_name)

    script = f'''
    tell application "System Events"
        tell process "{app}"
            set found to ""
            try
                set targetElement to first UI element whose name contains "{elem}"
                set elemPos to position of targetElement
                set elemSize to size of targetElement
                set elemDesc to description of targetElement
                set found to "Found: \\"" & name of targetElement & "\\" " & elemDesc & " at (" & (item 1 of elemPos) & ", " & (item 2 of elemPos) & ") size (" & (item 1 of elemSize) & ", " & (item 2 of elemSize) & ")"
            on error errMsg
                set found to "NOT_FOUND: " & errMsg
            end try
            return found
        end tell
    end tell
    '''
    output = _run_osascript(script)
    print(output)
    return output


# ─── Coordinate Calibration ────────────────────────────────────────────────────

def calibrate():
    """Detect and report Retina scaling factor."""
    # Get physical screen size via system_profiler
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10
        )
        output = result.stdout
    except Exception as e:
        print(f"ERROR: Cannot detect display info: {e}", file=sys.stderr)
        sys.exit(1)

    # Parse resolution from system_profiler output
    # Look for "Resolution: 2880 x 1800" pattern
    resolution_match = re.search(r'Resolution:\s*(\d+)\s*x\s*(\d+)', output)
    if not resolution_match:
        print("Could not detect display resolution", file=sys.stderr)
        sys.exit(1)

    physical_w = int(resolution_match.group(1))
    physical_h = int(resolution_match.group(2))

    # Get logical screen size via osascript
    logical_script = '''
    tell application "Finder"
        set screenBounds to bounds of window of desktop
        return (item 3 of screenBounds) & "," & (item 4 of screenBounds)
    end tell
    '''
    try:
        logical_output = _run_osascript(logical_script)
        logical_parts = logical_output.split(",")
        logical_w = int(logical_parts[0].strip())
        logical_h = int(logical_parts[1].strip())
    except Exception:
        # Fallback: try NSScreen via Python
        try:
            import ctypes
            foundation = ctypes.cdll.LoadLibrary(
                "/System/Library/Frameworks/Foundation.framework/Foundation"
            )
            app_kit = ctypes.cdll.LoadLibrary(
                "/System/Library/Frameworks/AppKit.framework/AppKit"
            )
            # This is a simplified approach; real NSScreen access from ctypes is complex
            # Fallback to common defaults
            logical_w = physical_w // 2  # Assume 2x Retina
            logical_h = physical_h // 2
        except Exception:
            logical_w = physical_w // 2
            logical_h = physical_h // 2

    scale_factor = round(physical_w / logical_w, 1) if logical_w > 0 else 2.0

    print(f"scaleFactor={scale_factor}")
    print(f"physical={physical_w}x{physical_h}")
    print(f"logical={logical_w}x{logical_h}")
    print(f"\nWhen clicking from screenshot coordinates:")
    if scale_factor > 1.5:
        print(f"  Divide screenshot coords by {int(scale_factor)} for CGEvent coords")
        print(f"  Or use: click --from-screenshot <x> <y>")
    else:
        print(f"  No conversion needed (1:1 mapping)")

    return {
        "scaleFactor": scale_factor,
        "physical": {"w": physical_w, "h": physical_h},
        "logical": {"w": logical_w, "h": logical_h},
    }


def get_cursor_position():
    """Get current cursor position using CGEvent."""
    cg = _get_cg()
    import ctypes

    class CGPoint(ctypes.Structure):
        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]

    loc = CGPoint()
    cg.CGEventGetLocation(ctypes.byref(loc))
    print(f"Cursor position: ({loc.x:.0f}, {loc.y:.0f})")
    return {"x": loc.x, "y": loc.y}


# ─── CLI ────────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(0)

    command = sys.argv[1]

    # Platform check for commands that need macOS
    if command not in ("help", "--help", "-h"):
        ensure_macos()

    if command == "click":
        from_screenshot = False
        args = sys.argv[2:]
        if "--from-screenshot" in args:
            from_screenshot = True
            args.remove("--from-screenshot")
        if len(args) != 2:
            print("Usage: click [--from-screenshot] <x> <y>", file=sys.stderr)
            sys.exit(1)
        x, y = float(args[0]), float(args[1])
        if from_screenshot:
            # Auto-scale for Retina
            try:
                sf = _detect_scale_factor()
                x /= sf
                y /= sf
            except Exception:
                pass  # Assume 1:1 if detection fails
        click(x, y)

    elif command == "doubleclick":
        if len(sys.argv) != 4:
            print("Usage: doubleclick <x> <y>", file=sys.stderr)
            sys.exit(1)
        double_click(float(sys.argv[2]), float(sys.argv[3]))

    elif command == "rightclick":
        if len(sys.argv) != 4:
            print("Usage: rightclick <x> <y>", file=sys.stderr)
            sys.exit(1)
        right_click(float(sys.argv[2]), float(sys.argv[3]))

    elif command == "move":
        if len(sys.argv) != 4:
            print("Usage: move <x> <y>", file=sys.stderr)
            sys.exit(1)
        move(float(sys.argv[2]), float(sys.argv[3]))

    elif command == "drag":
        if len(sys.argv) != 6:
            print("Usage: drag <x1> <y1> <x2> <y2>", file=sys.stderr)
            sys.exit(1)
        drag(
            float(sys.argv[2]), float(sys.argv[3]),
            float(sys.argv[4]), float(sys.argv[5])
        )

    elif command == "type":
        if len(sys.argv) < 3:
            print("Usage: type \"<text>\"", file=sys.stderr)
            sys.exit(1)
        text = " ".join(sys.argv[2:])
        type_text(text)

    elif command == "key":
        if len(sys.argv) < 3:
            print("Usage: key \"<key>\" [modifiers...]", file=sys.stderr)
            sys.exit(1)
        key_name = sys.argv[2]
        modifiers = sys.argv[3:] if len(sys.argv) > 3 else []
        press_key(key_name, modifiers)

    elif command == "screenshot":
        path = sys.argv[2] if len(sys.argv) > 2 else "/tmp/screen.png"
        screenshot(path)

    elif command == "window":
        if len(sys.argv) != 3:
            print("Usage: window \"<App Name>\"", file=sys.stderr)
            sys.exit(1)
        get_window(sys.argv[2])

    elif command == "windows":
        if len(sys.argv) != 3:
            print("Usage: windows \"<App Name>\"", file=sys.stderr)
            sys.exit(1)
        get_all_windows(sys.argv[2])

    elif command == "activate":
        if len(sys.argv) != 3:
            print("Usage: activate \"<App Name>\"", file=sys.stderr)
            sys.exit(1)
        activate_app(sys.argv[2])

    elif command == "find-element":
        if len(sys.argv) != 4:
            print("Usage: find-element \"<App>\" \"<element name>\"", file=sys.stderr)
            sys.exit(1)
        find_element(sys.argv[2], sys.argv[3])

    elif command == "calibrate":
        calibrate()

    elif command == "cursor":
        get_cursor_position()

    elif command in ("help", "--help", "-h"):
        print(__doc__)

    else:
        print(f"Unknown command: {command}", file=sys.stderr)
        print("Run 'python3 mac_control.py help' for usage.", file=sys.stderr)
        sys.exit(1)


def _detect_scale_factor():
    """Quick scale factor detection (used by --from-screenshot)."""
    try:
        result = subprocess.run(
            ["system_profiler", "SPDisplaysDataType"],
            capture_output=True, text=True, timeout=10
        )
        match = re.search(r'Resolution:\s*(\d+)\s*x\s*(\d+)', result.stdout)
        if match:
            physical_w = int(match.group(1))
            # Common Retina resolutions: 2880, 2560, 3072, 3456 → scale 2
            if physical_w > 2000:
                return 2.0
        return 1.0
    except Exception:
        return 1.0


if __name__ == "__main__":
    main()
