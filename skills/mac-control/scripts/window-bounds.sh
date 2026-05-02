#!/usr/bin/env bash
# skills/mac-control/scripts/window-bounds.sh — Get window bounds for an application.
#
# Returns the position (x, y) and size (width, height) of the frontmost window
# of the specified application, in logical points.
#
# Usage:
#   bash skills/mac-control/scripts/window-bounds.sh "App Name"
#
# Output (JSON):
#   {
#     "app": "Feishu",
#     "x": 0,
#     "y": 25,
#     "width": 1440,
#     "height": 875,
#     "scaleFactor": 2.0,
#     "screen": {
#       "width": 1440,
#       "height": 900
#     }
#   }
#
# Exit codes:
#   0 — success
#   1 — error (not macOS, app not found, etc.)

set -euo pipefail

# --- Arguments ---
if [[ $# -lt 1 ]]; then
  echo "Usage: window-bounds.sh <app_name>" >&2
  exit 1
fi

APP_NAME="$1"

# --- Platform check ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo '{"error": "Not running on macOS. osascript requires macOS."}' >&2
  exit 1
fi

# --- Get window bounds and screen info ---
# Using unquoted heredoc so $APP_NAME is expanded,
# but AppleScript's single quotes are preserved.
osascript <<APPLESCRIPT
use AppleScript version "2.4"
use framework "AppKit"

set appName to "$APP_NAME"

tell application "System Events"
  try
    -- Check if app process exists
    if not (exists process appName) then
      return "{\"error\": \"Application '\" & appName & \"' is not running\"}"
    end if

    tell process appName
      if (count of windows) is 0 then
        return "{\"error\": \"Application '\" & appName & \"' has no visible windows\"}"
      end if

      set windowBounds to bounds of window 1
      -- bounds format: {x, y, x+width, y+height}
      set wx to item 1 of windowBounds as integer
      set wy to item 2 of windowBounds as integer
      set ww to ((item 3 of windowBounds) - wx) as integer
      set wh to ((item 4 of windowBounds) - wy) as integer
    end tell

    -- Get screen scale factor
    set scaleFactor to ((current application)'s NSScreen's mainScreen()'s backingScaleFactor()) as real

    -- Get main screen dimensions (logical points)
    set mainScreen to (current application)'s NSScreen's mainScreen()
    set screenFrame to mainScreen's frame()
    set sw to (item 1 of (screenFrame's |size|())) as integer
    set sh to (item 2 of (screenFrame's |size|())) as integer

    return "{" & quote & "app" & quote & ":" & quote & appName & quote & "," & quote & "x" & quote & ":" & wx & "," & quote & "y" & quote & ":" & wy & "," & quote & "width" & quote & ":" & ww & "," & quote & "height" & quote & ":" & wh & "," & quote & "scaleFactor" & quote & ":" & scaleFactor & "," & quote & "screen" & quote & ":{" & quote & "width" & quote & ":" & sw & "," & quote & "height" & quote & ":" & sh & "}}"

  on error errMsg
    return "{\"error\": \"" & errMsg & "\"}"
  end try
end tell
APPLESCRIPT
