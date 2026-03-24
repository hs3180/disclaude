#!/usr/bin/env bash
# =============================================================================
# dissolve-group.sh - Dissolve (delete) a Feishu group chat
# =============================================================================
# Dissolves a Feishu group chat by chatId.
# Validates chatId format before making API call.
# Uses --max-time for all curl calls.
#
# Usage:
#   ./dissolve-group.sh --chat-id "oc_xxx"
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

CHAT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat-id)
      CHAT_ID="$2"
      shift 2
      ;;
    *)
      log_error "Unknown argument: $1"
      echo '{"success": false, "error": "Unknown argument"}'
      exit 1
      ;;
  esac
done

if [[ -z "$CHAT_ID" ]]; then
  log_error "Missing required argument: --chat-id"
  echo '{"success": false, "error": "Missing --chat-id argument"}'
  exit 1
fi

# --- Validate chatId ---

if ! validate_chat_id "$CHAT_ID"; then
  echo "{\"success\": false, \"error\": \"Invalid chatId format: $CHAT_ID\"}"
  exit 1
fi

# --- Authenticate ---

if ! ensure_authenticated; then
  echo '{"success": false, "error": "Authentication failed"}'
  exit 1
fi

# --- Dissolve Group ---

# Build URL with validated chatId (safe since we validated format above)
DELETE_URL=$(printf "$FEISHU_CHAT_DELETE_URL_TEMPLATE" "$CHAT_ID")

log_info "Dissolving group: $CHAT_ID"

RESPONSE=$(curl -s --max-time "$CURL_TIMEOUT" --connect-timeout "$CURL_CONNECT_TIMEOUT" \
  -X DELETE "$DELETE_URL" \
  -H "Authorization: Bearer $FEISHU_TENANT_TOKEN")

# Parse response
ERROR_CODE=$(echo "$RESPONSE" | jq -r '.code // "unknown"')
ERROR_MSG=$(echo "$RESPONSE" | jq -r '.msg // "unknown error"')

# Feishu returns code 0 on success
if [[ "$ERROR_CODE" != "0" ]]; then
  log_error "Failed to dissolve group $CHAT_ID (code: $ERROR_CODE, msg: $ERROR_MSG)"
  echo "{\"success\": false, \"error\": \"Failed to dissolve group: $ERROR_MSG\"}"
  exit 1
fi

log_info "Group dissolved: $CHAT_ID"
echo "{\"success\": true, \"chatId\": \"$CHAT_ID\"}"
exit 0
