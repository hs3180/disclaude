#!/bin/bash
# =============================================================================
# mac-control.sh - macOS Desktop Automation Helper Script
# =============================================================================
#
# A helper script that wraps common macOS desktop automation operations.
# Used by the mac-screen-control skill.
#
# Usage:
#   ./mac-control.sh <command> [args...]
#
# Commands:
#   screenshot [path]              - Take full screenshot (default: /tmp/screenshot.png)
#   screenshot-region x,y,w,h [path] - Take region screenshot
#   click x y                      - Left click at (x, y)
#   right-click x y                - Right click at (x, y)
#   double-click x y               - Double click at (x, y)
#   drag x1 y1 x2 y2              - Drag from (x1,y1) to (x2,y2)
#   type text                      - Type ASCII text
#   type-cjk text                  - Type CJK text via clipboard
#   key keyname                    - Press a key (return, tab, escape, etc.)
#   key-combo mod,key              - Press key combo (cmd,c, cmd,v, etc.)
#   activate appname               - Bring application to front
#   window-bounds appname          - Get window position and size
#   window-move appname x y        - Move window to (x, y)
#   window-resize appname w h      - Resize window to (w, h)
#   list-apps                      - List visible applications
#   scale-factor                   - Get display scale factor
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

# --- Commands ---

cmd_screenshot() {
    local path="${1:-/tmp/screenshot.png}"
    screencapture -x "$path"
    echo "Screenshot saved: $path"
    echo "Size: $(sips -g pixelWidth -g pixelHeight "$path" 2>/dev/null | grep pixel | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')"
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
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
event = cg.CGEventCreateMouseEvent(None, 5, ($x, $y), 0)
cg.CGEventPost(0, event)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 1, ($x, $y), 0)
cg.CGEventPost(0, event)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 2, ($x, $y), 0)
cg.CGEventPost(0, event)
"
    echo "Clicked at ($x, $y)"
}

cmd_right_click() {
    local x="$1" y="$2"
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
event = cg.CGEventCreateMouseEvent(None, 3, ($x, $y), 1)
cg.CGEventPost(0, event)
time.sleep(0.05)
event = cg.CGEventCreateMouseEvent(None, 4, ($x, $y), 1)
cg.CGEventPost(0, event)
"
    echo "Right-clicked at ($x, $y)"
}

cmd_double_click() {
    local x="$1" y="$2"
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
for _ in range(2):
    event = cg.CGEventCreateMouseEvent(None, 1, ($x, $y), 0)
    cg.CGEventPost(0, event)
    time.sleep(0.02)
    event = cg.CGEventCreateMouseEvent(None, 2, ($x, $y), 0)
    cg.CGEventPost(0, event)
    time.sleep(0.05)
"
    echo "Double-clicked at ($x, $y)"
}

cmd_drag() {
    local x1="$1" y1="$2" x2="$3" y2="$4"
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 1, ($x1, $y1), 0))
time.sleep(0.1)
steps = 20
for i in range(steps + 1):
    t = i / steps
    cx = $x1 + ($x2 - $x1) * t
    cy = $y1 + ($y2 - $y1) * t
    cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 6, (cx, cy), 0))
    time.sleep(0.02)
cg.CGEventPost(0, cg.CGEventCreateMouseEvent(None, 2, ($x2, $y2), 0))
"
    echo "Dragged from ($x1, $y1) to ($x2, $y2)"
}

cmd_type() {
    local text="$*"
    local old_clipboard=""
    old_clipboard=$(pbpaste 2>/dev/null || true)
    printf '%s' "$text" | pbcopy
    sleep 0.1
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
cmd_down = cg.CGEventCreateKeyboardEvent(None, 55, True)
v_key = cg.CGEventCreateKeyboardEvent(None, 9, True)
cg.CGEventSetFlags(v_key, 0x001000)
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
    sleep 0.1
    printf '%s' "$old_clipboard" | pbcopy 2>/dev/null || true
    echo "Typed: $text"
}

cmd_type_cjk() {
    # Same as cmd_type — clipboard paste handles all Unicode
    cmd_type "$@"
}

cmd_key() {
    local key="$1"
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
# Map common key names to keycodes
key_map = {
    'return': 36, 'enter': 36, 'tab': 48, 'escape': 53, 'esc': 53,
    'delete': 51, 'backspace': 51, 'space': 49,
    'left': 123, 'right': 124, 'up': 126, 'down': 125,
    'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
    'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96,
    'f6': 97, 'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109,
    'f11': 103, 'f12': 111,
}
kc = key_map.get('$key'.lower(), int('$key'))
evt = cg.CGEventCreateKeyboardEvent(None, kc, True)
cg.CGEventPost(0, evt)
time.sleep(0.02)
evt = cg.CGEventCreateKeyboardEvent(None, kc, False)
cg.CGEventPost(0, evt)
"
    echo "Pressed key: $key"
}

cmd_key_combo() {
    local combo="$1"
    python3 -c "
import ctypes, ctypes.util, time
cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
mod_map = {'cmd': 55, 'shift': 56, 'ctrl': 59, 'opt': 58, 'option': 58, 'control': 59, 'command': 55}
parts = '$combo'.split(',')
mod_name = parts[0].strip().lower()
target_name = parts[1].strip().lower() if len(parts) > 1 else ''
mod_kc = mod_map.get(mod_name, int(mod_name))
# Simple keycode mapping for common keys
key_map = {
    'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
    'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35,
    'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
    'y': 16, 'z': 6, '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23,
    '6': 22, '7': 26, '8': 28, '9': 25,
}
target_kc = key_map.get(target_name, int(target_name) if target_name.isdigit() else 0)
# Determine modifier flag
flag = 0
if mod_name in ('cmd', 'command'): flag = 0x001000
elif mod_name in ('shift',): flag = 0x00200
elif mod_name in ('ctrl', 'control'): flag = 0x00400
elif mod_name in ('opt', 'option'): flag = 0x00800
# Press modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, mod_kc, True))
time.sleep(0.02)
# Press target with flag
evt = cg.CGEventCreateKeyboardEvent(None, target_kc, True)
cg.CGEventSetFlags(evt, flag)
cg.CGEventPost(0, evt)
time.sleep(0.02)
evt = cg.CGEventCreateKeyboardEvent(None, target_kc, False)
cg.CGEventSetFlags(evt, flag)
cg.CGEventPost(0, evt)
time.sleep(0.02)
# Release modifier
cg.CGEventPost(0, cg.CGEventCreateKeyboardEvent(None, mod_kc, False))
"
    echo "Pressed combo: $combo"
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
    local factor
    factor=$(osascript -e '
        use framework "AppKit"
        set mainScreen to current application'\''s NSScreen'\''s mainScreen()
        set scaleFactor to mainScreen'\''s backingScaleFactor()
        return scaleFactor as text
    ' 2>/dev/null || echo "")
    if [[ -n "$factor" ]]; then
        echo "${factor}"
    else
        # Fallback: check Retina via system_profiler
        if system_profiler SPDisplaysDataType 2>/dev/null | grep -q "Retina"; then
            echo "2"
        else
            echo "1"
        fi
    fi
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
    echo "Checking macOS accessibility permissions..."

    if osascript -e 'tell application "System Events" to get name of first process' &>/dev/null; then
        echo "  Accessibility: GRANTED"
    else
        echo "  Accessibility: DENIED"
        echo "  -> Grant at: System Settings > Privacy & Security > Accessibility"
    fi

    if command -v python3 &>/dev/null; then
        echo "  python3: INSTALLED"
    else
        echo "  python3: NOT INSTALLED (required for CGEvent)"
    fi

    if command -v screencapture &>/dev/null; then
        echo "  screencapture: AVAILABLE"
    else
        echo "  screencapture: NOT AVAILABLE"
    fi

    echo ""
    echo "Note: Screenshot may require Screen Recording permission."
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
        echo "  type text                           Type text via clipboard"
        echo "  type-cjk text                       Type CJK text via clipboard"
        echo "  key keyname                         Press a key"
        echo "  key-combo mod,key                   Press key combo"
        echo "  activate appname                    Bring application to front"
        echo "  window-bounds appname               Get window position and size"
        echo "  window-move appname x y             Move window"
        echo "  window-resize appname w h           Resize window"
        echo "  list-apps                           List visible applications"
        echo "  scale-factor                        Get display scale factor"
        echo "  pixel-to-logical px py              Convert pixel to logical coords"
        echo "  check-permissions                   Check accessibility permissions"
        echo "  wait seconds                        Wait for specified seconds"
        exit 1
        ;;
esac
