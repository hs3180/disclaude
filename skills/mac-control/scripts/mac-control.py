#!/usr/bin/env python3
"""
macOS native control via CGEvent (CoreGraphics) using ctypes.

Zero external dependencies — uses only Python stdlib + macOS CoreGraphics.

Implements Phase 1 of Issue #2216:
- Screenshot capture
- Mouse control (click, double-click, right-click, move, drag)
- Keyboard input (type via clipboard for CJK, key press with modifiers)

Usage:
  python3 mac-control.py screenshot [--output PATH] [--region X,Y,W,H] [--cursor]
  python3 mac-control.py click --x X --y Y [--double] [--right]
  python3 mac-control.py move --x X --y Y
  python3 mac-control.py drag --from-x X --from-y Y --to-x X --to-y Y
  python3 mac-control.py type --text TEXT
  python3 mac-control.py key --key KEY [--modifiers MOD1,MOD2]
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ─── Platform Check ───────────────────────────────────────────────────────────

if sys.platform != "darwin":
    print(json.dumps({
        "success": False,
        "error": f"Not macOS: {sys.platform}. This tool requires macOS with CoreGraphics.",
    }))
    sys.exit(1)

try:
    import ctypes
    import ctypes.util
except ImportError:
    print(json.dumps({"success": False, "error": "ctypes not available"}))
    sys.exit(1)

# ─── CoreGraphics Bindings via ctypes ─────────────────────────────────────────

def _load_coregraphics():
    """Load CoreGraphics framework via ctypes."""
    lib_path = ctypes.util.find_library("CoreGraphics")
    if not lib_path:
        # Try direct framework path
        lib_path = "/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics"
    if not os.path.exists(lib_path):
        raise RuntimeError("CoreGraphics framework not found")
    return ctypes.CDLL(lib_path)


def _load_appkit():
    """Load AppKit framework for NSScreen (scale factor)."""
    lib_path = ctypes.util.find_library("AppKit")
    if not lib_path:
        lib_path = "/System/Library/Frameworks/AppKit.framework/AppKit"
    if not os.path.exists(lib_path):
        return None
    return ctypes.CDLL(lib_path)


# Load lazily
_cg = None
_appkit = None


def _get_cg():
    global _cg
    if _cg is None:
        _cg = _load_coregraphics()
    return _cg


def _get_appkit():
    global _appkit
    if _appkit is None:
        _appkit = _load_appkit()
    return _appkit


# ─── Constants ────────────────────────────────────────────────────────────────

# CGEventType
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

# CGMouseButton
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1

# CGEventFlags (modifier keys)
kCGEventFlagMaskCommand = 0x00100000
kCGEventFlagMaskShift = 0x00020000
kCGEventFlagMaskControl = 0x00040000
kCGEventFlagMaskAlternate = 0x00080000

# Event fields
kCGMouseEventClickState = 1
kCGEventSourceStateHIDSystemState = 1

# ─── Helper Functions ─────────────────────────────────────────────────────────


def _create_event_source():
    """Create a CGEventSource from HID system state."""
    cg = _get_cg()
    return cg.CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


def _get_scale_factor():
    """Get the main screen's backing scale factor using NSScreen."""
    try:
        # Use subprocess to get scale factor via Python one-liner with AppKit bridge
        result = subprocess.run(
            [
                sys.executable, "-c",
                "import AppKit; screen = AppKit.NSScreen.mainScreen(); "
                "print(screen.backingScaleFactor())",
            ],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return float(result.stdout.strip())
    except Exception:
        pass
    # Default: assume Retina (2x) on modern Macs
    return 2.0


def _json_result(success: bool, **kwargs):
    """Print JSON result and exit."""
    output = {"success": success, **kwargs}
    print(json.dumps(output, ensure_ascii=False))
    sys.exit(0 if success else 1)


# ─── Screenshot ───────────────────────────────────────────────────────────────


def cmd_screenshot(args):
    """Take a screenshot using macOS screencapture command."""
    output_path = args.output or os.path.join(
        tempfile.gettempdir(),
        f"mac-screenshot-{int(time.time())}.png",
    )

    cmd = ["screencapture", "-x"]  # -x: no sound
    if args.cursor:
        cmd.append("-C")  # include cursor
    if args.region:
        cmd.extend(["-R", args.region])
    cmd.append(output_path)

    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            _json_result(False, error=f"screencapture failed: {result.stderr.strip()}")

        # Get image dimensions
        scale = _get_scale_factor()
        width_cmd = ["sips", "-g", "pixelWidth", "-g", "pixelHeight", output_path]
        dim_result = subprocess.run(width_cmd, capture_output=True, text=True, timeout=5)

        width, height = 0, 0
        if dim_result.returncode == 0:
            for line in dim_result.stdout.splitlines():
                if "pixelWidth" in line:
                    width = int(line.split(":")[-1].strip())
                elif "pixelHeight" in line:
                    height = int(line.split(":")[-1].strip())

        _json_result(
            True,
            path=output_path,
            width=width,
            height=height,
            scaleFactor=scale,
            logicalWidth=width / scale if scale > 0 else width,
            logicalHeight=height / scale if scale > 0 else height,
        )
    except FileNotFoundError:
        _json_result(False, error="screencapture not found. Are you on macOS?")
    except subprocess.TimeoutExpired:
        _json_result(False, error="screencapture timed out")


# ─── Mouse Control ────────────────────────────────────────────────────────────


def _mouse_event(event_type, x, y, button=kCGMouseButtonLeft, click_state=1, source=None):
    """Create and post a mouse CGEvent."""
    cg = _get_cg()
    if source is None:
        source = _create_event_source()

    event = cg.CGEventCreateMouseEvent(source, event_type, (x, y), button)
    if not event:
        raise RuntimeError("CGEventCreateMouseEvent returned null — check Accessibility permission")

    if click_state > 0:
        cg.CGEventSetIntegerValueField(event, kCGMouseEventClickState, click_state)

    cg.CGEventPost(0, event)  # 0 = kCGHIDEventTap


def cmd_click(args):
    """Click at the given coordinates."""
    x, y = args.x, args.y

    try:
        source = _create_event_source()
        click_count = 2 if args.double else 1
        button = kCGMouseButtonRight if args.right else kCGMouseButtonLeft

        if args.right:
            down_event = kCGEventRightMouseDown
            up_event = kCGEventRightMouseUp
        else:
            down_event = kCGEventLeftMouseDown
            up_event = kCGEventLeftMouseUp

        _mouse_event(down_event, x, y, button, click_count, source)
        time.sleep(0.02)
        _mouse_event(up_event, x, y, button, click_count, source)

        click_type = "right-click" if args.right else "double-click" if args.double else "click"
        _json_result(True, action=click_type, x=x, y=y)
    except RuntimeError as e:
        _json_result(False, error=str(e))


def cmd_move(args):
    """Move mouse to given coordinates."""
    try:
        _mouse_event(kCGEventMouseMoved, args.x, args.y)
        _json_result(True, action="move", x=args.x, y=args.y)
    except RuntimeError as e:
        _json_result(False, error=str(e))


def cmd_drag(args):
    """Drag from one point to another."""
    try:
        source = _create_event_source()
        # Move to start
        _mouse_event(kCGEventMouseMoved, args.from_x, args.from_y, source=source)
        time.sleep(0.05)
        # Mouse down
        _mouse_event(kCGEventLeftMouseDown, args.from_x, args.from_y, source=source)
        time.sleep(0.05)
        # Drag
        steps = 10
        for i in range(1, steps + 1):
            progress = i / steps
            cx = args.from_x + (args.to_x - args.from_x) * progress
            cy = args.from_y + (args.to_y - args.from_y) * progress
            _mouse_event(kCGEventLeftMouseDragged, cx, cy, source=source)
            time.sleep(0.02)
        # Mouse up
        _mouse_event(kCGEventLeftMouseUp, args.to_x, args.to_y, source=source)

        _json_result(True, action="drag",
                     fromX=args.from_x, fromY=args.from_y,
                     toX=args.to_x, toY=args.to_y)
    except RuntimeError as e:
        _json_result(False, error=str(e))


# ─── Keyboard Input ───────────────────────────────────────────────────────────

# Key name to virtual keycode mapping (macOS)
KEY_MAP = {
    "return": 0x24, "enter": 0x24,
    "tab": 0x30,
    "space": 0x31,
    "delete": 0x33, "backspace": 0x33,
    "escape": 0x35, "esc": 0x35,
    "up": 0x7E, "down": 0x7D, "left": 0x7B, "right": 0x7C,
    "home": 0x73, "end": 0x77,
    "pageup": 0x74, "pagedown": 0x79,
    "f1": 0x7A, "f2": 0x78, "f3": 0x63, "f4": 0x76,
    "f5": 0x60, "f6": 0x61, "f7": 0x62, "f8": 0x64,
    "f9": 0x65, "f10": 0x6D, "f11": 0x67, "f12": 0x6F,
}

# Modifier name to CGEventFlag
MODIFIER_MAP = {
    "command": kCGEventFlagMaskCommand, "cmd": kCGEventFlagMaskCommand,
    "shift": kCGEventFlagMaskShift,
    "control": kCGEventFlagMaskControl, "ctrl": kCGEventFlagMaskControl,
    "option": kCGEventFlagMaskAlternate, "alt": kCGEventFlagMaskAlternate,
}

# ASCII char to virtual keycode
_CHAR_TO_KEYCODE = {
    "a": 0x00, "b": 0x0B, "c": 0x08, "d": 0x02, "e": 0x0E, "f": 0x03,
    "g": 0x05, "h": 0x04, "i": 0x22, "j": 0x26, "k": 0x28, "l": 0x25,
    "m": 0x2E, "n": 0x2D, "o": 0x1F, "p": 0x23, "q": 0x0C, "r": 0x0F,
    "s": 0x01, "t": 0x11, "u": 0x20, "v": 0x09, "w": 0x0D, "x": 0x07,
    "y": 0x10, "z": 0x06,
    "0": 0x1D, "1": 0x12, "2": 0x13, "3": 0x14, "4": 0x15,
    "5": 0x17, "6": 0x16, "7": 0x1A, "8": 0x1C, "9": 0x19,
    "-": 0x1B, "=": 0x18, "[": 0x21, "]": 0x1E, "\\": 0x2A,
    ";": 0x29, "'": 0x27, ",": 0x2B, ".": 0x2F, "/": 0x2C,
    "`": 0x32,
}


def _has_cjk(text):
    """Check if text contains CJK or other non-ASCII characters that need clipboard paste."""
    return any(ord(c) > 127 for c in text)


def _get_clipboard_content():
    """Save current clipboard content."""
    try:
        result = subprocess.run(["pbpaste"], capture_output=True, timeout=3)
        return result.stdout
    except Exception:
        return b""


def _set_clipboard_content(data):
    """Restore clipboard content."""
    try:
        proc = subprocess.run(["pbcopy"], input=data, timeout=3)
    except Exception:
        pass


def _type_via_clipboard(text):
    """Type text using clipboard paste method (handles CJK correctly)."""
    # Save clipboard
    old_clipboard = _get_clipboard_content()

    try:
        # Set clipboard
        proc = subprocess.run(["pbcopy"], input=text.encode("utf-8"), timeout=3)
        if proc.returncode != 0:
            raise RuntimeError("pbcopy failed")

        time.sleep(0.05)

        # Paste with Cmd+V
        cmd_key(args=argparse.Namespace(key="v", modifiers="command"))

        time.sleep(0.1)
    finally:
        # Restore clipboard
        time.sleep(0.05)
        _set_clipboard_content(old_clipboard)


def cmd_type(args):
    """Type text, using clipboard paste for CJK characters."""
    text = args.text

    if not text:
        _json_result(False, error="No text provided")

    if _has_cjk(text):
        _type_via_clipboard(text)
        _json_result(True, action="type", method="clipboard_paste", length=len(text))
    else:
        # For pure ASCII, use CGEvent key events character by character
        try:
            cg = _get_cg()
            source = _create_event_source()

            for char in text:
                keycode = _CHAR_TO_KEYCODE.get(char.lower())
                if keycode is None:
                    # Fallback to clipboard for unsupported chars
                    _type_via_clipboard(char)
                    continue

                shift = char.isupper() or char in '!@#$%^&*()_+{}|:"<>?~'

                # Key down
                event = cg.CGEventCreateKeyboardEvent(source, keycode, True)
                if not event:
                    continue
                if shift:
                    cg.CGEventSetFlags(event, kCGEventFlagMaskShift)
                cg.CGEventPost(0, event)

                time.sleep(0.01)

                # Key up
                event = cg.CGEventCreateKeyboardEvent(source, keycode, False)
                if not event:
                    continue
                if shift:
                    cg.CGEventSetFlags(event, kCGEventFlagMaskShift)
                cg.CGEventPost(0, event)

                time.sleep(0.01)

            _json_result(True, action="type", method="cgevent_key", length=len(text))
        except RuntimeError as e:
            _json_result(False, error=str(e))


def cmd_key(args):
    """Press a key with optional modifiers."""
    key_name = args.key.lower()
    keycode = KEY_MAP.get(key_name)
    if keycode is None and len(key_name) == 1:
        keycode = _CHAR_TO_KEYCODE.get(key_name)
    if keycode is None:
        _json_result(False, error=f"Unknown key: {args.key}. "
                     f"Available: {', '.join(sorted(KEY_MAP.keys()))}")

    # Parse modifiers
    flags = 0
    if args.modifiers:
        for mod in args.modifiers.split(","):
            mod = mod.strip().lower()
            flag = MODIFIER_MAP.get(mod)
            if flag is None:
                _json_result(False, error=f"Unknown modifier: {mod}. "
                             f"Available: {', '.join(sorted(MODIFIER_MAP.keys()))}")
            flags |= flag

    try:
        cg = _get_cg()
        source = _create_event_source()

        # Set modifier flags first
        if flags:
            mod_event = cg.CGEventCreateKeyboardEvent(source, 0, True)
            if mod_event:
                cg.CGEventSetFlags(mod_event, flags)
                cg.CGEventPost(0, mod_event)
                time.sleep(0.02)

        # Key down
        event = cg.CGEventCreateKeyboardEvent(source, keycode, True)
        if not event:
            raise RuntimeError("CGEventCreateKeyboardEvent returned null — check Accessibility permission")
        if flags:
            cg.CGEventSetFlags(event, flags)
        cg.CGEventPost(0, event)

        time.sleep(0.02)

        # Key up
        event = cg.CGEventCreateKeyboardEvent(source, keycode, False)
        if event:
            if flags:
                cg.CGEventSetFlags(event, flags)
            cg.CGEventPost(0, event)

        time.sleep(0.02)

        # Release modifiers
        if flags:
            mod_event = cg.CGEventCreateKeyboardEvent(source, 0, False)
            if mod_event:
                cg.CGEventSetFlags(mod_event, 0)
                cg.CGEventPost(0, mod_event)

        _json_result(True, action="key", key=args.key, modifiers=args.modifiers or "")
    except RuntimeError as e:
        _json_result(False, error=str(e))


# ─── CLI Entry Point ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="macOS native control via CGEvent (CoreGraphics)",
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # screenshot
    p = subparsers.add_parser("screenshot", help="Take a screenshot")
    p.add_argument("--output", "-o", help="Output file path (default: /tmp/mac-screenshot-*.png)")
    p.add_argument("--region", "-r", help="Region to capture: X,Y,W,H")
    p.add_argument("--cursor", action="store_true", help="Include cursor in screenshot")

    # click
    p = subparsers.add_parser("click", help="Click at coordinates")
    p.add_argument("--x", type=float, required=True, help="X coordinate (logical points)")
    p.add_argument("--y", type=float, required=True, help="Y coordinate (logical points)")
    p.add_argument("--double", action="store_true", help="Double-click")
    p.add_argument("--right", action="store_true", help="Right-click")

    # move
    p = subparsers.add_parser("move", help="Move mouse to coordinates")
    p.add_argument("--x", type=float, required=True, help="X coordinate")
    p.add_argument("--y", type=float, required=True, help="Y coordinate")

    # drag
    p = subparsers.add_parser("drag", help="Drag from one point to another")
    p.add_argument("--from-x", type=float, required=True, help="Start X")
    p.add_argument("--from-y", type=float, required=True, help="Start Y")
    p.add_argument("--to-x", type=float, required=True, help="End X")
    p.add_argument("--to-y", type=float, required=True, help="End Y")

    # type
    p = subparsers.add_parser("type", help="Type text (supports CJK)")
    p.add_argument("--text", "-t", required=True, help="Text to type")

    # key
    p = subparsers.add_parser("key", help="Press a key with optional modifiers")
    p.add_argument("--key", "-k", required=True, help="Key name (e.g., return, tab, v)")
    p.add_argument("--modifiers", "-m", help="Comma-separated modifiers (e.g., command,shift)")

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
    }

    handler = commands.get(args.command)
    if handler:
        handler(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
