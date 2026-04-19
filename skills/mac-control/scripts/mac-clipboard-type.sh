#!/usr/bin/env bash
# mac-clipboard-type.sh — Type text via clipboard paste (supports CJK/Unicode)
# Usage: mac-clipboard-type.sh "text to type"
# Requires: macOS, pbcopy, osascript with Accessibility permission

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <text>" >&2
  echo "  Types the given text via clipboard paste, preserving original clipboard content." >&2
  exit 1
fi

text="$1"

# Verify macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: This script only works on macOS" >&2
  exit 1
fi

# Save current clipboard content
old_clipboard=""
if pbpaste &>/dev/null; then
  old_clipboard=$(pbpaste 2>/dev/null || true)
fi

# Put text on clipboard and paste
echo -n "$text" | pbcopy

# Small delay to ensure clipboard is ready
sleep 0.1

# Simulate Cmd+V
osascript -e 'tell application "System Events" to keystroke "v" using command down'

# Wait for paste to complete
sleep 0.3

# Restore original clipboard
if [[ -n "$old_clipboard" ]]; then
  echo -n "$old_clipboard" | pbcopy
fi
