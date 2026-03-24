#!/usr/bin/env bash
# =============================================================================
# create-group.sh - Create a Feishu group chat
# =============================================================================
# Creates a Feishu group chat with the specified name and members.
# Uses jq for all JSON construction. Uses --max-time for all curl calls.
#
# Usage:
#   ./create-group.sh --name "Group Name" [--members "ou_id1,ou_id2"]
#
# Output (JSON):
#   On success: {"success": true, "chatId": "oc_xxx"}
#   On failure: {"success": false, "error": "error message"}
#
# Exit code: 0 on success, 1 on failure
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# --- Argument Parsing ---

GROUP_NAME=""
MEMBERS_CSV=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      GROUP_NAME="$2"
      shift 2
      ;;
    --members)
      MEMBERS_CSV="$2"
      shift 2
      ;;
    *)
      log_error "Unknown argument: $1"
      echo '{"success": false, "error": "Unknown argument"}'
      exit 1
      ;;
  esac
done

if [[ -z "$GROUP_NAME" ]]; then
  log_error "Missing required argument: --name"
  echo '{"success": false, "error": "Missing --name argument"}'
  exit 1
fi

# --- Build Member List ---

MEMBERS_JSON="[]"
if [[ -n "$MEMBERS_CSV" ]]; then
  # Split CSV into array and build JSON array with jq
  MEMBERS_JSON=$(echo "$MEMBERS_CSV" | tr ',' '\n' | jq -R . | jq -s '.')
fi

# --- Authenticate ---

if ! ensure_authenticated; then
  echo '{"success": false, "error": "Authentication failed"}'
  exit 1
fi

# --- Create Group ---

log_info "Creating group: $GROUP_NAME"

# Build request payload with jq (no string concatenation!)
PAYLOAD=$(jq -n \
  --arg name "$GROUP_NAME" \
  --argjson members "$MEMBERS_JSON" \
  '{
    name: $name,
    chat_mode: "group",
    chat_type: "group",
    user_id_list: $members
  }')

RESPONSE=$(curl -s --max-time "$CURL_TIMEOUT" --connect-timeout "$CURL_CONNECT_TIMEOUT" \
  -X POST "$FEISHU_CHAT_CREATE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $FEISHU_TENANT_TOKEN" \
  -d "$PAYLOAD")

# Parse response
CHAT_ID=$(echo "$RESPONSE" | jq -r '.data.chat_id // empty')
ERROR_CODE=$(echo "$RESPONSE" | jq -r '.code // "unknown"')
ERROR_MSG=$(echo "$RESPONSE" | jq -r '.msg // "unknown error"')

if [[ -z "$CHAT_ID" ]]; then
  log_error "Failed to create group (code: $ERROR_CODE, msg: $ERROR_MSG)"
  echo "{\"success\": false, \"error\": \"Failed to create group: $ERROR_MSG\"}"
  exit 1
fi

# Validate the returned chatId
if ! validate_chat_id "$CHAT_ID"; then
  log_error "Invalid chatId returned from API: $CHAT_ID"
  echo "{\"success\": false, \"error\": \"Invalid chatId returned: $CHAT_ID\"}"
  exit 1
fi

log_info "Group created: $CHAT_ID ($GROUP_NAME)"
echo "{\"success\": true, \"chatId\": \"$CHAT_ID\"}"
exit 0
