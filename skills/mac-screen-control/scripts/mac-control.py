#!/usr/bin/env python3
"""
macOS Screen Control - CGEvent and Accessibility API automation.

Provides mouse control, keyboard input, screenshot capture, and UI element
interaction via macOS native APIs.

Usage:
    python3 mac-control.py <command> [options]

Commands:
    screenshot    Capture screenshot
    click         Click at coordinates
    move          Move mouse to coordinates
    drag          Drag from A to B
    type          Type text (supports CJK via clipboard)
    key           Press key combination
    window        Get window info
    activate      Bring app to front
    mousepos      Get current mouse position
    find-element  Find AX elements
    ax-tree       Print accessibility tree
    calibrate     Show screen/scale info
    check         Check prerequisites
"""

import argparse
import json
import os
import subprocess
import sys
import time
import tempfile
import shutil

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _run(cmd, capture=True):
    """Run a shell command and return output."""
    result = subprocess.run(
        cmd, shell=True, capture_output=capture, text=True
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def _osascript(script):
    """Run an AppleScript snippet."""
    out, err, rc = _run(f'osascript -e \'{script}\'')
    if rc != 0:
        raise RuntimeError(f"AppleScript error: {err}")
    return out


def _is_macos():
    return sys.platform == "darwin"


def _get_scale_factor():
    """Get the main display's backing scale factor (1x or 2x for Retina)."""
    if not _is_macos():
        return 1.0
    script = (
        'use framework "AppKit"\n'
        'set mainScreen to current application\'s NSScreen\'s mainScreen()\n'
        'set sf to (mainScreen\'s backingScaleFactor()) as real\n'
        'return sf'
    )
    try:
        out = _osascript(script)
        return float(out)
    except Exception:
        # Fallback: check if Retina by comparing pixel dimensions
        out, _, _ = _run("system_profiler SPDisplaysDataType | grep Resolution")
        return 2.0  # Assume Retina on modern Macs


def _save_clipboard():
    """Save current clipboard content to a temp file."""
    tmp = tempfile.mktemp(suffix=".clipboard")
    _run("pbpaste > " + tmp)
    return tmp


def _restore_clipboard(tmp_path):
    """Restore clipboard from a temp file."""
    if os.path.exists(tmp_path):
        _run("pbcopy < " + tmp_path)
        os.unlink(tmp_path)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_check(args):
    """Check prerequisites for mac-screen-control."""
    issues = []
    if not _is_macos():
        issues.append("Not running on macOS — this skill requires macOS")
        return json.dumps({"ok": False, "issues": issues})

    # Check Python modules
    try:
        import Quartz  # noqa: F401
    except ImportError:
        issues.append("pyobjc-framework-Quartz not installed. Run: pip install pyobjc-framework-Quartz")

    # Check screencapture
    _, _, rc = _run("which screencapture")
    if rc != 0:
        issues.append("screencapture not found")

    # Check osascript
    _, _, rc = _run("which osascript")
    if rc != 0:
        issues.append("osascript not found")

    return json.dumps({
        "ok": len(issues) == 0,
        "issues": issues,
        "platform": sys.platform,
        "scale_factor": _get_scale_factor() if len(issues) == 0 else None,
    })


def cmd_screenshot(args):
    """Capture a screenshot."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    output = args.output or tempfile.mktemp(suffix=".png")
    cmd_parts = ["screencapture", "-x"]

    if args.region:
        # Region format: x,y,w,h
        cmd_parts.extend(["-R", args.region])

    if args.display:
        cmd_parts.extend(["-D", str(args.display)])

    cmd_parts.append(output)
    _, err, rc = _run(" ".join(cmd_parts))

    if rc != 0:
        return json.dumps({"ok": False, "error": err})

    scale = _get_scale_factor()
    return json.dumps({
        "ok": True,
        "path": output,
        "scale_factor": scale,
        "note": "Coordinates in image are pixels. Divide by scale_factor for logical points (CGEvent coords)."
    })


def cmd_click(args):
    """Click at the given coordinates."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    try:
        import Quartz
    except ImportError:
        # Fallback to cliclick if available
        _, _, rc = _run("which cliclick")
        if rc != 0:
            return json.dumps({"ok": False, "error": "Neither pyobjc-framework-Quartz nor cliclick available"})
        click_type = ""
        if args.button == "right":
            click_type = "rc:"
        elif args.double:
            click_type = "dc:"
        else:
            click_type = "c:"
        _, err, rc = _run(f"cliclick {click_type}{args.x},{args.y}")
        return json.dumps({"ok": rc == 0, "error": err if rc != 0 else None})

    x, y = float(args.x), float(args.y)

    # Map button type to CGEvent type
    if args.button == "right":
        down_type = Quartz.kCGEventRightMouseDown
        up_type = Quartz.kCGEventRightMouseUp
    else:
        down_type = Quartz.kCGEventLeftMouseDown
        up_type = Quartz.kCGEventLeftMouseUp

    click_count = 2 if args.double else 1

    # Create and post events
    for evt_type in [down_type, up_type]:
        event = Quartz.CGEventCreateMouseEvent(
            None, evt_type, (x, y), Quartz.kCGMouseButtonLeft
        )
        Quartz.CGEventSetIntegerValueField(event, Quartz.kCGMouseEventClickState, click_count)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

    return json.dumps({"ok": True, "x": x, "y": y, "button": args.button, "double": args.double})


def cmd_move(args):
    """Move mouse to coordinates without clicking."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    try:
        import Quartz
    except ImportError:
        _, _, rc = _run("which cliclick")
        if rc != 0:
            return json.dumps({"ok": False, "error": "Neither pyobjc-framework-Quartz nor cliclick available"})
        _, err, rc = _run(f"cliclick m:{args.x},{args.y}")
        return json.dumps({"ok": rc == 0, "error": err if rc != 0 else None})

    x, y = float(args.x), float(args.y)
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventMouseMoved, (x, y), Quartz.kCGMouseButtonLeft
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    return json.dumps({"ok": True, "x": x, "y": y})


def cmd_drag(args):
    """Drag from one point to another."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    try:
        import Quartz
    except ImportError:
        return json.dumps({"ok": False, "error": "pyobjc-framework-Quartz required for drag"})

    x1, y1 = float(args.x1), float(args.y1)
    x2, y2 = float(args.x2), float(args.y2)

    # Move to start
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventMouseMoved, (x1, y1), Quartz.kCGMouseButtonLeft
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
    time.sleep(0.05)

    # Mouse down
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventLeftMouseDown, (x1, y1), Quartz.kCGMouseButtonLeft
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

    # Drag with smooth movement (10 steps)
    steps = 10
    for i in range(1, steps + 1):
        cx = x1 + (x2 - x1) * i / steps
        cy = y1 + (y2 - y1) * i / steps
        event = Quartz.CGEventCreateMouseEvent(
            None, Quartz.kCGEventLeftMouseDragged, (cx, cy), Quartz.kCGMouseButtonLeft
        )
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
        time.sleep(0.02)

    # Mouse up
    event = Quartz.CGEventCreateMouseEvent(
        None, Quartz.kCGEventLeftMouseUp, (x2, y2), Quartz.kCGMouseButtonLeft
    )
    Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

    return json.dumps({"ok": True, "from": [x1, y1], "to": [x2, y2]})


def cmd_type(args):
    """Type text. ASCII via key events; non-ASCII (CJK, emoji) via clipboard paste."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    text = args.text
    if not text:
        return json.dumps({"ok": False, "error": "No text provided"})

    delay_ms = args.delay or 10
    is_ascii = all(ord(c) < 128 for c in text)

    if is_ascii:
        return _type_via_cgevent(text, delay_ms)
    else:
        return _type_via_clipboard(text)


def _type_via_cgevent(text, delay_ms):
    """Type ASCII text using CGEvent key events."""
    try:
        import Quartz
    except ImportError:
        # Fallback to osascript
        escaped = text.replace("\\", "\\\\").replace('"', '\\"')
        _, err, rc = _run(f'osascript -e \'tell application "System Events" to keystroke "{escaped}"\'')
        return json.dumps({"ok": rc == 0, "method": "osascript", "error": err if rc != 0 else None})

    # Key code mapping for common characters
    key_map = {
        'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
        'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31,
        'p': 35, 'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9,
        'w': 13, 'x': 7, 'y': 16, 'z': 6,
        '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
        '6': 22, '7': 26, '8': 28, '9': 25,
        ' ': 49, '\n': 36, '\t': 48,
        '.': 47, ',': 43, '/': 44, ';': 41, '\'': 39,
        '[': 33, ']': 30, '\\': 42, '-': 27, '=': 24,
        '`': 50,
    }

    for char in text:
        is_upper = char.isupper()
        lower_char = char.lower()

        if lower_char in key_map:
            keycode = key_map[lower_char]
            flags = Quartz.kCGEventFlagMaskShift if is_upper else 0

            event = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
            if flags:
                Quartz.CGEventSetFlags(event, flags)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

            event = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
            if flags:
                Quartz.CGEventSetFlags(event, flags)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

        time.sleep(delay_ms / 1000.0)

    return json.dumps({"ok": True, "method": "cgevent", "chars": len(text)})


def _type_via_clipboard(text):
    """Type non-ASCII text using clipboard paste (pbcopy + Cmd+V).

    This is the most reliable method for CJK, emoji, and composed characters.
    Saves and restores clipboard contents to be non-destructive.
    """
    saved = _save_clipboard()
    try:
        # Write text to clipboard
        escaped = text.replace("'", "'\\''")
        _, err, rc = _run(f"echo -n '{escaped}' | pbcopy")
        if rc != 0:
            return json.dumps({"ok": False, "error": f"pbcopy failed: {err}"})

        time.sleep(0.05)

        # Press Cmd+V to paste
        try:
            import Quartz
            # Cmd down
            cmd_down = Quartz.CGEventCreateKeyboardEvent(None, 55, True)
            Quartz.CGEventSetFlags(cmd_down, Quartz.kCGEventFlagMaskCommand)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, cmd_down)

            # V down
            v_down = Quartz.CGEventCreateKeyboardEvent(None, 9, True)
            Quartz.CGEventSetFlags(v_down, Quartz.kCGEventFlagMaskCommand)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, v_down)

            # V up
            v_up = Quartz.CGEventCreateKeyboardEvent(None, 9, False)
            Quartz.CGEventSetFlags(v_up, Quartz.kCGEventFlagMaskCommand)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, v_up)

            # Cmd up
            cmd_up = Quartz.CGEventCreateKeyboardEvent(None, 55, False)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, cmd_up)

        except ImportError:
            # Fallback to osascript
            _, err, rc = _run('osascript -e \'tell application "System Events" to keystroke "v" using command down\'')
            if rc != 0:
                return json.dumps({"ok": False, "error": f"Paste failed: {err}"})

        time.sleep(0.1)
        return json.dumps({"ok": True, "method": "clipboard_paste", "chars": len(text)})
    finally:
        # Restore clipboard (async, non-blocking)
        time.sleep(0.2)
        _restore_clipboard(saved)


def cmd_key(args):
    """Press a key combination."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    key_name = args.key.lower()

    # Key code mapping
    key_codes = {
        'return': 36, 'enter': 36, 'tab': 48, 'escape': 53, 'esc': 53,
        'delete': 51, 'backspace': 51, 'space': 49,
        'up': 126, 'down': 125, 'left': 123, 'right': 124,
        'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
        'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96,
        'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109,
        'f11': 103, 'f12': 111,
        'cmd': 55, 'command': 55, 'shift': 56, 'ctrl': 59, 'control': 59,
        'alt': 58, 'option': 58, 'opt': 58,
        'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5,
        'h': 4, 'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45,
        'o': 31, 'p': 35, 'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32,
        'v': 9, 'w': 13, 'x': 7, 'y': 16, 'z': 6,
        '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
        '6': 22, '7': 26, '8': 28, '9': 25,
    }

    modifiers = [m.lower() for m in (args.with_mods or [])]
    modifier_flags = 0
    for mod in modifiers:
        if mod in ('cmd', 'command'):
            modifier_flags |= Quartz.kCGEventFlagMaskCommand if 'Quartz' in sys.modules else 0
        elif mod in ('shift',):
            modifier_flags |= Quartz.kCGEventFlagMaskShift if 'Quartz' in sys.modules else 0
        elif mod in ('ctrl', 'control'):
            modifier_flags |= Quartz.kCGEventFlagMaskControl if 'Quartz' in sys.modules else 0
        elif mod in ('alt', 'option', 'opt'):
            modifier_flags |= Quartz.kCGEventFlagMaskAlternate if 'Quartz' in sys.modules else 0

    if key_name not in key_codes:
        return json.dumps({"ok": False, "error": f"Unknown key: {args.key}"})

    keycode = key_codes[key_name]

    try:
        import Quartz

        # Build modifier keycodes for hold/release
        modifier_keycodes = []
        for mod in modifiers:
            if mod in key_codes:
                modifier_keycodes.append(key_codes[mod])

        # Hold modifier keys
        for mk in modifier_keycodes:
            event = Quartz.CGEventCreateKeyboardEvent(None, mk, True)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)
            time.sleep(0.02)

        # Press and release the main key
        event = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
        if modifier_flags:
            Quartz.CGEventSetFlags(event, modifier_flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

        event = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
        if modifier_flags:
            Quartz.CGEventSetFlags(event, modifier_flags)
        Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

        # Release modifier keys
        for mk in reversed(modifier_keycodes):
            event = Quartz.CGEventCreateKeyboardEvent(None, mk, False)
            Quartz.CGEventPost(Quartz.kCGHIDEventTap, event)

        return json.dumps({"ok": True, "key": args.key, "modifiers": modifiers})

    except ImportError:
        # Fallback to osascript
        mod_str = ""
        mod_map = {'cmd': 'command', 'shift': 'shift', 'ctrl': 'control', 'alt': 'option',
                    'command': 'command', 'control': 'control', 'option': 'option', 'opt': 'option'}
        for mod in modifiers:
            osa_mod = mod_map.get(mod, mod)
            mod_str += f" using {osa_mod} down"

        # Single char key
        key_char = args.key if len(args.key) == 1 else args.key
        if key_name == 'enter':
            script = f'tell application "System Events" to key code 36'
        elif key_name in ('tab', 'escape', 'esc', 'space', 'delete', 'backspace'):
            kc = key_codes[key_name]
            script = f'tell application "System Events" to key code {kc}{mod_str}'
        elif len(key_name) > 1:
            kc = key_codes[key_name]
            script = f'tell application "System Events" to key code {kc}{mod_str}'
        else:
            script = f'tell application "System Events" to keystroke "{key_char}"{mod_str}'

        _, err, rc = _run(f"osascript -e '{script}'")
        return json.dumps({"ok": rc == 0, "key": args.key, "modifiers": modifiers,
                           "method": "osascript", "error": err if rc != 0 else None})


def cmd_window(args):
    """Get window information for an app."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    if args.list:
        # List all visible windows
        script = '''
        tell application "System Events"
            set output to ""
            repeat with proc in (every process whose background only is false)
                set procName to name of proc
                repeat with w in (every window of proc)
                    try
                        set wName to name of w
                        set wPos to position of w
                        set wSize to size of w
                        set output to output & procName & " | " & wName & " | " & (item 1 of wPos) & "," & (item 2 of wPos) & " | " & (item 1 of wSize) & "x" & (item 2 of wSize) & linefeed
                    end try
                end repeat
            end repeat
            return output
        end tell
        '''
        out = _osascript(script)
        windows = []
        for line in out.strip().split("\n"):
            if " | " in line:
                parts = [p.strip() for p in line.split(" | ")]
                if len(parts) >= 4:
                    pos = parts[2].split(",")
                    size = parts[3].split("x")
                    windows.append({
                        "app": parts[0],
                        "title": parts[1],
                        "position": {"x": int(pos[0]), "y": int(pos[1])},
                        "size": {"width": int(size[0]), "height": int(size[1])},
                    })
        return json.dumps({"ok": True, "windows": windows})

    if not args.app_name:
        return json.dumps({"ok": False, "error": "Provide --app-name or --list"})

    app_name = args.app_name
    script = f'''
    tell application "System Events"
        try
            set proc to process "{app_name}"
            set w to front window of proc
            set wName to name of w
            set wPos to position of w
            set wSize to size of w
            return wName & "|" & (item 1 of wPos) & "," & (item 2 of wPos) & "|" & (item 1 of wSize) & "," & (item 2 of wSize)
        on error
            return "NOT_FOUND"
        end try
    end tell
    '''
    out = _osascript(script)
    if out == "NOT_FOUND":
        return json.dumps({"ok": False, "error": f"App '{app_name}' not found or has no windows"})

    parts = out.split("|")
    pos = parts[1].split(",")
    size = parts[2].split(",")
    return json.dumps({
        "ok": True,
        "app": app_name,
        "title": parts[0],
        "position": {"x": int(pos[0]), "y": int(pos[1])},
        "size": {"width": int(size[0]), "height": int(size[1])},
    })


def cmd_activate(args):
    """Bring an application to the front."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    app_name = args.app_name
    script = f'''
    tell application "{app_name}"
        activate
    end tell
    '''
    _osascript(script)
    return json.dumps({"ok": True, "app": app_name})


def cmd_mousepos(args):
    """Get current mouse position."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    try:
        import Quartz
        loc = Quartz.NSEvent.mouseLocation()
        # Convert from AppKit (bottom-left origin) to CGEvent (top-left origin)
        screen_h = Quartz.CGDisplayPixelsHigh(Quartz.CGMainDisplayID())
        return json.dumps({
            "ok": True,
            "x": loc.x,
            "y": screen_h - loc.y,
            "note": "Coordinates in logical points (CGEvent coordinate space)"
        })
    except ImportError:
        # Fallback using cliclick
        _, _, rc = _run("which cliclick")
        if rc != 0:
            return json.dumps({"ok": False, "error": "Neither Quartz nor cliclick available"})
        out, _, _ = _run("cliclick p")
        # cliclick outputs: X,Y
        if "," in out:
            x, y = out.split(",")
            return json.dumps({"ok": True, "x": int(x), "y": int(y)})
        return json.dumps({"ok": False, "error": f"Unexpected cliclick output: {out}"})


def cmd_find_element(args):
    """Find accessibility elements matching criteria."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    app_name = args.app_name
    conditions = []
    if args.role:
        conditions.append(f'whose role is "{args.role}"')
    if args.title:
        conditions.append(f'whose title is "{args.title}"')
    if args.value:
        conditions.append(f'whose value is "{args.value}"')

    cond_str = " ".join(conditions)
    script = f'''
    tell application "System Events"
        try
            set proc to process "{app_name}"
            set elements to (every UI element of front window of proc {cond_str})
            set output to ""
            repeat with el in elements
                try
                    set elRole to role of el
                    set elTitle to ""
                    try
                        set elTitle to title of el
                    end try
                    set elPos to position of el
                    set elSize to size of el
                    set output to output & elRole & "|" & elTitle & "|" & (item 1 of elPos) & "," & (item 2 of elPos) & "|" & (item 1 of elSize) & "," & (item 2 of elSize) & linefeed
                end try
            end repeat
            return output
        on error errMsg
            return "ERROR:" & errMsg
        end try
    end tell
    '''
    out = _osascript(script)
    if out.startswith("ERROR:"):
        return json.dumps({"ok": False, "error": out[6:]})

    elements = []
    for line in out.strip().split("\n"):
        if "|" in line:
            parts = [p.strip() for p in line.split("|")]
            if len(parts) >= 4:
                pos = parts[2].split(",")
                size = parts[3].split(",")
                elements.append({
                    "role": parts[0],
                    "title": parts[1],
                    "position": {"x": int(pos[0]), "y": int(pos[1])},
                    "size": {"width": int(size[0]), "height": int(size[1])},
                })

    return json.dumps({"ok": True, "app": app_name, "elements": elements, "count": len(elements)})


def cmd_ax_tree(args):
    """Print the accessibility tree for an app."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    app_name = args.app_name
    depth = args.depth or 3

    script = f'''
    tell application "System Events"
        try
            set proc to process "{app_name}"
            set output to ""
            set frontWin to front window of proc
            my describeElement(frontWin, 0, {depth}, output)
            return output
        on error errMsg
            return "ERROR:" & errMsg
        end try
    end tell

    on describeElement(el, currentDepth, maxDepth, outputRef)
        if currentDepth > maxDepth then return
        set indent to ""
        repeat currentDepth times
            set indent to indent & "  "
        end repeat
        try
            set elRole to role of el
            set elTitle to ""
            try
                set elTitle to title of el
            end try
            set elDesc to elRole
            if elTitle is not "" then
                set elDesc to elDesc & " \"" & elTitle & "\""
            end if
            try
                set elPos to position of el
                set elSize to size of el
                set elDesc to elDesc & " [" & (item 1 of elPos) & "," & (item 2 of elPos) & " " & (item 1 of elSize) & "x" & (item 2 of elSize) & "]"
            end try
            set outputRef to outputRef & indent & elDesc & linefeed
            if currentDepth < maxDepth then
                set children to UI elements of el
                repeat with child in children
                    my describeElement(child, currentDepth + 1, maxDepth, outputRef)
                end repeat
            end if
        end try
    end describeElement
    '''
    out = _osascript(script)
    if out.startswith("ERROR:"):
        return json.dumps({"ok": False, "error": out[6:]})

    return json.dumps({"ok": True, "app": app_name, "depth": depth, "tree": out})


def cmd_calibrate(args):
    """Show screen calibration info (scale factor, resolution, etc.)."""
    if not _is_macos():
        return json.dumps({"ok": False, "error": "Not on macOS"})

    scale = _get_scale_factor()

    # Get screen info
    out, _, _ = _run("system_profiler SPDisplaysDataType 2>/dev/null | grep -E 'Resolution|Retina|Display'")
    screen_info = out.strip()

    # Main display bounds
    try:
        import Quartz
        main_id = Quartz.CGMainDisplayID()
        pixel_w = Quartz.CGDisplayPixelsWide(main_id)
        pixel_h = Quartz.CGDisplayPixelsHigh(main_id)
        bounds = Quartz.NSScreen.mainScreen().frame()
        logical_w = int(bounds.size.width)
        logical_h = int(bounds.size.height)
    except (ImportError, Exception):
        pixel_w = pixel_h = logical_w = logical_h = "unknown"
        bounds = None

    return json.dumps({
        "ok": True,
        "scale_factor": scale,
        "is_retina": scale > 1.5,
        "resolution_pixels": {"width": pixel_w, "height": pixel_h},
        "resolution_logical": {"width": logical_w, "height": logical_h},
        "screen_info": screen_info,
        "note": "CGEvent uses logical points. Screenshot images are in pixels. Divide pixels by scale_factor to get logical points.",
    })


# ---------------------------------------------------------------------------
# Argument Parser
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="macOS Screen Control - CGEvent and Accessibility API automation"
    )
    subparsers = parser.add_subparsers(dest="command", help="Command to execute")

    # check
    sub = subparsers.add_parser("check", help="Check prerequisites")

    # screenshot
    sub = subparsers.add_parser("screenshot", help="Capture screenshot")
    sub.add_argument("--output", "-o", help="Output file path")
    sub.add_argument("--region", "-r", help="Region x,y,w,h (logical points)")
    sub.add_argument("--display", "-d", type=int, help="Display number")

    # click
    sub = subparsers.add_parser("click", help="Click at coordinates")
    sub.add_argument("x", type=float, help="X coordinate (logical points)")
    sub.add_argument("y", type=float, help="Y coordinate (logical points)")
    sub.add_argument("--button", "-b", default="left", choices=["left", "right"], help="Mouse button")
    sub.add_argument("--double", action="store_true", help="Double click")

    # move
    sub = subparsers.add_parser("move", help="Move mouse to coordinates")
    sub.add_argument("x", type=float, help="X coordinate")
    sub.add_argument("y", type=float, help="Y coordinate")

    # drag
    sub = subparsers.add_parser("drag", help="Drag from one point to another")
    sub.add_argument("x1", type=float, help="Start X")
    sub.add_argument("y1", type=float, help="Start Y")
    sub.add_argument("x2", type=float, help="End X")
    sub.add_argument("y2", type=float, help="End Y")

    # type
    sub = subparsers.add_parser("type", help="Type text (supports CJK)")
    sub.add_argument("text", help="Text to type")
    sub.add_argument("--delay", "-d", type=int, help="Delay between keystrokes (ms)")

    # key
    sub = subparsers.add_parser("key", help="Press key combination")
    sub.add_argument("key", help="Key name (e.g., enter, tab, cmd, c)")
    sub.add_argument("--with", "-w", dest="with_mods", action="append", help="Modifier key (repeatable)")

    # window
    sub = subparsers.add_parser("window", help="Get window info")
    sub.add_argument("app_name", nargs="?", help="Application name")
    sub.add_argument("--list", "-l", action="store_true", help="List all visible windows")

    # activate
    sub = subparsers.add_parser("activate", help="Bring app to front")
    sub.add_argument("app_name", help="Application name")

    # mousepos
    sub = subparsers.add_parser("mousepos", help="Get current mouse position")

    # find-element
    sub = subparsers.add_parser("find-element", help="Find AX elements")
    sub.add_argument("app_name", help="Application name")
    sub.add_argument("--role", "-r", help="Filter by AX role")
    sub.add_argument("--title", "-t", help="Filter by title")
    sub.add_argument("--value", "-v", help="Filter by value")

    # ax-tree
    sub = subparsers.add_parser("ax-tree", help="Print accessibility tree")
    sub.add_argument("app_name", help="Application name")
    sub.add_argument("--depth", "-d", type=int, default=3, help="Max depth (default: 3)")

    # calibrate
    sub = subparsers.add_parser("calibrate", help="Show screen calibration info")

    args = parser.parse_args()
    if not args.command:
        parser.print_help()
        sys.exit(1)

    commands = {
        "check": cmd_check,
        "screenshot": cmd_screenshot,
        "click": cmd_click,
        "move": cmd_move,
        "drag": cmd_drag,
        "type": cmd_type,
        "key": cmd_key,
        "window": cmd_window,
        "activate": cmd_activate,
        "mousepos": cmd_mousepos,
        "find-element": cmd_find_element,
        "ax-tree": cmd_ax_tree,
        "calibrate": cmd_calibrate,
    }

    handler = commands.get(args.command)
    if handler:
        try:
            result = handler(args)
            print(result)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
