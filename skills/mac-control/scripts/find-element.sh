#!/usr/bin/env bash
# skills/mac-control/scripts/find-element.sh — Find UI elements via Accessibility API.
#
# Searches the accessibility tree of an application for elements matching
# the given criteria (role, text, or both).
#
# Usage:
#   bash skills/mac-control/scripts/find-element.sh "App Name" [options]
#
# Options:
#   --role ROLE        Filter by accessibility role (e.g., AXButton, AXTextField)
#   --text TEXT        Filter by element title/description containing text
#   --max-depth N      Maximum tree depth to search (default: 8)
#   --limit N          Maximum number of results (default: 20)
#
# Output (JSON):
#   {
#     "elements": [
#       {
#         "role": "AXButton",
#         "title": "Send",
#         "position": { "x": 1200, "y": 800 },
#         "size": { "width": 80, "height": 30 }
#       }
#     ],
#     "count": 1
#   }
#
# Exit codes:
#   0 — success (may return empty elements array)
#   1 — error (not macOS, app not found, etc.)

set -euo pipefail

# --- Defaults ---
APP_NAME=""
ROLE_FILTER=""
TEXT_FILTER=""
MAX_DEPTH=8
LIMIT=20

# --- Parse arguments ---
if [[ $# -lt 1 ]]; then
  echo "Usage: find-element.sh <app_name> [--role ROLE] [--text TEXT] [--max-depth N] [--limit N]" >&2
  exit 1
fi

APP_NAME="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      ROLE_FILTER="$2"
      shift 2
      ;;
    --text)
      TEXT_FILTER="$2"
      shift 2
      ;;
    --max-depth)
      MAX_DEPTH="$2"
      shift 2
      ;;
    --limit)
      LIMIT="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# --- Platform check ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo '{"error": "Not running on macOS. Accessibility API requires macOS."}' >&2
  exit 1
fi

# --- Build AppleScript to traverse accessibility tree ---
# Using unquoted heredoc so shell variables are expanded,
# while AppleScript's possessive syntax ('s) works naturally.
osascript <<APPLESCRIPT
set appName to "$APP_NAME"
set roleFilter to "$ROLE_FILTER"
set textFilter to "$TEXT_FILTER"
set maxDepth to $MAX_DEPTH
set resultLimit to $LIMIT

tell application "System Events"
  try
    if not (exists process appName) then
      return "{\"elements\": [], \"count\": 0, \"error\": \"Application not running\"}"
    end if

    set resultList to {}

    -- Recursive handler to walk the accessibility tree
    on walkTree(element, depth, maxD, roleF, textF, limit, results)
      if depth > maxD then return results
      if (count of results) >= limit then return results

      try
        set elemRole to role of element as text
      on error
        set elemRole to "unknown"
      end try

      try
        set elemTitle to description of element as text
      on error
        try
          set elemTitle to title of element as text
        on error
          set elemTitle to ""
        end try
      end try

      set matchesRole to true
      set matchesText to true

      if roleF is not "" then
        if elemRole is not roleF then set matchesRole to false
      end if

      if textF is not "" then
        if elemTitle does not contain textF then set matchesText to false
      end if

      if matchesRole and matchesText then
        try
          set elemPos to position of element
          set elemSize to size of element
          set px to item 1 of elemPos as integer
          set py to item 2 of elemPos as integer
          set sw to item 1 of elemSize as integer
          set sh to item 2 of elemSize as integer

          set end of results to "{" & quote & "role" & quote & ":" & quote & elemRole & quote & "," & quote & "title" & quote & ":" & quote & elemTitle & quote & "," & quote & "position" & quote & ":{" & quote & "x" & quote & ":" & px & "," & quote & "y" & quote & ":" & py & "}," & quote & "size" & quote & ":{" & quote & "width" & quote & ":" & sw & "," & quote & "height" & quote & ":" & sh & "}}"
        on error
          -- Element may not support position/size, skip it
        end try
      end if

      -- Recurse into children
      try
        set children to UI elements of element
        repeat with child in children
          set results to my walkTree(child, depth + 1, maxD, roleF, textF, limit, results)
          if (count of results) >= limit then return results
        end repeat
      on error
        -- No children or permission denied, stop recursion
      end try

      return results
    end walkTree

    tell process appName
      set allResults to {}
      repeat with wnd in every window
        set allResults to my walkTree(wnd, 0, maxDepth, roleFilter, textFilter, resultLimit, allResults)
        if (count of allResults) >= resultLimit then exit repeat
      end repeat
    end tell

    set AppleScript's text item delimiters to ","
    set resultsText to allResults as text

    return "{" & quote & "elements" & quote & ":[" & resultsText & "]," & quote & "count" & quote & ":" & (count of allResults) & "}"

  on error errMsg
    return "{\"elements\": [], \"count\": 0, \"error\": \"" & errMsg & "\"}"
  end try
end tell
APPLESCRIPT
