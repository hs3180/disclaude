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

require_cliclick() {
    command -v cliclick &>/dev/null || die "cliclick not found. Install with: brew install cliclick"
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
    require_cliclick
    local x="$1" y="$2"
    cliclick "c:${x},${y}"
    echo "Clicked at (${x}, ${y})"
}

cmd_right_click() {
    require_cliclick
    local x="$1" y="$2"
    cliclick "rc:${x},${y}"
    echo "Right-clicked at (${x}, ${y})"
}

cmd_double_click() {
    require_cliclick
    local x="$1" y="$2"
    cliclick "dc:${x},${y}"
    echo "Double-clicked at (${x}, ${y})"
}

cmd_drag() {
    require_cliclick
    local x1="$1" y1="$2" x2="$3" y2="$4"
    cliclick "dd:${x1},${y1}" "dc:${x2},${y2}"
    echo "Dragged from (${x1}, ${y1}) to (${x2}, ${y2})"
}

cmd_type() {
    require_cliclick
    local text="$*"
    cliclick "t:${text}"
    echo "Typed: ${text}"
}

cmd_type_cjk() {
    require_cliclick
    local text="$*"
    # Save current clipboard
    local old_clipboard=""
    old_clipboard=$(pbpaste 2>/dev/null || true)
    # Copy text to clipboard and paste
    echo -n "$text" | pbcopy
    sleep 0.1
    cliclick "kp:cmd,v"
    sleep 0.2
    # Restore clipboard
    echo -n "$old_clipboard" | pbcopy 2>/dev/null || true
    echo "Typed CJK text via clipboard: ${text}"
}

cmd_key() {
    require_cliclick
    local key="$1"
    cliclick "kp:${key}"
    echo "Pressed key: ${key}"
}

cmd_key_combo() {
    require_cliclick
    local combo="$1"
    cliclick "kp:${combo}"
    echo "Pressed combo: ${combo}"
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
                return {wPos, wSize}
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
    factor=$(system_profiler SPDisplaysDataType 2>/dev/null | grep -c "Retina" || true)
    if [[ "$factor" -gt 0 ]]; then
        echo "2 (Retina)"
    else
        # Fallback: check via python3 + Quartz
        factor=$(python3 -c "
import sys
try:
    import Quartz
    mainDisplay = Quartz.CGMainDisplayID()
    w = Quartz.CGDisplayPixelsWide(mainDisplay)
    mode = Quartz.CGDisplayCopyDisplayMode(mainDisplay)
    mode_w = Quartz.CGDisplayModeGetWidth(mode)
    scale = round(w / mode_w)
    print(scale)
except Exception:
    print(1)
" 2>/dev/null || echo "1")
        echo "${factor}"
    fi
}

cmd_pixel_to_logical() {
    local px="$1" py="$2"
    local scale
    scale=$(cmd_scale_factor)
    scale="${scale%% *}"  # Extract just the number
    local lx=$(( px / scale ))
    local ly=$(( py / scale ))
    echo "Pixel (${px}, ${py}) -> Logical (${lx}, ${ly}) [scale=${scale}x]"
}

cmd_check_permissions() {
    echo "Checking macOS accessibility permissions..."

    # Check if we can use System Events
    if osascript -e 'tell application "System Events" to get name of first process' &>/dev/null; then
        echo "  Accessibility: GRANTED"
    else
        echo "  Accessibility: DENIED"
        echo "  -> Grant at: System Settings > Privacy & Security > Accessibility"
    fi

    # Check cliclick
    if command -v cliclick &>/dev/null; then
        echo "  cliclick: INSTALLED"
    else
        echo "  cliclick: NOT INSTALLED (brew install cliclick)"
    fi

    # Check screencapture
    if command -v screencapture &>/dev/null; then
        echo "  screencapture: AVAILABLE"
    else
        echo "  screencapture: NOT AVAILABLE"
    fi

    # Check screen recording permission
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
        echo "  type text                           Type ASCII text"
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
