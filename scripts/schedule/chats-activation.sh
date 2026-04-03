#!/usr/bin/env bash
# schedule/chats-activation.sh — Auto-activate pending chats via lark-cli
#
# Reads all pending chats from workspace/chats/, creates groups via lark-cli,
# updates status to active. Marks expired or failed chats appropriately.
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
#
# Exit codes:
#   0 — success (or no pending chats found)
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
# Validate CHAT_MAX_PER_RUN is a positive integer
if ! [[ "$CHAT_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_MAX_PER_RUN='$CHAT_MAX_PER_RUN', falling back to 10"
  CHAT_MAX_PER_RUN=10
fi
LARK_TIMEOUT=30
MAX_RETRIES=5
PROCESSED=0

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

# ---- Step 1: List pending chats (skip expired) ----
now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
pending_files=()

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Validate JSON integrity — skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" = "pending" ]; then
    # Expiry pre-check: if expiresAt is past, mark as expired directly
    expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
    if [ -n "$expires" ]; then
      # Validate format — must be Z-suffix for reliable string comparison
      # Non-UTC timestamps skip the check (fail-open)
      if echo "$expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
        if [[ "$expires" < "$now_iso" ]]; then
          chat_id=$(jq -r '.id' "$f")
          echo "INFO: Chat $chat_id expired at $expires (skipping activation)"
          # Acquire exclusive lock before modifying file
          _exp_lock_fd=0
          exec 10>"${f}.lock"
          if flock -n 10 2>/dev/null; then
            _exp_lock_fd=10
            # Re-check status under lock (another instance may have changed it)
            current_status=$(jq -r '.status' "$f" 2>/dev/null)
            if [ "$current_status" = "pending" ]; then
              _atomic_jq_write "$f" --arg now "$now_iso" \
                '.status = "expired" | .expiredAt = $now' \
                || echo "WARN: Failed to mark chat $chat_id as expired"
            else
              echo "INFO: Chat $chat_id status changed to '$current_status', skipping expiration mark"
            fi
            exec 10>&-
          else
            echo "WARN: Chat $chat_id is locked by another process, skipping expiration mark"
          fi
          continue
        fi
      else
        chat_id=$(jq -r '.id' "$f")
        echo "WARN: Chat $chat_id has non-UTC expiresAt '$expires', skipping expiration check"
      fi
    fi
    pending_files+=("$f")
  fi
done

if [ ${#pending_files[@]} -eq 0 ]; then
  echo "INFO: No pending chats found"
  exit 0
fi

echo "INFO: Found ${#pending_files[@]} pending chat(s)"

# ---- Step 2: Activate pending chats ----
for f in "${pending_files[@]}"; do
  # Rate limit: stop after MAX per run
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi

  # ---- 2.1: Read data ----
  _chat_id=$(jq -r '.id' "$f") || { echo "WARN: Failed to read chat data from $f, skipping"; continue; }
  group_name=$(jq -r '.createGroup.name' "$f")
  members=$(jq -r '.createGroup.members | join(",")' "$f")
  attempts=$(jq -r '.activationAttempts // 0' "$f")

  # ---- 2.1.1: Input validation (prevent shell injection) ----
  # Validate group_name: whitelist safe chars, character-level truncation
  if ! echo "$group_name" | grep -qE '^[a-zA-Z0-9_\-\.\#\:/\ \(\)（）【】]+$'; then
    echo "ERROR: Invalid group name '$group_name' for chat $_chat_id — contains unsafe characters, skipping"
    continue
  fi
  group_name=$(echo "$group_name" | cut -c 1-64)

  # Validate members: non-empty and each must be ou_xxxxx format
  if [ -z "$members" ]; then
    echo "ERROR: No members found for chat $_chat_id, skipping"
    continue
  fi
  skip_chat=false
  for member in $(echo "$members" | tr ',' ' '); do
    if ! echo "$member" | grep -qE '^ou_[a-zA-Z0-9]+$'; then
      echo "ERROR: Invalid member ID '$member' for chat $_chat_id — expected ou_xxxxx format, skipping"
      skip_chat=true
      break
    fi
  done
  if [ "$skip_chat" = true ]; then
    continue
  fi

  # ---- 2.2: flock for concurrency safety ----
  exec 9>"${f}.lock"
  if ! flock -n 9; then
    echo "INFO: Chat $_chat_id is being processed by another instance, skipping"
    exec 9>&-
    continue
  fi

  # Re-check status under lock (another instance may have changed it)
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "pending" ]; then
    echo "INFO: Chat $_chat_id status changed to '$current_status', skipping"
    exec 9>&-
    continue
  fi

  # Idempotent recovery: if chatId already exists, recover to active
  existing_chat_id=$(jq -r '.chatId // empty' "$f")
  if [ -n "$existing_chat_id" ]; then
    echo "INFO: Chat $_chat_id already has chatId=$existing_chat_id, recovering to active"
    now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    _atomic_jq_write "$f" --arg now "$now" \
      '.status = "active" | .activatedAt = $now' \
      || echo "WARN: Failed to recover chat $_chat_id to active"
    exec 9>&-
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  # ---- 2.3: Create group via lark-cli (with timeout protection) ----
  tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
  trap 'rm -f "$tmp_err"' EXIT

  result=$(timeout "$LARK_TIMEOUT" lark-cli im +chat-create \
    --name "$group_name" \
    --users "$members" 2>"$tmp_err") || true
  exit_code=$?

  error_msg=""
  if [ $exit_code -ne 0 ]; then
    if [ $exit_code -eq 124 ]; then
      error_msg="lark-cli timed out after ${LARK_TIMEOUT}s"
    else
      error_msg=$(cat "$tmp_err" 2>/dev/null | head -20)
    fi
    echo "ERROR: lark-cli exited with code $exit_code: $error_msg"
  fi
  rm -f "$tmp_err"
  trap - EXIT

  chat_id=$(echo "$result" | jq -r '.data.chat_id // empty' 2>/dev/null)

  # ---- 2.4: Handle creation result ----
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  new_attempts=$((attempts + 1))

  if [ -n "$chat_id" ]; then
    # Success — update to active
    _atomic_jq_write "$f" \
      --arg chat_id "$chat_id" \
      --arg now "$now" \
      '.status = "active" |
       .chatId = $chat_id |
       .activatedAt = $now |
       .activationAttempts = 0 |
       .lastActivationError = null' \
      || echo "WARN: Failed to update chat $_chat_id to active (chatId=$chat_id)"
    echo "OK: Chat $_chat_id activated (chatId=$chat_id)"
    PROCESSED=$((PROCESSED + 1))
  else
    # Failure — record error and check retry limit
    error_msg=${error_msg:-$(echo "$result" | head -20)}
    # Escape newlines to prevent breaking jq JSON output
    error_msg=$(echo "$error_msg" | tr '\n' ' ' | sed 's/  */ /g')
    echo "ERROR: Failed to create group for chat $_chat_id (attempt $new_attempts/$MAX_RETRIES)"
    echo "  $error_msg"

    if [ "$new_attempts" -ge "$MAX_RETRIES" ]; then
      echo "WARN: Chat $_chat_id reached max retries ($MAX_RETRIES), marking as failed"
      _atomic_jq_write "$f" \
        --arg now "$now" \
        --arg error "$error_msg" \
        '.status = "failed" |
         .activationAttempts = $new_attempts |
         .lastActivationError = $error |
         .failedAt = $now' \
        || echo "WARN: Failed to mark chat $_chat_id as failed"
      echo "WARN: Chat '$_chat_id' activation failed after $MAX_RETRIES retries: $error_msg"
    else
      _atomic_jq_write "$f" \
        --arg now "$now" \
        --arg error "$error_msg" \
        '.activationAttempts = $new_attempts |
         .lastActivationError = $error' \
        || echo "WARN: Failed to update retry count for chat $_chat_id"
    fi
    PROCESSED=$((PROCESSED + 1))
  fi

  # Release file lock
  exec 9>&-
done

echo "INFO: Processed $PROCESSED chat(s) in this run"
