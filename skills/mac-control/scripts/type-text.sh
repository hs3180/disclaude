#!/usr/bin/env bash
# skills/mac-control/scripts/type-text.sh — Type text via clipboard paste on macOS.
#
# Uses the clipboard paste method (pbcopy + Cmd+V) to reliably input
# any Unicode text including Chinese, Japanese, Korean, emoji, etc.
# This bypasses the input method editor (IME) entirely.
#
# Usage:
#   bash skills/mac-control/scripts/type-text.sh "text to type" [options]
#
# Options:
#   --delay SECONDS   Delay before typing (default: 0.2)
#   --restore         Restore clipboard after typing (default: true)
#   --no-restore      Do not restore clipboard after typing
#
# Examples:
#   bash skills/mac-control/scripts/type-text.sh "Hello World"
#   bash skills/mac-control/scripts/type-text.sh "你好世界"
#   bash skills/mac-control/scripts/type-text.sh "emoji: 😀🎉" --delay 0.5
#
# Exit codes:
#   0 — success
#   1 — error (not macOS, missing tools, etc.)

set -euo pipefail

# --- Defaults ---
DELAY=0.2
RESTORE_CLIPBOARD=true
TEXT=""

# --- Parse arguments ---
if [[ $# -lt 1 ]]; then
  echo "Usage: type-text.sh <text> [--delay SECONDS] [--no-restore]" >&2
  exit 1
fi

TEXT="$1"
shift

while [[ $# -gt 0 ]]; do
  case "$1" in
    --delay)
      if [[ $# -lt 2 ]]; then
        echo "Error: --delay requires seconds argument" >&2
        exit 1
      fi
      DELAY="$2"
      shift 2
      ;;
    --restore)
      RESTORE_CLIPBOARD=true
      shift
      ;;
    --no-restore)
      RESTORE_CLIPBOARD=false
      shift
      ;;
    *)
      echo "Error: Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# --- Platform check ---
if [[ "$(uname)" != "Darwin" ]]; then
  echo '{"error": "Not running on macOS. pbcopy/pbpaste require macOS."}' >&2
  exit 1
fi

# --- Validate text ---
if [[ -z "$TEXT" ]]; then
  echo '{"error": "Empty text provided"}' >&2
  exit 1
fi

# --- Save current clipboard content ---
CLIPBOARD_BACKUP=""
if [[ "$RESTORE_CLIPBOARD" == "true" ]]; then
  CLIPBOARD_BACKUP=$(pbpaste 2>/dev/null || true)
fi

# --- Set text to clipboard ---
echo -n "$TEXT" | pbcopy

# --- Wait for clipboard to settle ---
sleep "$DELAY"

# --- Send Cmd+V via AppleScript ---
# Using AppleScript because it's more reliable than osascript for keystroke events
osascript -e '
tell application "System Events"
  keystroke "v" using command down
end tell
' 2>/dev/null

# --- Small delay for paste to complete ---
sleep 0.1

# --- Restore clipboard ---
if [[ "$RESTORE_CLIPBOARD" == "true" ]]; then
  echo -n "$CLIPBOARD_BACKUP" | pbcopy 2>/dev/null || true
fi

echo "{\"success\": true, \"action\": \"type\", \"length\": ${#TEXT}}"
