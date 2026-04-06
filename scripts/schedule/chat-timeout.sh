#!/usr/bin/env bash
# schedule/chat-timeout.sh — Detect expired active chats, dissolve groups, and clean up.
#
# Reads all active chats from workspace/chats/, checks if expiresAt has passed,
# dissolves the group via lark-cli (if no user response), and marks as expired.
# Also cleans up expired chat files past the retention period.
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN              Max chats to process per execution (default: 10)
#   CHAT_EXPIRED_RETENTION_HOURS  Hours to retain expired files before cleanup (default: 1)
#
# Exit codes:
#   0 — success (or no expired chats found)
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
CHAT_EXPIRED_RETENTION_HOURS="${CHAT_EXPIRED_RETENTION_HOURS:-1}"
LARK_TIMEOUT=30
PROCESSED=0
CLEANED_UP=0

# Validate CHAT_MAX_PER_RUN
if ! [[ "$CHAT_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_MAX_PER_RUN='$CHAT_MAX_PER_RUN', falling back to 10"
  CHAT_MAX_PER_RUN=10
fi

# Validate CHAT_EXPIRED_RETENTION_HOURS
if ! [[ "$CHAT_EXPIRED_RETENTION_HOURS" =~ ^[0-9]+$ ]] || [ "$CHAT_EXPIRED_RETENTION_HOURS" -eq 0 ]; then
  echo "WARN: Invalid CHAT_EXPIRED_RETENTION_HOURS='$CHAT_EXPIRED_RETENTION_HOURS', falling back to 1"
  CHAT_EXPIRED_RETENTION_HOURS=1
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

if [ ! -d "$CHAT_DIR" ]; then
  echo "INFO: No chats directory found"
  exit 0
fi

now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Calculate retention cutoff: now - retention hours
# Uses date arithmetic (GNU date required)
retention_cutoff=$(date -u -d "$now_iso - ${CHAT_EXPIRED_RETENTION_HOURS} hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
  date -u -v-${CHAT_EXPIRED_RETENTION_HOURS}H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
  echo "$now_iso")

# ---- Step 1: Find expired active chats and cleanup candidates ----
expired_files=()
cleanup_files=()

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Validate JSON integrity
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)

  if [ "$status" = "active" ]; then
    expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
    if [ -n "$expires" ]; then
      if echo "$expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
        if [[ "$expires" < "$now_iso" ]]; then
          expired_files+=("$f")
        fi
      fi
    fi
  elif [ "$status" = "expired" ]; then
    # Check if past retention period
    expired_at=$(jq -r '.expiredAt // empty' "$f" 2>/dev/null)
    ref_time="${expired_at:-$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)}"
    if [ -n "$ref_time" ]; then
      if echo "$ref_time" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
        if [[ "$ref_time" < "$retention_cutoff" ]]; then
          cleanup_files+=("$f")
        fi
      fi
    fi
  fi
done

if [ ${#expired_files[@]} -eq 0 ] && [ ${#cleanup_files[@]} -eq 0 ]; then
  echo "INFO: No expired chats found"
  exit 0
fi

echo "INFO: Found ${#expired_files[@]} expired active chat(s), ${#cleanup_files[@]} cleanup candidate(s)"

# ---- Step 2: Process expired active chats ----
for f in "${expired_files[@]}"; do
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi

  _chat_id=$(jq -r '.id' "$f") || { echo "WARN: Failed to read chat data from $f, skipping"; continue; }
  has_response=$(jq -r '.response // empty' "$f" 2>/dev/null)
  chat_group_id=$(jq -r '.chatId // empty' "$f" 2>/dev/null)

  # Acquire exclusive lock
  exec 9>"${f}.lock"
  if ! flock -n 9; then
    echo "INFO: Chat $_chat_id is locked by another process, skipping"
    exec 9>&-
    continue
  fi

  # Re-read under lock
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "active" ]; then
    echo "INFO: Chat $_chat_id status changed to '$current_status', skipping"
    exec 9>&-
    continue
  fi

  # Double-check expiry
  current_expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
  if ! echo "$current_expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || [[ "$current_expires" >= "$now_iso" ]]; then
    echo "INFO: Chat $_chat_id is no longer expired, skipping"
    exec 9>&-
    continue
  fi

  # Dissolve group only if no user response
  current_response=$(jq -r '.response // empty' "$f" 2>/dev/null)
  current_chat_id=$(jq -r '.chatId // empty' "$f" 2>/dev/null)

  if [ -z "$current_response" ] && [ -n "$current_chat_id" ]; then
    echo "INFO: Chat $_chat_id has no response, dissolving group $current_chat_id"
    tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
    result=$(timeout "$LARK_TIMEOUT" lark-cli api DELETE "/open-apis/im/v1/chats/$current_chat_id" 2>"$tmp_err") || true
    exit_code=$?
    rm -f "$tmp_err"

    if [ $exit_code -ne 0 ]; then
      echo "WARN: Failed to dissolve group $current_chat_id for chat $_chat_id (exit code: $exit_code)"
    else
      echo "OK: Dissolved group $current_chat_id for chat $_chat_id"
    fi
  elif [ -n "$current_response" ]; then
    echo "INFO: Chat $_chat_id has user response, skipping group dissolution"
  fi

  # Update status to expired
  _atomic_jq_write "$f" --arg now "$now_iso" \
    '.status = "expired" | .expiredAt = $now' \
    || echo "WARN: Failed to mark chat $_chat_id as expired"
  echo "OK: Chat $_chat_id marked as expired"
  PROCESSED=$((PROCESSED + 1))

  # Release file lock
  exec 9>&-
done

# ---- Step 3: Clean up old expired files ----
for f in "${cleanup_files[@]}"; do
  # Verify still expired before deleting
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "expired" ]; then
    _id=$(jq -r '.id' "$f" 2>/dev/null)
    echo "INFO: Chat $_id is no longer expired, skipping cleanup"
    continue
  fi

  rm -f "$f"
  echo "OK: Cleaned up expired chat file: $f"
  CLEANED_UP=$((CLEANED_UP + 1))
done

echo "INFO: Processed $PROCESSED expired chat(s), cleaned up $CLEANED_UP file(s)"
