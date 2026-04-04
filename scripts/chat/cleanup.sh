#!/usr/bin/env bash
# chat/cleanup.sh — Clean up expired chat files past retention period
#
# Scans workspace/chats/ for expired chats older than the retention period
# and deletes their JSON files and lock files.
#
# Environment variables (optional):
#   CHAT_CLEANUP_RETENTION  Retention period in seconds (default: 3600 = 1 hour)
#   CHAT_MAX_PER_RUN        Max chats to process per execution (default: 50)
#
# Exit codes:
#   0 — success (or no expired chats to clean up)
#   1 — fatal error (missing jq)

set -euo pipefail

RETENTION_SECONDS="${CHAT_CLEANUP_RETENTION:-3600}"
CHAT_MAX_PER_RUN="${CHAT_MAX_PER_RUN:-50}"
PROCESSED=0

# Validate retention period
if ! [[ "$RETENTION_SECONDS" =~ ^[0-9]+$ ]] || [ "$RETENTION_SECONDS" -eq 0 ]; then
  echo "WARN: Invalid CHAT_CLEANUP_RETENTION='$RETENTION_SECONDS', falling back to 3600"
  RETENTION_SECONDS=3600
fi

# ---- Step 0: Environment check ----
which jq 2>/dev/null || { echo "FATAL: Missing required dependency: jq"; exit 1; }

mkdir -p workspace/chats
CHAT_DIR=$(cd workspace/chats && pwd)

# ---- Step 1: Scan expired chats past retention ----
now_epoch=$(date +%s)

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  # Only process expired chats
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" != "expired" ]; then
    continue
  fi

  # Determine when the chat was expired
  expired_at=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
  if [ -z "$expired_at" ]; then
    # Fallback to expiresAt if expiredAt not set
    expired_at=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
  fi

  if [ -z "$expired_at" ]; then
    echo "WARN: No timestamp found for expired chat $(jq -r '.id' "$f"), skipping"
    continue
  fi

  # Convert ISO 8601 to epoch for age comparison
  expired_epoch=$(date -d "$expired_at" +%s 2>/dev/null || echo "0")
  if [ "$expired_epoch" -eq 0 ]; then
    echo "WARN: Cannot parse timestamp '$expired_at' for $(jq -r '.id' "$f"), skipping"
    continue
  fi

  age=$((now_epoch - expired_epoch))
  if [ "$age" -lt "$RETENTION_SECONDS" ]; then
    continue  # Not old enough to clean up
  fi

  chat_id=$(jq -r '.id' "$f")
  echo "INFO: Cleaning up chat $chat_id (expired ${age}s ago, retention: ${RETENTION_SECONDS}s)"

  # ---- Step 2: Acquire lock before deletion ----
  exec 9>"${f}.lock"
  if ! flock -n 9 2>/dev/null; then
    echo "INFO: Chat $chat_id is locked by another process, skipping cleanup"
    exec 9>&-
    continue
  fi

  # Re-check status under lock
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "expired" ]; then
    echo "INFO: Chat $chat_id status changed to '$current_status', skipping cleanup"
    exec 9>&-
    continue
  fi

  # ---- Step 3: Delete chat file and lock file ----
  rm -f "$f"
  rm -f "${f}.lock"
  echo "OK: Cleaned up chat $chat_id"
  PROCESSED=$((PROCESSED + 1))
  exec 9>&-

  # Rate limit
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi
done

echo "INFO: Cleaned up $PROCESSED chat(s) in this run"
