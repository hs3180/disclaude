#!/bin/bash
# =============================================================================
# mac-control.sh - macOS Desktop Automation Helper Script
# =============================================================================
#
# A helper script that wraps common macOS desktop automation operations.
# Uses CGEvent via Python ctypes — zero external dependencies (no cliclick).
#
# Usage:
#   ./mac-control.sh <command> [args...]
#
# Commands:
#   screenshot [path]              - Take full screenshot (default: /tmp/screenshot.png)
#   screenshot-region x,y,w,h [path] - Take region screenshot
#   click x y                      - Left click at (x, y) in logical points
#   right-click x y                - Right click at (x, y)
#   double-click x y               - Double click at (x, y)
#   drag x1 y1 x2 y2              - Drag from (x1,y1) to (x2,y2)
#   type text                      - Type ASCII text via CGEvent
#   type-cjk text                  - Type CJK/Unicode text via clipboard paste
#   key keycode                    - Press a key by keycode
#   key-combo mod_keycode,target_keycode - Press key combo (e.g., 55,9 for Cmd+V)
#   activate appname               - Bring application to front
#   window-bounds appname          - Get window position and size
#   window-move appname x y        - Move window to (x, y)
#   window-resize appname w h      - Resize window to (w, h)
#   list-apps                      - List visible applications
#   scale-factor                   - Get display Retina scale factor
#   pixel-to-logical px py         - Convert pixel coords to logical coords
#   check-permissions              - Check accessibility permissions
#   wait seconds                   - Wait for specified seconds
#
# =============================================================================

set -euo pipefail

# --- Utility Functions ---

die() {
    echo "ERROR: $*" >&2
    exit 1
}

check_macos() {
    [[ "$(uname -s)" == "Darwin" ]] || die "This script requires macOS (Darwin). Current: $(uname -s)"
}

# Shared Python CGEvent helper — loads CoreGraphics once
cgevent_cmd() {
    python3 -c "
import ctypes, ctypes.util, time, sys

cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
$1
"
}

# --- Commands ---

cmd_screenshot() {
    local path="${1:-/tmp/screenshot.png}"
    screencapture -x "$path"
    echo "Screenshot saved: $path"
    # Try to show dimensions
    if command -v sips &>/dev/null; then
        echo "Size: $(sips -g pixelWidth -g pixelHeight "$path" 2>/dev/null | grep pixel | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')"
    fi
}

cmd_screenshot_region() {
    local x y w h path
    x="${1%%,*}"
    local rest="${1#*,}"
    y="${rest%%,*}"
    rest="${rest#*,}"
    w="${rest%%,*}"
    h="${rest#*,}"
    path="${2:-/tmp/screenshot_region.png}"
    screencapture -R "${x},${y},${w},${h}" -x "$path"
    echo "Region screenshot saved: $path"
}

cmd_click() {
    local x="$1" y="$2"
    cgevent_cmd "
x, y = ${x}, ${y}
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 5, (x, y), 0))  # move
time.sleep(0.05)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, (x, y), 0))  # left_down
time.sleep(0.05)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, (x, y), 0))  # left_up
print('Clicked at (${x}, ${y})')
"
}

cmd_right_click() {
    local x="$1" y="$2"
    cgevent_cmd "
x, y = ${x}, ${y}
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 3, (x, y), 1))  # right_down
time.sleep(0.05)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 4, (x, y), 1))  # right_up
print('Right-clicked at (${x}, ${y})')
"
}

cmd_double_click() {
    local x="$1" y="$2"
    cgevent_cmd "
x, y = ${x}, ${y}
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 5, (x, y), 0))  # move
for _ in range(2):
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, (x, y), 0))  # left_down
    time.sleep(0.02)
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, (x, y), 0))  # left_up
    time.sleep(0.05)
print('Double-clicked at (${x}, ${y})')
"
}

cmd_drag() {
    local x1="$1" y1="$2" x2="$3" y2="$4"
    cgevent_cmd "
from_x, from_y, to_x, to_y = ${x1}, ${y1}, ${x2}, ${y2}
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, (from_x, from_y), 0))  # left_down
time.sleep(0.1)
steps = 20
for i in range(steps + 1):
    t = i / steps
    cx = from_x + (to_x - from_x) * t
    cy = from_y + (to_y - from_y) * t
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 6, (cx, cy), 0))  # drag
    time.sleep(0.02)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, (to_x, to_y), 0))  # left_up
print('Dragged from (${x1}, ${y1}) to (${x2}, ${y2})')
"
}

cmd_type() {
    local text="$*"
    # For ASCII text, use individual key events via CGEvent
    cgevent_cmd "
import ctypes.util
text = '''${text}'''
for ch in text:
    keycode = ord(ch)  # Simplified mapping for common ASCII
    evt_down = cg.CGEventCreateKeyboardEvent(None, keycode, True)
    cg.CGEventPost(0, evt_down)
    time.sleep(0.02)
    evt_up = cg.CGEventCreateKeyboardEvent(None, keycode, False)
    cg.CGEventPost(0, evt_up)
    time.sleep(0.02)
print('Typed: ' + text)
"
}

cmd_type_cjk() {
    local text="$*"
    # Clipboard paste method — handles all Unicode (CJK, emoji, etc.)
    local old_clipboard=""
    old_clipboard=$(pbpaste 2>/dev/null || true)

    # Copy text to clipboard
    echo -n "$text" | pbcopy
    sleep 0.1

    # Cmd+V via CGEvent
    cgevent_cmd "
cmd_down = cg.CGEventCreateKeyboardEvent(None, 55, True)
v_key = cg.CGEventCreateKeyboardEvent(None, 9, True)
cg.CGEventSetFlags(v_key, 0x001000)  # kCGEventFlagMaskCommand
v_up = cg.CGEventCreateKeyboardEvent(None, 9, False)
cg.CGEventSetFlags(v_up, 0x001000)
cmd_up = cg.CGEventCreateKeyboardEvent(None, 55, False)
cg.CGEventPost(0, cmd_down)
time.sleep(0.02)
cg.CGEventPost(0, v_key)
time.sleep(0.02)
cg.CGEventPost(0, v_up)
time.sleep(0.02)
cg.CGEventPost(0, cmd_up)
"
    sleep 0.2

    # Restore clipboard
    echo -n "$old_clipboard" | pbcopy 2>/dev/null || true
    echo "Typed CJK text via clipboard: ${text}"
}

cmd_key() {
    local keycode="$1"
    cgevent_cmd "
keycode = ${keycode}
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, keycode, True))
time.sleep(0.02)
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, keycode, False))
print('Pressed key: keycode=${keycode}')
"
}

cmd_key_combo() {
    local combo="$1"
    local mod_key="${combo%%,*}"
    local target_key="${combo#*,}"
    cgevent_cmd "
mod = ${mod_key}
target = ${target_key}
# Press modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, mod, True))
time.sleep(0.02)
# Press target with modifier flag
evt = cg.CGEventCreateKeyboardEvent(None, target, True)
cg.CGEventSetFlags(evt, 0x001000)
cg.CGEventPost(0, evt)
time.sleep(0.02)
evt = cg.CGEventCreateKeyboardEvent(None, target, False)
cg.CGEventSetFlags(evt, 0x001000)
cg.CGEventPost(0, evt)
time.sleep(0.02)
# Release modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, mod, False))
print('Pressed combo: mod=${mod_key}, key=${target_key}')
"
}

cmd_activate() {
    local appname="$*"
    osascript -e "tell application \"${appname}\" to activate"
    echo "Activated: ${appname}"
}

cmd_window_bounds() {
    local appname="$*"
    osascript -e "
        tell application \"System Events\"
            tell process \"${appname}\"
                set wPos to position of front window
                set wSize to size of front window
                return (item 1 of wPos) & \",\" & (item 2 of wPos) & \",\" & (item 1 of wSize) & \",\" & (item 2 of wSize)
            end tell
        end tell
    "
}

cmd_window_move() {
    local appname="$1"
    local x="$2" y="$3"
    osascript -e "
        tell application \"System Events\"
            tell process \"${appname}\"
                set position of front window to {${x}, ${y}}
            end tell
        end tell
    "
    echo "Moved ${appname} window to (${x}, ${y})"
}

cmd_window_resize() {
    local appname="$1"
    local w="$2" h="$3"
    osascript -e "
        tell application \"System Events\"
            tell process \"${appname}\"
                set size of front window to {${w}, ${h}}
            end tell
        end tell
    "
    echo "Resized ${appname} window to ${w}x${h}"
}

cmd_list_apps() {
    osascript -e 'tell application "System Events" to get name of every process whose visible is true'
}

cmd_scale_factor() {
    python3 -c "
import ctypes, ctypes.util
try:
    cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
    main_id = cg.CGMainDisplayID()
    width_px = cg.CGDisplayPixelsWide(main_id)
    mode = cg.CGDisplayCopyDisplayMode(main_id)
    mode_w = cg.CGDisplayModeGetWidth(mode)
    print(int(width_px / mode_w))
except Exception:
    # Fallback: check for Retina keyword
    import subprocess
    result = subprocess.run(['system_profiler', 'SPDisplaysDataType'], capture_output=True, text=True)
    if 'Retina' in result.stdout:
        print(2)
    else:
        print(1)
"
}

cmd_pixel_to_logical() {
    local px="$1" py="$2"
    local scale
    scale=$(cmd_scale_factor)
    local lx=$(( px / scale ))
    local ly=$(( py / scale ))
    echo "Pixel (${px}, ${py}) -> Logical (${lx}, ${ly}) [scale=${scale}x]"
}

cmd_check_permissions() {
    echo "Checking macOS automation permissions..."

    # Check Accessibility (System Events access)
    if osascript -e 'tell application "System Events" to get name of first process' &>/dev/null; then
        echo "  ✅ Accessibility: GRANTED"
    else
        echo "  ❌ Accessibility: DENIED"
        echo "     -> Grant at: System Settings > Privacy & Security > Accessibility"
    fi

    # Check Python3
    if command -v python3 &>/dev/null; then
        echo "  ✅ python3: $(python3 --version 2>&1)"
    else
        echo "  ❌ python3: NOT FOUND (required for CGEvent)"
    fi

    # Check screencapture
    if command -v screencapture &>/dev/null; then
        echo "  ✅ screencapture: AVAILABLE"
    else
        echo "  ❌ screencapture: NOT AVAILABLE"
    fi

    # Check pbcopy/pbpaste
    if command -v pbcopy &>/dev/null && command -v pbpaste &>/dev/null; then
        echo "  ✅ pbcopy/pbpaste: AVAILABLE"
    else
        echo "  ❌ pbcopy/pbpaste: NOT AVAILABLE"
    fi

    echo ""
    echo "Note: Screenshots may require Screen Recording permission."
    echo "Grant at: System Settings > Privacy & Security > Screen Recording"
}

cmd_wait() {
    local seconds="${1:-0.5}"
    sleep "$seconds"
    echo "Waited ${seconds}s"
}

# --- Main ---

check_macos

case "${1:-}" in
    screenshot)           shift; cmd_screenshot "$@" ;;
    screenshot-region)    shift; cmd_screenshot_region "$@" ;;
    click)                shift; cmd_click "$@" ;;
    right-click)          shift; cmd_right_click "$@" ;;
    double-click)         shift; cmd_double_click "$@" ;;
    drag)                 shift; cmd_drag "$@" ;;
    type)                 shift; cmd_type "$@" ;;
    type-cjk)             shift; cmd_type_cjk "$@" ;;
    key)                  shift; cmd_key "$@" ;;
    key-combo)            shift; cmd_key_combo "$@" ;;
    activate)             shift; cmd_activate "$@" ;;
    window-bounds)        shift; cmd_window_bounds "$@" ;;
    window-move)          shift; cmd_window_move "$@" ;;
    window-resize)        shift; cmd_window_resize "$@" ;;
    list-apps)            shift; cmd_list_apps "$@" ;;
    scale-factor)         shift; cmd_scale_factor "$@" ;;
    pixel-to-logical)     shift; cmd_pixel_to_logical "$@" ;;
    check-permissions)    shift; cmd_check_permissions "$@" ;;
    wait)                 shift; cmd_wait "$@" ;;
    *)
        echo "mac-control.sh - macOS Desktop Automation Helper"
        echo "                Uses CGEvent via Python ctypes (zero dependencies)"
        echo ""
        echo "Usage: $0 <command> [args...]"
        echo ""
        echo "Commands:"
        echo "  screenshot [path]                    Take full screenshot"
        echo "  screenshot-region x,y,w,h [path]    Take region screenshot"
        echo "  click x y                           Left click at (x, y)"
        echo "  right-click x y                     Right click at (x, y)"
        echo "  double-click x y                    Double click at (x, y)"
        echo "  drag x1 y1 x2 y2                   Drag from (x1,y1) to (x2,y2)"
        echo "  type text                           Type ASCII text via CGEvent"
        echo "  type-cjk text                       Type CJK text via clipboard"
        echo "  key keycode                         Press key by keycode"
        echo "  key-combo mod,target                Press key combo (e.g., 55,9)"
        echo "  activate appname                    Bring application to front"
        echo "  window-bounds appname               Get window position and size"
        echo "  window-move appname x y             Move window"
        echo "  window-resize appname w h           Resize window"
        echo "  list-apps                           List visible applications"
        echo "  scale-factor                        Get display scale factor"
        echo "  pixel-to-logical px py              Convert pixel to logical coords"
        echo "  check-permissions                   Check automation permissions"
        echo "  wait seconds                        Wait for specified seconds"
        echo ""
        echo "Common keycodes: Return=36 Tab=48 Escape=53 Space=49 Cmd=55 Shift=56"
        exit 1
        ;;
esac
