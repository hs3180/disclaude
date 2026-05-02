#!/usr/bin/env bash
# skills/mac-control/scripts/screenshot.sh — Capture screenshots on macOS.
#
# Usage:
#   bash skills/mac-control/scripts/screenshot.sh <output_path> [options]
#
# Options:
#   (no flags)           Full screen screenshot
#   -r x y w h           Region screenshot (in logical points)
#   -w "app_name"        Window screenshot (by application name)
#   -c                   Include cursor in screenshot
#   -t seconds           Timeout in seconds (default: 10)
#
# Examples:
#   bash skills/mac-control/scripts/screenshot.sh /tmp/screen.png
#   bash skills/mac-control/scripts/screenshot.sh /tmp/region.png -r 100 200 400 300
#   bash skills/mac-control/scripts/screenshot.sh /tmp/window.png -w "Feishu"
#
# Exit codes:
#   0 — success
#   1 — validation error or screenshot failed

set -euo pipefail

# --- Defaults ---
OUTPUT_PATH=""
REGION_ARGS=""
WINDOW_APP=""
SHOW_CURSOR=false
TIMEOUT_SEC=10

# --- Parse arguments ---
if [[ $# -lt 1 ]]; then
  echo "Usage: screenshot.sh <output_path> [-r x y w h] [-w app_name] [-c] [-t seconds]" >&2
  exit 1
fi

OUTPUT_PATH="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    -r)
      if [[ $# -lt 5 ]]; then
        echo "Error: -r requires x y w h arguments" >&2
        exit 1
      fi
      REGION_ARGS="-R ${2},${3},${4},${5}"
      shift 5
      ;;
    -w)
      if [[ $# -lt 2 ]]; then
        echo "Error: -w requires app name argument" >&2
        exit 1
      fi
      WINDOW_APP="$2"
      shift 2
      ;;
    -c)
      SHOW_CURSOR=true
      shift
      ;;
    -t)
      if [[ $# -lt 2 ]]; then
        echo "Error: -t requires seconds argument" >&2
        exit 1
      fi
      TIMEOUT_SEC="$2"
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
  echo '{"error": "Not running on macOS. screencapture requires macOS."}' >&2
  exit 1
fi

# --- Ensure output directory exists ---
OUTPUT_DIR="$(dirname "$OUTPUT_PATH")"
if [[ -n "$OUTPUT_DIR" && "$OUTPUT_DIR" != "." ]]; then
  mkdir -p "$OUTPUT_DIR"
fi

# --- Build screencapture command ---
CAPTURE_ARGS=()

# Capture mode
if [[ -n "$REGION_ARGS" ]]; then
  CAPTURE_ARGS+=($REGION_ARGS)
elif [[ -n "$WINDOW_APP" ]]; then
  # Activate the app first to ensure its window is frontmost
  osascript -e "tell application \"${WINDOW_APP}\" to activate" 2>/dev/null || true
  sleep 0.5
  # -w captures interactive window selection, -o disables shadow
  # Use -l to capture specific window by ID
  WINDOW_ID=$(osascript -e "
    tell application \"System Events\"
      tell process \"${WINDOW_APP}\"
        set windowId to id of window 1
        return windowId
      end tell
    end tell
  " 2>/dev/null || echo "")
  if [[ -n "$WINDOW_ID" ]]; then
    CAPTURE_ARGS+=(-l "$WINDOW_ID" -o)
  else
    # Fallback: capture the frontmost window
    CAPTURE_ARGS+=(-w -o)
  fi
fi

# Cursor
if [[ "$SHOW_CURSOR" == "true" ]]; then
  CAPTURE_ARGS+=(-C)
fi

# Output format (PNG)
CAPTURE_ARGS+=(-t png)

# Output file
CAPTURE_ARGS+=("$OUTPUT_PATH")

# --- Execute ---
if timeout "$TIMEOUT_SEC" screencapture "${CAPTURE_ARGS[@]}" 2>/dev/null; then
  if [[ -f "$OUTPUT_PATH" ]]; then
    # Report dimensions
    DIMS=$(sips -g pixelWidth -g pixelHeight "$OUTPUT_PATH" 2>/dev/null | \
      grep -E 'pixelWidth|pixelHeight' | \
      awk '{print $2}' | tr '\n' ' ')
    PW=$(echo "$DIMS" | awk '{print $1}')
    PH=$(echo "$DIMS" | awk '{print $2}')
    echo "{\"success\": true, \"path\": \"$OUTPUT_PATH\", \"pixels\": {\"width\": $PW, \"height\": $PH}}"
    exit 0
  else
    echo '{"error": "screencapture completed but file not found"}' >&2
    exit 1
  fi
else
  echo '{"error": "screencapture command failed — check Screen Recording permissions"}' >&2
  exit 1
fi
