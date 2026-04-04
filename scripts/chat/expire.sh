#!/usr/bin/env bash
# chat/expire.sh — Expire timed-out active chats and dissolve their groups
#
# Scans workspace/chats/ for active chats past their expiresAt timestamp,
# marks them as expired, and attempts to dissolve the associated Feishu group
# via lark-cli. Group dissolution failure does not prevent expiration marking.
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
#
# Exit codes:
#   0 — success (or no expired chats found)
#   1 — fatal error (missing jq)

set -euo pipefail

CHAT_MAX_PER_RUN="${CHAT_MAX_PER_RUN:-10}"
LARK_TIMEOUT=30
PROCESSED=0

# ---- Step 0: Environment check (jq required; lark-cli optional) ----
_missing_deps=()

which jq 2>/dev/null || _missing_deps+=("jq")

if [ ${#_missing_deps[@]} -gt 0 ]; then
  echo "FATAL: Missing required dependencies: ${_missing_deps[*]}"
  exit 1
fi

# lark-cli is optional — if unavailable, chats are still marked expired
# but groups will NOT be dissolved
HAS_LARK_CLI=false
if which lark-cli 2>/dev/null; then
  HAS_LARK_CLI=true
else
  echo "WARN: lark-cli not available — groups will not be dissolved"
fi

mkdir -p workspace/chats
CHAT_DIR=$(cd workspace/chats && pwd)

# ---- Step 1: Scan active chats for expiration ----
now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

for f in "$CHAT_DIR"/*.json; do
  [ -f "$f" ] || continue

  # Skip corrupted files
  jq empty "$f" 2>/dev/null || { echo "WARN: Skipping corrupted file: $f"; continue; }

  # Only process active chats
  status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$status" != "active" ]; then
    continue
  fi

  # Check expiresAt
  expires=$(jq -r '.expiresAt // empty' "$f" 2>/dev/null)
  if [ -z "$expires" ]; then
    continue
  fi

  # Validate format — must be Z-suffix for reliable string comparison
  if ! echo "$expires" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
    chat_id=$(jq -r '.id' "$f")
    echo "WARN: Chat $chat_id has non-UTC expiresAt '$expires', skipping"
    continue
  fi

  # Not expired yet
  if [[ "$expires" > "$now_iso" ]]; then
    continue
  fi

  # ---- Chat is expired! ----
  chat_id=$(jq -r '.id' "$f")
  chat_id_feishu=$(jq -r '.chatId // empty' "$f")

  echo "INFO: Chat $chat_id expired at $expires (now: $now_iso)"

  # ---- Step 2: Acquire lock ----
  exec 9>"${f}.lock"
  if ! flock -n 9 2>/dev/null; then
    echo "INFO: Chat $chat_id is locked by another process, skipping"
    exec 9>&-
    continue
  fi

  # Re-check status under lock (another process may have changed it)
  current_status=$(jq -r '.status' "$f" 2>/dev/null)
  if [ "$current_status" != "active" ]; then
    echo "INFO: Chat $chat_id status changed to '$current_status', skipping"
    exec 9>&-
    continue
  fi

  # ---- Step 3: Dissolve group via lark-cli (best-effort) ----
  if [ -n "$chat_id_feishu" ] && [ "$HAS_LARK_CLI" = true ]; then
    tmp_err=$(mktemp /tmp/lark-cli-err-XXXXXX)
    timeout "$LARK_TIMEOUT" lark-cli api DELETE "/open-apis/im/v1/chats/${chat_id_feishu}" 2>"$tmp_err" || true
    lark_exit=$?

    if [ $lark_exit -ne 0 ]; then
      if [ $lark_exit -eq 124 ]; then
        echo "WARN: lark-cli timed out dissolving group for chat $chat_id (${LARK_TIMEOUT}s)"
      else
        lark_err=$(cat "$tmp_err" 2>/dev/null | head -5 | tr '\n' ' ')
        echo "WARN: Failed to dissolve group $chat_id_feishu for chat $chat_id (exit: $lark_exit): $lark_err"
      fi
      # Still mark as expired even if dissolution fails
    else
      echo "OK: Dissolved group $chat_id_feishu for chat $chat_id"
    fi
    rm -f "$tmp_err"
  elif [ -n "$chat_id_feishu" ]; then
    echo "WARN: lark-cli not available, skipping group dissolution for chat $chat_id (group $chat_id_feishu remains)"
  else
    echo "INFO: Chat $chat_id has no chatId (no group to dissolve)"
  fi

  # ---- Step 4: Update status to expired ----
  tmpfile=$(mktemp "${f}.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -f '$tmpfile'" EXIT
  jq --arg now "$now_iso" \
    '.status = "expired" | .expiredAt = $now' \
    "$f" > "$tmpfile" && mv "$tmpfile" "$f"
  trap - EXIT

  echo "OK: Chat $chat_id marked as expired"
  PROCESSED=$((PROCESSED + 1))
  exec 9>&-

  # Rate limit
  if [ "$PROCESSED" -ge "$CHAT_MAX_PER_RUN" ]; then
    echo "INFO: Reached max processing limit ($CHAT_MAX_PER_RUN), stopping"
    break
  fi
done

echo "INFO: Expired $PROCESSED chat(s) in this run"
