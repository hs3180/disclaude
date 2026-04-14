#!/bin/bash
# mac-window-info.sh - Get window information for macOS applications
#
# Usage:
#   mac-window-info.sh [app_name]
#
# Arguments:
#   app_name  - Name of the application (default: frontmost app)
#
# Output: JSON with window bounds and properties

set -euo pipefail

APP_NAME="${1:-}"

get_frontmost_app() {
  osascript -e 'tell application "System Events" to get name of first process whose frontmost is true' 2>/dev/null
}

if [ -z "$APP_NAME" ]; then
  APP_NAME=$(get_frontmost_app)
fi

# Get window bounds
WINDOW_INFO=$(osascript -e "
tell application \"System Events\"
  tell process \"$APP_NAME\"
    try
      set win to front window
      set {wx, wy} to position of win
      set {ww, wh} to size of win
      set winName to name of win
      return (wx as text) & \",\" & (wy as text) & \",\" & (ww as text) & \",\" & (wh as text) & \",\" & winName
    on error errMsg
      return \"error:\" & errMsg
    end try
  end tell
end tell
" 2>/dev/null)

if echo "$WINDOW_INFO" | grep -q "^error:"; then
  echo "{\"error\": \"$(echo "$WINDOW_INFO" | sed 's/error://')\", \"appName\": \"$APP_NAME\"}"
  exit 1
fi

# Parse window info
WX=$(echo "$WINDOW_INFO" | cut -d',' -f1 | tr -d ' ')
WY=$(echo "$WINDOW_INFO" | cut -d',' -f2 | tr -d ' ')
WW=$(echo "$WINDOW_INFO" | cut -d',' -f3 | tr -d ' ')
WH=$(echo "$WINDOW_INFO" | cut -d',' -f4 | tr -d ' ')
WNAME=$(echo "$WINDOW_INFO" | cut -d',' -f5-)

cat <<EOF
{
  "appName": "$APP_NAME",
  "windowName": "$WNAME",
  "bounds": {
    "x": $WX,
    "y": $WY,
    "width": $WW,
    "height": $WH
  },
  "center": {
    "x": $((WX + WW / 2)),
    "y": $((WY + WH / 2))
  }
}
EOF
