#!/usr/bin/env bash
# chat/timeout.sh — Detect and expire timed-out active chats, dissolve groups via lark-cli
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
#   CHAT_DRY_RUN      Set to 1 to preview changes without executing (default: 0)
#
# Exit codes:
#   0 — success (or no timed-out chats found)
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
CHAT_DRY_RUN="${CHAT_DRY_RUN:-0}"

# Validate CHAT_MAX_PER_RUN is a positive integer
if ! [[ "$CHAT_MAX_PER_RUN" =~ ^[0-9]+$ ]] || [ "$CHAT_MAX_PER_RUN" -eq 0 ]; then
  echo "WARN: Invalid CHAT_MAX_PER_RUN='$CHAT_MAX_PER_RUN', falling back to 10"
  CHAT_MAX_PER_RUN=10
fi

LARK_TIMEOUT=30
PROCESSED=0
EXPIRED=0
SKIPPED=0
FAILED=0

# ---- Step 0: Environment check (fail-fast) ----
_missing_deps=()

which jq 2>/dev/null || _missing_deps+=("jq")
which flock 2>/dev/null || _missing_deps+=("flock (Linux-only, see docs)")
which lark-cli 2>/dev/null || _missing_deps+=("lark-cli")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

CHAT_DIR=$(cd workspace/chats 2>/dev/null && pwd) || {
  echo "INFO: No chats directory found"
  exit 0
}

# ---- Step 1: List active chats ----
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
  exit 0
fi

echo "INFO: Found ${#active_files[@]} active chat(s)"

# ---- Step 2: Process active chats ----
for f in "${active_files[@]}"; do
  # Rate limit: stop after MAX per run
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi

  # ---- 2.1: Read data ----
  chat_id=$(jq -r '.id' "$f" 2>/dev/null) || { echo "WARN: Failed to read chat data from $f, skipping"; continue; }
  expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
  chat_id_value=$(jq -r '.chatId // empty' "$f" 2>/dev/null)
  has_response=$(jq -r '.response // null' "$f" 2>/dev/null)

  # ---- 2.2: Check timeout ----
  # Validate format — must be Z-suffix for reliable string comparison
  if [ -z "$expires" ]; then
    echo "WARN: Chat $chat_id has no expiresAt, skipping"
    continue
  fi

  if ! echo "$expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    echo "WARN: Chat $chat_id has non-UTC expiresAt '$expires', skipping timeout check"
    SKIPPED=$((SKIPPED + 1))
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  if [[ "$expires" > "$now_iso" ]]; then
    echo "INFO: Chat $chat_id not yet expired (expires: $expires)"
    SKIPPED=$((SKIPPED + 1))
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  # Chat is expired
  echo "INFO: Chat $chat_id expired at $expires"

  # Check for user response
  if [ "$has_response" != "null" ]; then
    echo "  → Marked as expired (group preserved — user responded)"
    if [ "$CHAT_DRY_RUN" != "1" ]; then
      # Acquire lock and mark as expired (no group dissolution)
      exec 9>"${f}.lock"
      if flock -n 9 2>/dev/null; then
        # Re-check status under lock
        current_status=$(jq -r '.status' "$f" 2>/dev/null)
        if [ "$current_status" = "active" ]; then
          _atomic_jq_write "$f" --arg now "$now_iso" \
            '.status = "expired" | .expiredAt = $now' \
            || { echo "WARN: Failed to mark chat $chat_id as expired"; FAILED=$((FAILED + 1)); exec 9>&-; PROCESSED=$((PROCESSED + 1)); continue; }
        else
          echo "  → Status changed to '$current_status', skipping"
          exec 9>&-
          SKIPPED=$((SKIPPED + 1))
          PROCESSED=$((PROCESSED + 1))
          continue
        fi
        exec 9>&-
      else
        echo "WARN: Chat $chat_id is locked by another process, skipping"
        SKIPPED=$((SKIPPED + 1))
        PROCESSED=$((PROCESSED + 1))
        continue
      fi
    else
      echo "  → [DRY RUN] Would mark as expired"
    fi
    EXPIRED=$((EXPIRED + 1))
    PROCESSED=$((PROCESSED + 1))
    continue
  fi

  # ---- 2.3: Dissolve group (no response) ----
  if [ -n "$chat_id_value" ]; then
    echo "  → Dissolving group $chat_id_value..."
    if [ "$CHAT_DRY_RUN" != "1" ]; then
      tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
      result=$(timeout "$LARK_TIMEOUT" lark-cli api DELETE "/open-apis/im/v1/chats/${chat_id_value}" 2>"$tmp_err") || true
      exit_code=$?

      if [ $exit_code -eq 0 ]; then
        echo "  → Group dissolved successfully"
      elif [ $exit_code -eq 124 ]; then
        echo "WARN: lark-cli timed out after ${LARK_TIMEOUT}s (chat $chat_id)"
      else
        error_msg=$(cat "$tmp_err" 2>/dev/null | head -10)
        echo "WARN: Failed to dissolve group (exit code $exit_code): $error_msg"
      fi
      rm -f "$tmp_err"
    else
      echo "  → [DRY RUN] Would dissolve group $chat_id_value"
    fi
  else
    echo "  → No chatId found, skipping group dissolution"
  fi

  # ---- 2.4: Mark as expired ----
  if [ "$CHAT_DRY_RUN" != "1" ]; then
    exec 9>"${f}.lock"
    if flock -n 9 2>/dev/null; then
      # Re-check status under lock
      current_status=$(jq -r '.status' "$f" 2>/dev/null)
      if [ "$current_status" = "active" ]; then
        _atomic_jq_write "$f" --arg now "$now_iso" \
          '.status = "expired" | .expiredAt = $now' \
          || { echo "WARN: Failed to mark chat $chat_id as expired"; FAILED=$((FAILED + 1)); exec 9>&-; PROCESSED=$((PROCESSED + 1)); continue; }
      else
        echo "  → Status changed to '$current_status', skipping expiration mark"
        exec 9>&-
        SKIPPED=$((SKIPPED + 1))
        PROCESSED=$((PROCESSED + 1))
        continue
      fi
      exec 9>&-
    else
      echo "WARN: Chat $chat_id is locked by another process, skipping"
      SKIPPED=$((SKIPPED + 1))
      PROCESSED=$((PROCESSED + 1))
      continue
    fi
  else
    echo "  → [DRY RUN] Would mark as expired"
  fi

  EXPIRED=$((EXPIRED + 1))
  PROCESSED=$((PROCESSED + 1))
done

echo "INFO: Processed $PROCESSED chat(s) — expired: $EXPIRED, skipped: $SKIPPED, failed: $FAILED"
