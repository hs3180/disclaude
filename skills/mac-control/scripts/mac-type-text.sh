#!/bin/bash
# mac-type-text.sh - Type text on macOS, handling Chinese/CJK characters
#
# Usage:
#   mac-type-text.sh "text to type" [--clipboard|--direct]
#
# Options:
#   --clipboard  Use clipboard paste method (default, required for CJK)
#   --direct     Use cliclick t: command (ASCII only)
#
# The script automatically detects non-ASCII characters and uses
# clipboard paste method for them regardless of the flag.

set -euo pipefail

TEXT="${1:?Usage: mac-type-text.sh \"text to type\" [--clipboard|--direct]}"
METHOD="${2:---clipboard}"

# Detect non-ASCII characters
HAS_NON_ASCII=false
if echo "$TEXT" | LC_ALL=C grep -q '[^[:ASCII:]]' 2>/dev/null; then
  HAS_NON_ASCII=true
fi

# Force clipboard method for non-ASCII text
if [ "$HAS_NON_ASCII" = true ] && [ "$METHOD" = "--direct" ]; then
  echo "Warning: Non-ASCII characters detected, switching to clipboard method" >&2
  METHOD="--clipboard"
fi

if [ "$METHOD" = "--clipboard" ]; then
  # Save current clipboard content
  CLIPBOARD_BACKUP=$(pbpaste 2>/dev/null | base64 || true)

  # Copy text to clipboard and paste
  echo -n "$TEXT" | pbcopy
  sleep 0.1

  # Trigger Cmd+V paste
  cliclick kd:cmd kc:v ku:cmd
  sleep 0.3

  # Restore original clipboard
  if [ -n "$CLIPBOARD_BACKUP" ]; then
    echo "$CLIPBOARD_BACKUP" | base64 -d | pbcopy 2>/dev/null || true
  fi
else
  # Direct typing (ASCII only) - replace spaces with underscores for cliclick
  CLICK_TEXT=$(echo "$TEXT" | sed 's/ /_/g')
  cliclick "t:$CLICK_TEXT"
fi
