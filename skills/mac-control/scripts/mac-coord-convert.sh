#!/bin/bash
# mac-coord-convert.sh - Convert between screenshot pixel coordinates and logical (cliclick) coordinates
#
# Usage:
#   mac-coord-convert.sh screenshot_x screenshot_y [scale_factor]
#
# If scale_factor is not provided, it will be auto-detected.
#
# Output: JSON with both coordinate systems

set -euo pipefail

SX="${1:?Usage: mac-coord-convert.sh screenshot_x screenshot_y [scale_factor]}"
SY="${2:?}"
SCALE="${3:-}"

# Auto-detect scale factor if not provided
if [ -z "$SCALE" ]; then
  # Get logical screen width
  LOGICAL_W=$(osascript -e '
  tell application "Finder"
    set db to bounds of window of desktop
    return (item 3 of db as text)
  end tell
  ' 2>/dev/null || echo "1440")

  # Take a quick screenshot to get pixel width
  screencapture -x /tmp/_coord_check.png 2>/dev/null
  PIXEL_W=$(sips -g pixelWidth /tmp/_coord_check.png 2>/dev/null | tail -1 | awk '{print $2}')
  rm -f /tmp/_coord_check.png

  if [ -n "$PIXEL_W" ] && [ -n "$LOGICAL_W" ] && [ "$LOGICAL_W" -gt 0 ] 2>/dev/null; then
    SCALE=$(echo "scale=1; $PIXEL_W / $LOGICAL_W" | bc 2>/dev/null || echo "1")
  else
    SCALE="1"
  fi
fi

# Convert screenshot pixel coords to logical coords
LX=$(echo "scale=0; $SX / $SCALE" | bc 2>/dev/null || echo "$SX")
LY=$(echo "scale=0; $SY / $SCALE" | bc 2>/dev/null || echo "$SY")

cat <<EOF
{
  "screenshot": {
    "x": $SX,
    "y": $SY
  },
  "logical": {
    "x": $LX,
    "y": $LY
  },
  "scaleFactor": $SCALE,
  "cliclickCommand": "c $LX,$LY"
}
EOF
