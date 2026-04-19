#!/usr/bin/env bash
# mac-screenshot.sh — Take screenshot with auto-naming and optional region
# Usage: mac-screenshot.sh [--region x,y,w,h] [--output path.png]
# Requires: macOS, screencapture

set -euo pipefail

region=""
output_path=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)
      region="$2"
      shift 2
      ;;
    --output)
      output_path="$2"
      shift 2
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--region x,y,w,h] [--output path.png]" >&2
      exit 1
      ;;
  esac
done

# Verify macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script only works on macOS" >&2
  exit 1
fi

# Default output path
if [[ -z "$output_path" ]]; then
  output_path="/tmp/mac-screenshot-$(date +%s).png"
fi

# Take screenshot
if [[ -n "$region" ]]; then
  screencapture -R "$region" -x "$output_path"
else
  screencapture -x "$output_path"
fi

# Verify screenshot was saved
if [[ -f "$output_path" ]]; then
  # Get image dimensions for Retina calibration info
  dimensions=$(sips -g pixelWidth -g pixelHeight "$output_path" 2>/dev/null | \
    grep -E "pixel(Width|Height)" | awk '{print $2}' | tr '\n' 'x' | sed 's/x$//')

  # Detect scale factor
  scale=$(python3 -c "
try:
    from AppKit import NSScreen
    print(int(NSScreen.mainScreen().backingScaleFactor()))
except:
    print(2)
" 2>/dev/null || echo "2")

  echo "Screenshot saved: $output_path"
  echo "Dimensions: ${dimensions} pixels"
  echo "Scale factor: ${scale}x (Retina)"
  echo "Logical coords: divide pixel coords by ${scale}"
else
  echo "ERROR: Screenshot failed" >&2
  exit 1
fi
