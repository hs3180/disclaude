#!/usr/bin/env bash
# schedule/chats-cleanup.sh — Clean up expired/failed chat files past retention period
#
# Environment variables (optional):
#   CHAT_RETENTION_HOURS  Hours to retain expired/failed files (default: 1)
#   CHAT_MAX_PER_RUN      Max files to clean per execution (default: 50)
#
# Exit codes:
#   0 — success (or no files to clean)
#   1 — fatal error (missing dependencies)

set -euo pipefail

CHAT_RETENTION_HOURS="${CHAT_RETENTION_HOURS:-1}"
CHAT_MAX_PER_RUN="${CHAT_MAX_PER_RUN:-50}"

# Validate retention hours
if ! [[ "$CHAT_RETENTION_HOURS" =~ ^[0-9]+$ ]]; then
  echo "WARN: Invalid CHAT_RETENTION_HOURS='$CHAT_RETENTION_HOURS', falling back to 1"
  CHAT_RETENTION_HOURS=1
fi

# Validate max per run
if ! [[ "$CHAT_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_MAX_PER_RUN='$CHAT_MAX_PER_RUN', falling back to 50"
  CHAT_MAX_PER_RUN=50
fi

CLEANED=0
SKIPPED=0

# ---- Step 0: Environment check (fail-fast) ----
_missing_deps=()

which jq 2>/dev/null || _missing_deps+=("jq")
which flock 2>/dev/null || _missing_deps+=("flock (Linux-only, see docs)")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

CHAT_DIR=$(cd workspace/chats 2>/dev/null && pwd) || {
  echo "INFO: No chats directory found"
  exit 0
}

# Calculate cutoff time (retention hours ago)
cutoff_seconds=$((CHAT_RETENTION_HOURS * 3600))
# Use stat to get file mtime as epoch, subtract retention period
now_epoch=$(date +%s)

# ---- Step 1: Find expired/failed chats past retention ----
for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Rate limit
  if [ "$CLEANED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max cleanup limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi

  # Validate JSON
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)

  # Only process expired or failed
  if [ "$status" != "expired" ] && [ "$status" != "failed" ]; then
    continue
  fi

  chat_id=$(jq -r '.id' "$f" 2>/dev/null)

  # Determine file age: prefer expiredAt/failedAt, fallback to mtime
  timestamp_field=""
  if [ "$status" = "expired" ]; then
    timestamp_field=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
  else
    timestamp_field=$(jq -r '.failedAt // empty' "$f" 2>/dev/null)
  fi

  if [ -n "$timestamp_field" ]; then
    # Parse ISO 8601 timestamp to epoch (basic parsing, works for Z-suffix)
    if echo "$timestamp_field" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
      ts_epoch=$(date -d "${timestamp_field}" +%s 2>/dev/null || echo "0")
    else
      # Non-UTC format, use mtime fallback
      ts_epoch=$(stat -c %Y "$f" 2>/dev/null || echo "0")
    fi
  else
    # No timestamp field, use file mtime
    ts_epoch=$(stat -c %Y "$f" 2>/dev/null || echo "0")
  fi

  # Check if past retention period
  age_seconds=$((now_epoch - ts_epoch))
  if [ "$age_seconds" -lt "$cutoff_seconds" ]; then
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # ---- Step 2: Acquire lock and delete ----
  exec 9>"${f}.lock"
  if ! flock -n 9 2>/dev/null; then
    echo "WARN: Chat $chat_id is locked by another process, skipping cleanup"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Re-check status under lock
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "expired" ] && [ "$current_status" != "failed" ]; then
    echo "INFO: Chat $chat_id status changed to '$current_status', skipping cleanup"
    exec 9>&-
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  # Delete files
  rm -f "$f"
  rm -f "${f}.lock"
  exec 9>&-

  echo "INFO: Cleaned up chat $chat_id (status was $current_status)"
  CLEANED=$((CLEANED + 1))
done

# ---- Step 3: Clean up orphaned lock files ----
for lockfile in "$CHAT_DIR"/*.lock; do
  [ -f "$lockfile" ] || continue

  # Check if corresponding .json file exists
  jsonfile="${lockfile%.lock}"
  if [ ! -f "$jsonfile" ]; then
    rm -f "$lockfile"
    echo "INFO: Removed orphaned lock file: $lockfile"
  fi
done

echo "INFO: Cleanup complete — cleaned: $CLEANED, skipped: $SKIPPED"
