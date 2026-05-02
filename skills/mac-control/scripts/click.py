#!/usr/bin/env python3
"""skills/mac-control/scripts/click.py — Mouse control via CGEvent on macOS.

Usage:
    python3 skills/mac-control/scripts/click.py click X Y [OPTIONS]
    python3 skills/mac-control/scripts/click.py right-click X Y [OPTIONS]
    python3 skills/mac-control/scripts/click.py double-click X Y [OPTIONS]
    python3 skills/mac-control/scripts/click.py drag X1 Y1 X2 Y2 [OPTIONS]

Options:
    --delay SECONDS    Delay before action (default: 0.1)

Coordinates are in LOGICAL POINTS (not pixels).
On Retina: screenshot_pixel_coord / 2.0 = logical_coord

Exit codes:
    0 — success
    1 — error (not macOS, missing Python modules, etc.)
"""

import sys
import platform
import time
import ctypes
import ctypes.util

# --- Platform check ---
if platform.system() != "Darwin":
    print('{"error": "Not running on macOS. CGEvent requires macOS."}', file=sys.stderr)
    sys.exit(1)

# --- CoreGraphics constants ---
kCGEventSourceStateHIDSystemState = 1
kCGEventSourceStateCombinedSessionState = 0
kCGMouseButtonLeft = 0
kCGMouseButtonRight = 1
kCGEventMouseMoved = 5
kCGEventLeftMouseDown = 1
kCGEventLeftMouseUp = 2
kCGEventRightMouseDown = 3
kCGEventRightMouseUp = 4
kCGEventOtherMouseDown = 25
kCGEventOtherMouseUp = 26
kCGEventLeftMouseDragged = 6
kCGEventFlagMaskCommand = 0x00100000


def _load_coregraphics():
    """Load CoreGraphics framework via ctypes."""
    cg_path = ctypes.util.find_library("CoreGraphics")
    if not cg_path:
        print('{"error": "CoreGraphics framework not found"}', file=sys.stderr)
        sys.exit(1)
    return ctypes.cdll.LoadLibrary(cg_path)


def _load_appkit():
    """Load AppKit framework for event post."""
    appkit_path = ctypes.util.find_library("AppKit")
    if not appkit_path:
        print('{"error": "AppKit framework not found"}', file=sys.stderr)
        sys.exit(1)
    return ctypes.cdll.LoadLibrary(appkit_path)


def _create_event_source(cg):
    """Create a CGEventSource from HID system state."""
    CGEventSourceCreate = cg.CGEventSourceCreate
    CGEventSourceCreate.restype = ctypes.c_void_p
    CGEventSourceCreate.argtypes = [ctypes.c_uint32]
    return CGEventSourceCreate(kCGEventSourceStateHIDSystemState)


def _create_mouse_event(cg, source, event_type, x, y, button):
    """Create a CGEvent for mouse action."""
    CGEventCreateMouseEvent = cg.CGEventCreateMouseEvent
    CGEventCreateMouseEvent.restype = ctypes.c_void_p
    CGEventCreateMouseEvent.argtypes = [
        ctypes.c_void_p,  # source
        ctypes.c_uint32,  # eventType
        ctypes.c_void_p,  # point (CGPoint)
        ctypes.c_uint32,  # mouseButton
    ]

    # CGPoint is two doubles: x, y
    # Pack into a struct of 2 doubles (16 bytes)
    point = (ctypes.c_double * 2)(float(x), float(y))

    return CGEventCreateMouseEvent(
        ctypes.c_void_p(source),
        ctypes.c_uint32(event_type),
        point,
        ctypes.c_uint32(button),
    )


def _post_event(cg, event):
    """Post a CGEvent to the HID system."""
    CGEventPost = cg.CGEventPost
    CGEventPost.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
    CGEventPost.restype = None
    # kCGHIDEventTap = 0
    CGEventPost(0, ctypes.c_void_p(event))


def _release_event(cg, event):
    """Release a CGEvent."""
    CGEventRelease = cg.CGEventRelease
    CGEventRelease.argtypes = [ctypes.c_void_p]
    CGEventRelease.restype = None
    CGEventRelease(ctypes.c_void_p(event))


def click(cg, x, y, button=kCGMouseButtonLeft):
    """Perform a mouse click at (x, y) in logical points."""
    source = _create_event_source(cg)

    # Mouse down
    if button == kCGMouseButtonRight:
        down_type = kCGEventRightMouseDown
        up_type = kCGEventRightMouseUp
    else:
        down_type = kCGEventLeftMouseDown
        up_type = kCGEventLeftMouseUp

    down_event = _create_mouse_event(cg, source, down_type, x, y, button)
    _post_event(cg, down_event)
    _release_event(cg, down_event)

    time.sleep(0.01)  # Small delay between down and up

    # Mouse up
    up_event = _create_mouse_event(cg, source, up_type, x, y, button)
    _post_event(cg, up_event)
    _release_event(cg, up_event)


def double_click(cg, x, y):
    """Perform a double click at (x, y) in logical points."""
    click(cg, x, y, kCGMouseButtonLeft)
    time.sleep(0.05)
    click(cg, x, y, kCGMouseButtonLeft)


def drag(cg, x1, y1, x2, y2, duration=0.3):
    """Perform a drag from (x1, y1) to (x2, y2) in logical points."""
    source = _create_event_source(cg)

    # Move to start position
    move_event = _create_mouse_event(
        cg, source, kCGEventMouseMoved, x1, y1, kCGMouseButtonLeft
    )
    _post_event(cg, move_event)
    _release_event(cg, move_event)
    time.sleep(0.05)

    # Mouse down at start
    down_event = _create_mouse_event(
        cg, source, kCGEventLeftMouseDown, x1, y1, kCGMouseButtonLeft
    )
    _post_event(cg, down_event)
    _release_event(cg, down_event)
    time.sleep(0.05)

    # Animate drag movement (interpolate points)
    steps = max(10, int(duration * 60))
    for i in range(1, steps + 1):
        progress = i / steps
        # Ease-in-out interpolation
        t = progress * progress * (3 - 2 * progress)
        cx = x1 + (x2 - x1) * t
        cy = y1 + (y2 - y1) * t

        drag_event = _create_mouse_event(
            cg, source, kCGEventLeftMouseDragged, cx, cy, kCGMouseButtonLeft
        )
        _post_event(cg, drag_event)
        _release_event(cg, drag_event)
        time.sleep(duration / steps)

    # Mouse up at end
    up_event = _create_mouse_event(
        cg, source, kCGEventLeftMouseUp, x2, y2, kCGMouseButtonLeft
    )
    _post_event(cg, up_event)
    _release_event(cg, up_event)


def _send_key(cg, source, keycode, flags=0):
    """Send a key down + key up event."""
    CGEventCreateKeyboardEvent = cg.CGEventCreateKeyboardEvent
    CGEventCreateKeyboardEvent.restype = ctypes.c_void_p
    CGEventCreateKeyboardEvent.argtypes = [
        ctypes.c_void_p,  # source
        ctypes.c_uint16,  # virtualKey
        ctypes.c_bool,    # keyDown
    ]

    # Key down
    key_down = CGEventCreateKeyboardEvent(
        ctypes.c_void_p(source),
        ctypes.c_uint16(keycode),
        True,
    )
    if flags:
        cg.CGEventSetFlags(ctypes.c_void_p(key_down), ctypes.c_uint64(flags))

    _post_event(cg, key_down)
    _release_event(cg, key_down)

    time.sleep(0.02)

    # Key up
    key_up = CGEventCreateKeyboardEvent(
        ctypes.c_void_p(source),
        ctypes.c_uint16(keycode),
        False,
    )
    if flags:
        cg.CGEventSetFlags(ctypes.c_void_p(key_up), ctypes.c_uint64(flags))

    _post_event(cg, key_up)
    _release_event(cg, key_up)


def paste_from_clipboard(cg):
    """Send Cmd+V to paste from clipboard."""
    source = _create_event_source(cg)
    # Cmd key virtual keycode = 55
    # V key virtual keycode = 9
    _send_key(cg, source, 9, kCGEventFlagMaskCommand)


def main():
    """Main entry point for command-line usage."""
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(1)

    action = sys.argv[1]
    delay = 0.1

    # Parse --delay flag
    args = sys.argv[2:]
    filtered_args = []
    i = 0
    while i < len(args):
        if args[i] == "--delay" and i + 1 < len(args):
            delay = float(args[i + 1])
            i += 2
        else:
            filtered_args.append(args[i])
            i += 1

    try:
        cg = _load_coregraphics()
    except Exception as e:
        print(f'{{"error": "Failed to load CoreGraphics: {e}"}}', file=sys.stderr)
        sys.exit(1)

    time.sleep(delay)

    try:
        if action == "click":
            if len(filtered_args) < 2:
                print('{"error": "click requires X Y arguments"}', file=sys.stderr)
                sys.exit(1)
            x, y = float(filtered_args[0]), float(filtered_args[1])
            click(cg, x, y)
            print(f'{{"success": true, "action": "click", "x": {x}, "y": {y}}}')

        elif action == "right-click":
            if len(filtered_args) < 2:
                print('{"error": "right-click requires X Y arguments"}', file=sys.stderr)
                sys.exit(1)
            x, y = float(filtered_args[0]), float(filtered_args[1])
            click(cg, x, y, kCGMouseButtonRight)
            print(f'{{"success": true, "action": "right-click", "x": {x}, "y": {y}}}')

        elif action == "double-click":
            if len(filtered_args) < 2:
                print('{"error": "double-click requires X Y arguments"}', file=sys.stderr)
                sys.exit(1)
            x, y = float(filtered_args[0]), float(filtered_args[1])
            double_click(cg, x, y)
            print(f'{{"success": true, "action": "double-click", "x": {x}, "y": {y}}}')

        elif action == "drag":
            if len(filtered_args) < 4:
                print('{"error": "drag requires X1 Y1 X2 Y2 arguments"}', file=sys.stderr)
                sys.exit(1)
            x1, y1 = float(filtered_args[0]), float(filtered_args[1])
            x2, y2 = float(filtered_args[2]), float(filtered_args[3])
            drag(cg, x1, y1, x2, y2)
            print(f'{{"success": true, "action": "drag", "from": [{x1}, {y1}], "to": [{x2}, {y2}]}}')

        elif action == "paste":
            """Send Cmd+V to paste from clipboard."""
            paste_from_clipboard(cg)
            print('{"success": true, "action": "paste"}')

        else:
            print(f'{{"error": "Unknown action: {action}"}}', file=sys.stderr)
            sys.exit(1)

    except Exception as e:
        print(f'{{"error": "Action failed: {e}"}}', file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
