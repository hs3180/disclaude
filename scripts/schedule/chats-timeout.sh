#!/usr/bin/env bash
# schedule/chats-timeout.sh — Detect expired active chats, dissolve groups, clean up old files
#
# Reads all active chats from workspace/chats/, checks for expiration,
# dissolves Feishu groups via lark-cli (if no user response), updates status
# to expired, and removes expired files beyond the retention period.
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN        Max chats to process per execution (default: 10)
#   CHAT_RETENTION_SECONDS  Retention period for expired files (default: 3600 = 1 hour)
#   CHAT_DRY_RUN            If "true", log actions without executing (default: false)
#   LARK_TIMEOUT            Timeout for lark-cli API calls in seconds (default: 30)
#
# Exit codes:
#   0 — success (or no active/expired chats found)
#   1 — fatal error (missing dependencies)

set -euo pipefail

# Helper: atomic file update via jq transform with tmpfile cleanup
# Usage: _atomic_jq_write <file> <jq_args...>
_atomic_jq_write() {
  local file="$1"; shift
  local tmpfile
  tmpfile=$(mktemp "${file}.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -f '$tmpfile'" RETURN
  jq "$@" "$file" > "$tmpfile" || return 1
  mv "$tmpfile" "$file" || return 1
  trap - RETURN
}

CHAT_MAX_PER_RUN="${CHAT_MAX_PER_RUN:-10}"
CHAT_RETENTION_SECONDS="${CHAT_RETENTION_SECONDS:-3600}"
CHAT_DRY_RUN="${CHAT_DRY_RUN:-false}"
LARK_TIMEOUT="${LARK_TIMEOUT:-30}"
PROCESSED=0
DISSOLVED=0
CLEANED_UP=0

# Validate numeric inputs
if ! [[ "$CHAT_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_MAX_PER_RUN='$CHAT_MAX_PER_RUN', falling back to 10"
  CHAT_MAX_PER_RUN=10
fi
if ! [[ "$CHAT_RETENTION_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "WARN: Invalid CHAT_RETENTION_SECONDS='$CHAT_RETENTION_SECONDS', falling back to 3600"
  CHAT_RETENTION_SECONDS=3600
fi

# ---- Step 0: Environment check (fail-fast) ----
_missing_deps=()

which lark-cli 2>/dev/null || _missing_deps+=("lark-cli")
which jq 2>/dev/null || _missing_deps+=("jq")
which flock 2>/dev/null || _missing_deps+=("flock (Linux-only, see docs)")
which timeout 2>/dev/null || _missing_deps+=("timeout (Linux-only, see docs)")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

mkdir -p workspace/chats

CHAT_DIR=$(cd workspace/chats && pwd)

# ---- Step 1: List active chats that are expired ----
now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
active_files=()

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Validate JSON integrity — skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "active" ]; then
    active_files+=("$f")
  fi
done

if [ ${#active_files[@]} -eq 0 ]; then
  echo "INFO: No active chats found"
else
  echo "INFO: Found ${#active_files[@]} active chat(s)"
fi

# ---- Step 2: Process expired active chats ----
for f in "${active_files[@]}"; do
  # Rate limit: stop after MAX per run
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi

  chat_id=$(jq -r '.id' "$f") || { echo "WARN: Failed to read chat data from $f, skipping"; continue; }
  expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
  chat_chat_id=$(jq -r '.chatId // empty' "$f" 2>/dev/null)
  has_response=$(jq -r '.response // empty' "$f" 2>/dev/null)

  # ---- 2.1: Check expiration ----
  # Validate format — must be Z-suffix for reliable string comparison
  if [ -z "$expires" ]; then
    echo "WARN: Chat $chat_id has no expiresAt, skipping"
    continue
  fi

  if ! echo "$expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    echo "WARN: Chat $chat_id has non-UTC expiresAt '$expires', skipping expiration check"
    continue
  fi

  if [[ "$expires" > "$now_iso" ]]; then
    echo "INFO: Chat $chat_id expires at $expires (not expired, skipping)"
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  # Chat is expired
  echo "INFO: Chat $chat_id expired at $expires (now=$now_iso)"

  # ---- 2.2: flock for concurrency safety ----
  exec 9>"${f}.lock"
  if ! flock -n 9; then
    echo "INFO: Chat $chat_id is being processed by another instance, skipping"
    exec 9>&-
    continue
  fi

  # Re-check status under lock (another instance may have changed it)
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "active" ]; then
    echo "INFO: Chat $chat_id status changed to '$current_status', skipping"
    exec 9>&-
    continue
  fi

  # ---- 2.3: Dissolve group if no user response ----
  if [ -z "$has_response" ] && [ -n "$chat_chat_id" ]; then
    echo "INFO: Dissolving group $chat_chat_id for chat $chat_id (no response)..."

    if [ "$CHAT_DRY_RUN" = "true" ]; then
      echo "DRY RUN: Would dissolve group $chat_chat_id"
    else
      tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
      result=$(timeout "$LARK_TIMEOUT" lark-cli im +chat-delete \
        --chat-id "$chat_chat_id" 2>"$tmp_err") || true
      exit_code=$?

      if [ $exit_code -ne 0 ]; then
        if [ $exit_code -eq 124 ]; then
          echo "WARN: lark-cli timed out after ${LARK_TIMEOUT}s for chat $chat_id"
        else
          error_msg=$(cat "$tmp_err" 2>/dev/null | head -20)
          echo "WARN: Failed to dissolve group $chat_chat_id for chat $chat_id (exit $exit_code): $error_msg"
        fi
        # Still mark as expired even if dissolution fails
      else
        echo "OK: Group $chat_chat_id dissolved for chat $chat_id"
        DISSOLVED=$((DISSOLVED + 1))
      fi
      rm -f "$tmp_err"
    fi
  elif [ -n "$has_response" ]; then
    echo "INFO: Chat $chat_id has response, preserving group (no dissolution needed)"
  elif [ -z "$chat_chat_id" ]; then
    echo "INFO: Chat $chat_id has no chatId, skipping group dissolution"
  fi

  # ---- 2.4: Update status to expired ----
  if [ "$CHAT_DRY_RUN" = "true" ]; then
    echo "DRY RUN: Would mark chat $chat_id as expired"
  else
    _atomic_jq_write "$f" \
      --arg now "$now_iso" \
      '.status = "expired" | .expiredAt = $now' \
      || echo "WARN: Failed to mark chat $chat_id as expired"
    echo "OK: Chat $chat_id marked as expired"
  fi

  PROCESSED=$((PROCESSED + 1))

  # Release file lock
  exec 9>&-
done

# ---- Step 3: Clean up expired files beyond retention period ----
echo "INFO: Cleaning up expired files beyond retention (${CHAT_RETENTION_SECONDS}s)"

# Calculate the cutoff timestamp: now - retention_seconds
# Use date to compute the cutoff in ISO format for string comparison
cutoff_iso=$(date -u -d "@$(($(date +%s) - CHAT_RETENTION_SECONDS))" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
  date -u -v-"${CHAT_RETENTION_SECONDS}S" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)

if [ -z "$cutoff_iso" ]; then
  echo "WARN: Could not calculate cutoff time, skipping cleanup"
else
  for f in "$CHAT_DIR"/*.json; do
    [ -f "$f" ] || continue

    # Validate JSON integrity
    jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file during cleanup: $f"; continue; }

    status=$(jq -r '.status' "$f" 2>/dev/null)
    if [ "$status" != "expired" ]; then
      continue
    fi

    expired_at=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
    if [ -z "$expired_at" ]; then
      continue
    fi

    # Validate format
    if ! echo "$expired_at" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
      continue
    fi

    # Check if expired_at is before cutoff (file is old enough to clean up)
    if [[ "$expired_at" < "$cutoff_iso" ]]; then
      file_chat_id=$(jq -r '.id' "$f" 2>/dev/null)
      filename=$(basename "$f")

      if [ "$CHAT_DRY_RUN" = "true" ]; then
        echo "DRY RUN: Would remove $filename (chat $file_chat_id, expired at $expired_at)"
      else
        rm -f "$f"
        rm -f "${f}.lock"
        echo "INFO: Removed $filename (chat $file_chat_id, expired at $expired_at)"
        CLEANED_UP=$((CLEANED_UP + 1))
      fi
    fi
  done
fi

echo "INFO: Processed $PROCESSED chat(s), dissolved $DISSOLVED group(s), cleaned up $CLEANED_UP file(s)"
