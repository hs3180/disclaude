#!/usr/bin/env bash
# schedule/chats-cleanup.sh — Clean up expired/failed chats and orphaned lock files
#
# Scans workspace/chats/ for expired/failed chat files past the grace period
# and removes them along with orphaned .lock files.
#
# Environment variables (optional):
#   CHAT_CLEANUP_GRACE_HOURS   Hours to keep expired/failed files (default: 24)
#   CHAT_CLEANUP_MAX_PER_RUN   Max files to clean per execution (default: 50)
#
# Exit codes:
#   0 — success (or nothing to clean)
#   1 — fatal error (missing dependencies)

set -euo pipefail

CHAT_CLEANUP_GRACE_HOURS="${CHAT_CLEANUP_GRACE_HOURS:-24}"
CHAT_CLEANUP_MAX_PER_RUN="${CHAT_CLEANUP_MAX_PER_RUN:-50}"

# Validate CHAT_CLEANUP_GRACE_HOURS is a positive integer
if ! [[ "$CHAT_CLEANUP_GRACE_HOURS" =~ ^[0-9]+$ ]] || [ "$CHAT_CLEANUP_GRACE_HOURS" -eq 0 ]; then
  echo "WARN: Invalid CHAT_CLEANUP_GRACE_HOURS='$CHAT_CLEANUP_GRACE_HOURS', falling back to 24"
  CHAT_CLEANUP_GRACE_HOURS=24
fi

# Validate CHAT_CLEANUP_MAX_PER_RUN is a positive integer
if ! [[ "$CHAT_CLEANUP_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_CLEANUP_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_CLEANUP_MAX_PER_RUN='$CHAT_CLEANUP_MAX_PER_RUN', falling back to 50"
  CHAT_CLEANUP_MAX_PER_RUN=50
fi

CLEANED=0

# ---- Step 0: Environment check (fail-fast) ----
_missing_deps=()

which jq 2>/dev/null || _missing_deps+=("jq")
which flock 2>/dev/null || _missing_deps+=("flock (Linux-only, see docs)")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

mkdir -p workspace/chats

CHAT_DIR=$(cd workspace/chats && pwd)
now_epoch=$(date -u +%s)
grace_seconds=$((CHAT_CLEANUP_GRACE_HOURS * 3600))

# ---- Step 1: Clean up expired/failed chat files past grace period ----
for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Rate limit: stop after MAX per run
  if [ "$CLEANED" -ge "$CHAT_CLEANUP_MAX_PER_RUN" ]; then
    echo "INFO: Reached max cleanup limit ($CHAT_CLEANUP_MAX_PER_RUN), stopping"
    break
  fi

  # Validate JSON integrity — skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)
  chat_id=$(jq -r '.id // "unknown"' "$f" 2>/dev/null)

  # Only process expired and failed chats
  if [ "$status" != "expired" ] && [ "$status" != "failed" ]; then
    continue
  fi

  # Determine the timestamp to check based on status
  if [ "$status" = "expired" ]; then
    timestamp=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
  else
    timestamp=$(jq -r '.failedAt // empty' "$f" 2>/dev/null)
  fi

  # Skip if no timestamp found
  if [ -z "$timestamp" ]; then
    echo "WARN: Chat $chat_id has status '$status' but no timestamp, skipping"
    continue
  fi

  # Parse timestamp — must be UTC Z-suffix ISO 8601
  # Non-UTC timestamps skip the check (fail-open)
  if ! echo "$timestamp" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    echo "WARN: Chat $chat_id has non-UTC timestamp '$timestamp', skipping"
    continue
  fi

  # Convert to epoch for comparison
  file_epoch=$(date -u -d "$timestamp" +%s 2>/dev/null || echo "0")
  if [ "$file_epoch" -eq 0 ]; then
    echo "WARN: Chat $chat_id has invalid timestamp '$timestamp', skipping"
    continue
  fi

  # Check if past grace period
  age_seconds=$((now_epoch - file_epoch))
  if [ "$age_seconds" -lt "$grace_seconds" ]; then
    continue
  fi

  age_hours=$((age_seconds / 3600))
  echo "INFO: Cleaning up $status chat $chat_id (age: ${age_hours}h, grace: ${CHAT_CLEANUP_GRACE_HOURS}h)"

  # Acquire exclusive lock before deleting
  exec 9>"${f}.lock"
  if ! flock -n 9 2>/dev/null; then
    echo "WARN: Chat $chat_id is locked by another process, skipping"
    exec 9>&-
    continue
  fi

  # Re-check status under lock (another process may have changed it)
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "expired" ] && [ "$current_status" != "failed" ]; then
    echo "INFO: Chat $chat_id status changed to '$current_status', skipping cleanup"
    exec 9>&-
    continue
  fi

  # Delete the chat file
  rm -f "$f" && echo "OK: Deleted chat file: $f" || echo "WARN: Failed to delete chat file: $f"

  # Release the lock fd before removing the lock file
  exec 9>&-

  # Remove the lock file (it's no longer needed)
  rm -f "${f}.lock" 2>/dev/null

  CLEANED=$((CLEANED + 1))
done

# ---- Step 2: Clean up orphaned .lock files ----
orphaned=0
for lock_file in "$CHAT_DIR"/*.lock; do
  [ -f "$lock_file" ] || continue

  # Derive the corresponding JSON file path
  json_file="${lock_file%.lock}"

  # If the JSON file doesn't exist, this is an orphaned lock
  if [ ! -f "$json_file" ]; then
    echo "INFO: Removing orphaned lock file: $lock_file"
    rm -f "$lock_file" && orphaned=$((orphaned + 1)) || echo "WARN: Failed to remove orphaned lock: $lock_file"
  fi
done

# ---- Summary ----
total=$((CLEANED + orphaned))
if [ "$total" -eq 0 ]; then
  echo "INFO: No chats to clean up"
else
  echo "INFO: Cleanup complete — $CLEANED chat file(s) + $orphaned orphaned lock(s) removed"
fi
