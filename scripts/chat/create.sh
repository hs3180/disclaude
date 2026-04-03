#!/usr/bin/env bash
# chat/create.sh — Create a pending chat file
#
# Environment variables:
#   CHAT_ID         (required) Unique chat identifier (e.g. "pr-123")
#   CHAT_EXPIRES_AT (required) ISO 8601 Z-suffix expiry timestamp
#   CHAT_GROUP_NAME (required) Group display name
#   CHAT_MEMBERS    (required) JSON array of member open IDs (e.g. '["ou_xxx","ou_yyy"]')
#   CHAT_CONTEXT    (optional) JSON object for consumer use (default: '{}')
#
# Exit codes:
#   0 — success
#   1 — validation error or write failure

set -euo pipefail

# ---- Step 1: Validate chat ID (path traversal protection) ----
if [ -z "${CHAT_ID:-}" ]; then
  echo "ERROR: CHAT_ID environment variable is required"
  exit 1
fi

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

# ---- Step 2: Validate required fields ----
if [ -z "${CHAT_EXPIRES_AT:-}" ]; then
  echo "ERROR: CHAT_EXPIRES_AT environment variable is required"
  exit 1
fi

# expiresAt must be Z-suffix ISO 8601 for reliable string comparison
if ! echo "$CHAT_EXPIRES_AT" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$'; then
  echo "ERROR: CHAT_EXPIRES_AT must be UTC Z-suffix format (e.g. 2026-03-25T10:00:00Z), got '$CHAT_EXPIRES_AT'"
  exit 1
fi

# expiresAt should be in the future (warn only, don't block)
now_iso=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
if [[ "$CHAT_EXPIRES_AT" < "$now_iso" ]]; then
  echo "WARN: CHAT_EXPIRES_AT '$CHAT_EXPIRES_AT' is already in the past (now: $now_iso)"
fi

if [ -z "${CHAT_GROUP_NAME:-}" ]; then
  echo "ERROR: CHAT_GROUP_NAME environment variable is required"
  exit 1
fi

if [ -z "${CHAT_MEMBERS:-}" ]; then
  echo "ERROR: CHAT_MEMBERS environment variable is required"
  exit 1
fi

CHAT_CONTEXT="${CHAT_CONTEXT:-{}}"

# Validate CHAT_CONTEXT is valid JSON
echo "$CHAT_CONTEXT" | jq empty 2>/dev/null || {
  echo "ERROR: CHAT_CONTEXT must be valid JSON, got '$CHAT_CONTEXT'"
  exit 1
}

# Validate CHAT_CONTEXT size limit (prevent oversized chat files)
CHAT_CONTEXT_SIZE=$(echo "$CHAT_CONTEXT" | jq -r '. | tostring | length' 2>/dev/null || echo "0")
if [ "$CHAT_CONTEXT_SIZE" -gt 4096 ]; then
  echo "ERROR: CHAT_CONTEXT too large ($CHAT_CONTEXT_SIZE bytes, max 4096)"
  exit 1
fi

# ---- Step 3: Validate group name (prevent shell injection) ----
if ! echo "$CHAT_GROUP_NAME" | grep -qE '^[a-zA-Z0-9_\-\.\#\:/\ \(\)（）【】]+$'; then
  echo "ERROR: Invalid group name '$CHAT_GROUP_NAME' — contains unsafe characters"
  exit 1
fi
# Character-level truncation (avoid UTF-8 multi-byte corruption)
CHAT_GROUP_NAME=$(echo "$CHAT_GROUP_NAME" | cut -c 1-64)

# ---- Step 4: Validate members format (each must be ou_xxxxx) ----
MEMBER_COUNT=$(echo "$CHAT_MEMBERS" | jq 'length' 2>/dev/null)
if [ -z "$MEMBER_COUNT" ] || [ "$MEMBER_COUNT" -eq 0 ]; then
  echo "ERROR: CHAT_MEMBERS must be a non-empty JSON array of open IDs"
  exit 1
fi

_i=0
while [ "$_i" -lt "$MEMBER_COUNT" ]; do
  _member=$(echo "$CHAT_MEMBERS" | jq -r ".[$_i]" 2>/dev/null)
  if ! echo "$_member" | grep -qE '^ou_[a-zA-Z0-9]+$'; then
    echo "ERROR: Invalid member ID '$_member' — expected ou_xxxxx format"
    exit 1
  fi
  _i=$((_i + 1))
done

# ---- Step 5: Check uniqueness (TOCTOU-safe with flock) ----
mkdir -p workspace/chats
exec 9>"${CHAT_FILE}.lock"
if ! flock -n 9; then
  echo "ERROR: Chat $CHAT_ID is being created by another process"
  exit 1
fi

if [ -f "$CHAT_FILE" ]; then
  echo "ERROR: Chat $CHAT_ID already exists"
  exec 9>&-
  exit 1
fi

# ---- Step 6: Write chat file (atomic write via mktemp + mv) ----
tmpfile=$(mktemp "${CHAT_FILE}.XXXXXX")
cat > "$tmpfile" << ENDJSON
{
  "id": "$CHAT_ID",
  "status": "pending",
  "chatId": null,
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "activatedAt": null,
  "expiresAt": "$CHAT_EXPIRES_AT",
  "createGroup": {
    "name": "$CHAT_GROUP_NAME",
    "members": $CHAT_MEMBERS
  },
  "context": $CHAT_CONTEXT,
  "response": null,
  "activationAttempts": 0,
  "lastActivationError": null,
  "failedAt": null
}
ENDJSON
mv "$tmpfile" "$CHAT_FILE"
exec 9>&-

echo "OK: Chat $CHAT_ID created successfully"
