#!/usr/bin/env bash
# chat/response.sh — Record a user response to an active chat
#
# Environment variables:
#   CHAT_ID         (required) Unique chat identifier
#   CHAT_RESPONSE   (required) User's response text
#   CHAT_RESPONDER  (required) Responder's open ID (ou_xxxxx)
#
# Exit codes:
#   0 — success
#   1 — validation error or write failure

set -euo pipefail

if [ -z "${CHAT_ID:-}" ]; then
  echo "ERROR: CHAT_ID environment variable is required"
  exit 1
fi

if [ -z "${CHAT_RESPONSE:-}" ]; then
  echo "ERROR: CHAT_RESPONSE environment variable is required"
  exit 1
fi

if [ -z "${CHAT_RESPONDER:-}" ]; then
  echo "ERROR: CHAT_RESPONDER environment variable is required"
  exit 1
fi

# Validate responder format (must be ou_xxxxx, consistent with create.sh)
if ! echo "$CHAT_RESPONDER" | grep -qE '^ou_[a-zA-Z0-9]+$'; then
  echo "ERROR: Invalid responder ID '$CHAT_RESPONDER' — expected ou_xxxxx format"
  exit 1
fi

# Validate response length (prevent oversized chat files)
if [ "${#CHAT_RESPONSE}" -gt 10000 ]; then
  echo "ERROR: CHAT_RESPONSE too long (${#CHAT_RESPONSE} chars, max 10000)"
  exit 1
fi

# ---- Step 1: Validate chat ID (path traversal protection) ----
if ! echo "$CHAT_ID" | grep -qE '^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$'; then
  echo "ERROR: Invalid chat ID '$CHAT_ID' — must start with [a-zA-Z0-9_-], only [a-zA-Z0-9._-] allowed"
  exit 1
fi

CHAT_DIR=$(cd workspace/chats && pwd)
CHAT_FILE=$(realpath -m "${CHAT_DIR}/${CHAT_ID}.json" 2>/dev/null)
if [[ "$CHAT_FILE" != "${CHAT_DIR}/"* ]]; then
  echo "ERROR: Path traversal detected for chat ID '$CHAT_ID'"
  exit 1
fi

# ---- Step 2: Validate file exists, is valid JSON, and is active ----
if [ ! -f "$CHAT_FILE" ]; then
  echo "ERROR: Chat $CHAT_ID not found"
  exit 1
fi

jq empty "$CHAT_FILE" 2>/dev/null || {
  echo "ERROR: Chat file '$CHAT_FILE' is not valid JSON"
  exit 1
}

current_status=$(jq -r '.status' "$CHAT_FILE" 2>/dev/null)
if [ "$current_status" != "active" ]; then
  echo "ERROR: Chat $CHAT_ID is '$current_status', cannot update (expected 'active')"
  exit 1
fi

# ---- Step 3: Check idempotency (reject duplicate responses) ----
existing_response=$(jq -r '.response.content // empty' "$CHAT_FILE" 2>/dev/null)
if [ -n "$existing_response" ]; then
  _prev_responder=$(jq -r '.response.responder' "$CHAT_FILE" 2>/dev/null)
  _prev_time=$(jq -r '.response.repliedAt' "$CHAT_FILE" 2>/dev/null)
  echo "ERROR: Chat $CHAT_ID already has a response from $_prev_responder at $_prev_time — refusing to overwrite"
  exit 1
fi

# ---- Step 4: Acquire exclusive lock and write response ----
exec 9>"${CHAT_FILE}.lock"
if ! flock -n 9; then
  echo "ERROR: Chat $CHAT_ID is being modified by another process"
  exit 1
fi

# Double-check after acquiring lock (another process may have changed status or written a response)
current_status=$(jq -r '.status' "$CHAT_FILE" 2>/dev/null)
if [ "$current_status" != "active" ]; then
  echo "ERROR: Chat $CHAT_ID status changed to '$current_status' while waiting for lock"
  exec 9>&-
  exit 1
fi
existing_response=$(jq -r '.response.content // empty' "$CHAT_FILE" 2>/dev/null)
if [ -n "$existing_response" ]; then
  echo "ERROR: Chat $CHAT_ID already has a response — refusing to overwrite"
  exec 9>&-
  exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
tmpfile=$(mktemp "${CHAT_FILE}.XXXXXX")
jq --arg msg "$CHAT_RESPONSE" \
    --arg responder "$CHAT_RESPONDER" \
    --arg ts "$NOW" \
    '.response = {
       "content": $msg,
       "responder": $responder,
       "repliedAt": $ts
     }' "$CHAT_FILE" > "$tmpfile" \
  && mv "$tmpfile" "$CHAT_FILE"

exec 9>&-

echo "OK: Response recorded for chat $CHAT_ID"
