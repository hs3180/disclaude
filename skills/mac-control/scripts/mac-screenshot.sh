#!/bin/bash
# mac-screenshot.sh - Take a macOS screenshot with automatic Retina handling
#
# Usage:
#   mac-screenshot.sh [output_path] [region]
#
# Arguments:
#   output_path  - Path to save screenshot (default: /tmp/mac-control-screenshot.png)
#   region       - Optional region in format x,y,w,h
#
# Output:
#   Writes JSON to stdout with: path, pixel_width, pixel_height, scale_factor, logical_width, logical_height

set -euo pipefail

OUTPUT_PATH="${1:-/tmp/mac-control-screenshot.png}"
REGION="${2:-}"

# Take screenshot
if [ -n "$REGION" ]; then
  screencapture -x -R "$REGION" "$OUTPUT_PATH"
else
  screencapture -x "$OUTPUT_PATH"
fi

# Get pixel dimensions from screenshot
PIXEL_W=$(sips -g pixelWidth "$OUTPUT_PATH" 2>/dev/null | tail -1 | awk '{print $2}')
PIXEL_H=$(sips -g pixelHeight "$OUTPUT_PATH" 2>/dev/null | tail -1 | awk '{print $2}')

# Get logical screen dimensions
LOGICAL_INFO=$(osascript -e '
tell application "Finder"
  set db to bounds of window of desktop
  return (item 1 of db as text) & "," & (item 2 of db as text) & "," & (item 3 of db as text) & "," & (item 4 of db as text)
end tell
' 2>/dev/null || echo "0,0,1440,900")

LOGICAL_W=$(echo "$LOGICAL_INFO" | cut -d',' -f3 | tr -d ' ')
LOGICAL_H=$(echo "$LOGICAL_INFO" | cut -d',' -f4 | tr -d ' ')

# Calculate scale factor
if [ -n "$PIXEL_W" ] && [ -n "$LOGICAL_W" ] && [ "$LOGICAL_W" -gt 0 ] 2>/dev/null; then
  SCALE_FACTOR=$(echo "scale=1; $PIXEL_W / $LOGICAL_W" | bc 2>/dev/null || echo "1")
else
  SCALE_FACTOR="1"
fi

# Output metadata as JSON
cat <<EOF
{
  "path": "$OUTPUT_PATH",
  "pixelWidth": $PIXEL_W,
  "pixelHeight": $PIXEL_H,
  "logicalWidth": $LOGICAL_W,
  "logicalHeight": $LOGICAL_H,
  "scaleFactor": $SCALE_FACTOR
}
EOF
