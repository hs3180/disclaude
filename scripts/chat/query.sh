#!/usr/bin/env bash
# chat/query.sh — Query a chat's current status
#
# Environment variables:
#   CHAT_ID (required) Unique chat identifier
#
# Exit codes:
#   0 — success (chat content printed to stdout)
#   1 — validation error or chat not found

set -euo pipefail

if [ -z "${CHAT_ID:-}" ]; then
  echo "ERROR: CHAT_ID environment variable is required"
  exit 1
fi

# ---- Step 1: Validate chat ID (path traversal protection) ----
if ! echo "$CHAT_ID" | grep -qE '^[a-zA-Z0-9._-]+$'; then
  echo "ERROR: Invalid chat ID '$CHAT_ID' — only [a-zA-Z0-9._-] allowed"
  exit 1
fi

CHAT_DIR=$(cd workspace/chats && pwd)
CHAT_FILE=$(realpath -m "${CHAT_DIR}/${CHAT_ID}.json" 2>/dev/null)
if [[ "$CHAT_FILE" != "${CHAT_DIR}/"* ]]; then
  echo "ERROR: Path traversal detected for chat ID '$CHAT_ID'"
  exit 1
fi

# ---- Step 2: Validate file exists and is valid JSON ----
if [ ! -f "$CHAT_FILE" ]; then
  echo "ERROR: Chat $CHAT_ID not found"
  exit 1
fi

jq empty "$CHAT_FILE" 2>/dev/null || {
  echo "ERROR: Chat file '$CHAT_FILE' is not valid JSON"
  exit 1
}

# ---- Step 3: Read with shared lock (allows concurrent readers) ----
exec 9>"${CHAT_FILE}.lock"
flock -s 9  # shared lock — multiple readers OK, blocks writers

cat "$CHAT_FILE"

exec 9>&-
