#!/usr/bin/env bash
# schedule/chats-cleanup.sh — Clean up expired/failed chat files and orphaned lock files
#
# Removes chat files in 'expired' or 'failed' status that have exceeded the retention period,
# and cleans up orphaned .lock files (no corresponding .json file).
#
# Environment variables (optional):
#   CHAT_CLEANUP_RETENTION_DAYS  Days to retain expired/failed files (default: 7)
#
# Exit codes:
#   0 — success (or nothing to clean)
#   1 — fatal error (missing dependencies)

set -euo pipefail

CHAT_CLEANUP_RETENTION_DAYS="${CHAT_CLEANUP_RETENTION_DAYS:-7}"

# Validate retention days is a positive integer
if ! [[ "$CHAT_CLEANUP_RETENTION_DAYS" =~ ^[0-9]+$ ]] || [ "$CHAT_CLEANUP_RETENTION_DAYS" -eq 0 ]; then
  echo "WARN: Invalid CHAT_CLEANUP_RETENTION_DAYS='$CHAT_CLEANUP_RETENTION_DAYS', falling back to 7"
  CHAT_CLEANUP_RETENTION_DAYS=7
fi

DELETED_FILES=0
DELETED_LOCKS=0

# ---- Step 0: Environment check (fail-fast) ----
_missing_deps=()

which jq 2>/dev/null || _missing_deps+=("jq")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

CHAT_DIR="workspace/chats"

# If chat directory doesn't exist, nothing to clean
if [ ! -d "$CHAT_DIR" ]; then
  echo "INFO: Chat directory '$CHAT_DIR' does not exist, nothing to clean"
  exit 0
fi

CHAT_DIR=$(cd "$CHAT_DIR" && pwd)

# ---- Step 1: Clean up expired/failed chat files ----
now_epoch=$(date -u +%s)
retention_seconds=$((CHAT_CLEANUP_RETENTION_DAYS * 86400))
cutoff_epoch=$((now_epoch - retention_seconds))

echo "INFO: Cleaning up chats older than $CHAT_CLEANUP_RETENTION_DAYS days (cutoff: $(date -u -d "@$cutoff_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -r "$cutoff_epoch" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null))"

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Validate JSON integrity — skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)

  # Only process expired or failed chats
  if [ "$status" != "expired" ] && [ "$status" != "failed" ]; then
    continue
  fi

  # Determine the timestamp field based on status
  if [ "$status" = "expired" ]; then
    ts_field=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
  else
    ts_field=$(jq -r '.failedAt // empty' "$f" 2>/dev/null)
  fi

  # If no timestamp found, use file modification time as fallback
  if [ -z "$ts_field" ]; then
    file_mtime=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null)
    if [ -n "$file_mtime" ] && [ "$file_mtime" -lt "$cutoff_epoch" ]; then
      chat_id=$(jq -r '.id' "$f" 2>/dev/null)
      echo "INFO: Deleting $status chat $chat_id (no timestamp, file mtime older than retention)"
      rm -f "$f"
      rm -f "${f}.lock"
      DELETED_FILES=$((DELETED_FILES + 1))
    fi
    continue
  fi

  # Validate timestamp format (UTC Z-suffix)
  if ! echo "$ts_field" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    chat_id=$(jq -r '.id' "$f" 2>/dev/null)
    echo "WARN: Chat $chat_id has non-UTC timestamp '$ts_field', skipping"
    continue
  fi

  # Convert timestamp to epoch for comparison
  ts_epoch=$(date -u -d "$ts_field" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts_field" +%s 2>/dev/null)

  if [ -z "$ts_epoch" ]; then
    chat_id=$(jq -r '.id' "$f" 2>/dev/null)
    echo "WARN: Could not parse timestamp '$ts_field' for chat $chat_id, skipping"
    continue
  fi

  if [ "$ts_epoch" -lt "$cutoff_epoch" ]; then
    chat_id=$(jq -r '.id' "$f" 2>/dev/null)
    echo "INFO: Deleting $status chat $chat_id (timestamp: $ts_field)"
    rm -f "$f"
    rm -f "${f}.lock"
    DELETED_FILES=$((DELETED_FILES + 1))
  fi
done

# ---- Step 2: Clean up orphaned .lock files ----
for lock_file in "$CHAT_DIR"/*.lock; do
  [ -f "$lock_file" ] || continue

  # Derive the expected JSON file path
  json_file="${lock_file%.lock}"

  if [ ! -f "$json_file" ]; then
    echo "INFO: Deleting orphaned lock file: $(basename "$lock_file")"
    rm -f "$lock_file"
    DELETED_LOCKS=$((DELETED_LOCKS + 1))
  fi
done

echo "INFO: Cleanup complete — deleted $DELETED_FILES chat file(s), $DELETED_LOCKS orphaned lock file(s)"
