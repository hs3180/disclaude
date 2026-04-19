#!/usr/bin/env bash
#
# macOS window management via AppleScript / System Events.
#
# Usage:
#   mac-window.sh bounds "App Name"      — Get window bounds (JSON)
#   mac-window.sh activate "App Name"    — Bring app to front
#   mac-window.sh list                   — List all visible windows
#
# Part of Issue #2216 Phase 1: Window bounds acquisition.

set -euo pipefail

# ─── Helpers ──────────────────────────────────────────────────────────────────

json_result() {
  local success="$1"; shift
  if [ "$success" = "true" ]; then
    printf '{"success":true'
    for kv in "$@"; do
      printf ',%s' "$kv"
    done
    printf '}\n'
  else
    local error_msg="${1:-unknown error}"
    printf '{"success":false,"error":"%s"}\n' "$error_msg"
  fi
}

escape_json_string() {
  # Basic JSON string escaping
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g'
}

# ─── Get Scale Factor ─────────────────────────────────────────────────────────

get_scale_factor() {
  python3 -c "
import AppKit
screen = AppKit.NSScreen.mainScreen()
print(screen.backingScaleFactor())
" 2>/dev/null || echo "2"
}

# ─── Commands ─────────────────────────────────────────────────────────────────

cmd_bounds() {
  local app_name="$1"

  # Get window bounds via AppleScript
  local bounds_json
  bounds_json=$(osascript -e "
tell application \"System Events\"
  set theApp to first process whose name contains \"$(escape_json_string "$app_name")\"
  set theWindow to first window of theApp
  set {x, y} to position of theWindow
  set {w, h} to size of theWindow
  return \"{\\\"x\\\":\" & x & \",\\\"y\\\":\" & y & \",\\\"width\\\":\" & w & \",\\\"height\\\":\" & h & \"}\"
end tell
" 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$bounds_json" ]; then
    json_result false "App not found or no visible window: $app_name"
    return 1
  fi

  local scale
  scale=$(get_scale_factor)

  # Combine bounds with scale factor
  printf '{"success":true,%s,"scaleFactor":%s}\n' "$bounds_json" "$scale"
}

cmd_activate() {
  local app_name="$1"

  osascript -e "
tell application \"$(escape_json_string "$app_name")\"
  activate
end tell
" 2>/dev/null

  if [ $? -ne 0 ]; then
    json_result false "Failed to activate app: $app_name"
    return 1
  fi

  # Small delay to allow window to come to foreground
  sleep 0.3

  json_result true "\"action\":\"activate\",\"app\":\"$(escape_json_string "$app_name")\""
}

cmd_list() {
  local result
  result=$(osascript -e '
use AppleScript version "2.4"
use framework "Foundation"
use scripting additions

set windowList to {}

tell application "System Events"
  set allProcesses to every process whose background only is false
  repeat with theProcess in allProcesses
    set procName to name of theProcess
    try
      set allWindows to every window of theProcess
      repeat with theWindow in allWindows
        set {x, y} to position of theWindow
        set {w, h} to size of theWindow
        set winName to name of theWindow
        set end of windowList to "{\"app\":\"" & procName & "\",\"title\":\"" & winName & "\",\"x\":" & x & ",\"y\":" & y & ",\"width\":" & w & ",\"height\":" & h & "}"
      end repeat
    end try
  end repeat
end tell

set AppleScript'\''s text item delimiters to ","
return "[" & (windowList as text) & "]"
' 2>/dev/null)

  if [ $? -ne 0 ] || [ -z "$result" ]; then
    json_result false "Failed to list windows"
    return 1
  fi

  printf '{"success":true,"windows":%s}\n' "$result"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

if [ $# -lt 1 ]; then
  echo "Usage: mac-window.sh <command> [args]"
  echo "Commands: bounds <app>, activate <app>, list"
  exit 1
fi

COMMAND="$1"
shift

case "$COMMAND" in
  bounds)
    if [ $# -lt 1 ]; then
      json_result false "Usage: mac-window.sh bounds <app-name>"
      exit 1
    fi
    cmd_bounds "$1"
    ;;
  activate)
    if [ $# -lt 1 ]; then
      json_result false "Usage: mac-window.sh activate <app-name>"
      exit 1
    fi
    cmd_activate "$1"
    ;;
  list)
    cmd_list
    ;;
  *)
    json_result false "Unknown command: $COMMAND. Use: bounds, activate, list"
    exit 1
    ;;
esac
