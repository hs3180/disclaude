#!/usr/bin/env bash
# skills/mac-control/scripts/calibrate.sh — Detect macOS display scale factor and screen dimensions.
#
# Usage:
#   bash skills/mac-control/scripts/calibrate.sh
#
# Output (JSON):
#   {
#     "displays": [
#       {
#         "id": 1,
#         "scaleFactor": 2.0,
#         "pixels": { "width": 2880, "height": 1800 },
#         "points": { "width": 1440, "height": 900 }
#       }
#     ],
#     "primaryScaleFactor": 2.0
#   }
#
# Exit codes:
#   0 — success
#   1 — not running on macOS or missing tools

set -euo pipefail

# --- Platform check ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo '{"error": "Not running on macOS. This script requires macOS."}' >&2
  exit 1
fi

# --- Detect scale factor and screen dimensions via osascript ---
osascript <<'APPLESCRIPT'
use AppleScript version "2.4"
use framework "Foundation"
use framework "AppKit"

tell application "System Events"
  set primaryScale to 2.0
  try
    set allScreens to (current application)'s NSScreen's screens()
    set screenCount to count of allScreens
    set displayList to {}

    repeat with i from 1 to screenCount
      set aScreen to item i of allScreens
      set frame to aScreen's frame()

      -- Get backing scale factor
      set scaleFactor to (aScreen's backingScaleFactor()) as real

      -- Get frame dimensions (in logical points)
      set ptWidth to (item 1 of (frame's |size|())) as integer
      set ptHeight to (item 2 of (frame's |size|())) as integer

      -- Calculate pixel dimensions
      set pxWidth to (ptWidth * scaleFactor) as integer
      set pxHeight to (ptHeight * scaleFactor) as integer

      set end of displayList to "{" & quote & "id" & quote & ":" & i & "," & quote & "scaleFactor" & quote & ":" & scaleFactor & "," & quote & "pixels" & quote & ":{" & quote & "width" & quote & ":" & pxWidth & "," & quote & "height" & quote & ":" & pxHeight & "}," & quote & "points" & quote & ":{" & quote & "width" & quote & ":" & ptWidth & "," & quote & "height" & quote & ":" & ptHeight & "}}"

      if i is 1 then
        set primaryScale to scaleFactor
      end if
    end repeat

    set AppleScript's text item delimiters to ","
    set displaysText to displayList as text
    return "{" & quote & "displays" & quote & ":[" & displaysText & "]," & quote & "primaryScaleFactor" & quote & ":" & primaryScale & "}"
  on error errMsg
    return "{" & quote & "error" & quote & ":" & quote & errMsg & quote & "}"
  end try
end tell
APPLESCRIPT
