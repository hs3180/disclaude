#!/usr/bin/env bash
# chat/list.sh — List chats with optional status filter
#
# Environment variables:
#   CHAT_STATUS (optional) Filter by status: "pending", "active", "expired", "failed"
#
# Exit codes:
#   0 — success (matching chat filenames printed to stdout, one per line)
#   1 — directory not found

set -euo pipefail

FILTER="${CHAT_STATUS:-}"

# ---- Step 1: Validate chat directory (protect against symlink attacks) ----
CHAT_DIR=$(cd workspace/chats 2>/dev/null && pwd) || {
  echo "ERROR: workspace/chats directory not found"
  exit 1
}
CANONICAL_DIR=$(realpath "$CHAT_DIR")

# ---- Step 2: List chats ----
for f in "$CANONICAL_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Verify file is still within chat directory after symlink resolution
  file_dir=$(dirname "$(realpath "$f")")
  if [[ "$file_dir" != "$CANONICAL_DIR" ]]; then
    echo "WARN: Skipping file outside chat directory: $f" >&2
    continue
  fi

  # Skip corrupted files
  jq empty "$f" 2>/dev/null || {
    echo "WARN: Skipping corrupted file: $f" >&2
    continue
  }

  # Acquire shared lock for consistent read (skip if lock unavailable)
  exec 8>"${f}.lock"
  if flock -s -n 8 2>/dev/null; then
    # Apply status filter if provided
    if [ -n "$FILTER" ]; then
      status=$(jq -r '.status' "$f" 2>/dev/null)
      if [ "$status" = "$FILTER" ]; then
        echo "$f"
      fi
    else
      echo "$f"
    fi
  fi
  # Always close fd to prevent descriptor leak across iterations
  exec 8>&-
done
