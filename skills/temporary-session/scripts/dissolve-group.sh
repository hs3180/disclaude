#!/usr/bin/env bash
# dissolve-group.sh - Dissolve (delete) a Feishu group chat
#
# Usage:
#   ./dissolve-group.sh --chat-id "oc_xxx" [--config /path/to/disclaude.config.yaml]
#
# Output (JSON):
#   {"success": true, "chatId": "oc_xxx"}
#   {"success": false, "error": "Error message"}
#
# Authentication:
#   Same credential resolution order as create-group.sh:
#   1. Environment variables: FEISHU_APP_ID, FEISHU_APP_SECRET
#   2. Config file: feishu.appId, feishu.appSecret (YAML)
#   3. Environment variables: FEISHU_APP_ID_FILE, FEISHU_APP_SECRET_FILE (file paths)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_API_BASE="${FEISHU_API_BASE:-https://open.feishu.cn}"
CONFIG_FILE=""

# Parse arguments
CHAT_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --chat-id)
      CHAT_ID="$2"
      shift 2
      ;;
    --config)
      CONFIG_FILE="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$CHAT_ID" ]]; then
  echo '{"success": false, "error": "Missing required argument: --chat-id"}'
  exit 0
fi

# Resolve credentials from environment
get_creds_from_env() {
  FEISHU_APP_ID="${FEISHU_APP_ID:-}"
  FEISHU_APP_SECRET="${FEISHU_APP_SECRET:-}"

  if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]]; then
    return 0
  fi

  # Try file-based env vars
  if [[ -n "${FEISHU_APP_ID_FILE:-}" && -f "$FEISHU_APP_ID_FILE" ]]; then
    FEISHU_APP_ID="$(cat "$FEISHU_APP_ID_FILE" | tr -d '[:space:]')"
  fi
  if [[ -n "${FEISHU_APP_SECRET_FILE:-}" && -f "$FEISHU_APP_SECRET_FILE" ]]; then
    FEISHU_APP_SECRET="$(cat "$FEISHU_APP_SECRET_FILE" | tr -d '[:space:]')"
  fi

  if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]]; then
    return 0
  fi

  return 1
}

# Resolve credentials from config file
get_creds_from_config() {
  if [[ -z "$CONFIG_FILE" ]]; then
    for candidate in "disclaude.config.yaml" ".disclaude/disclaude.config.yaml"; do
      if [[ -f "$candidate" ]]; then
        CONFIG_FILE="$candidate"
        break
      fi
    done
  fi

  if [[ -z "$CONFIG_FILE" || ! -f "$CONFIG_FILE" ]]; then
    return 1
  fi

  FEISHU_APP_ID="$(grep -E '^\s*appId:' "$CONFIG_FILE" | head -1 | sed 's/.*appId:[[:space:]]*//' | tr -d '"'"'"' ' | head -c 100)"
  FEISHU_APP_SECRET="$(grep -E '^\s*appSecret:' "$CONFIG_FILE" | head -1 | sed 's/.*appSecret:[[:space:]]*//' | tr -d '"'"'"' ' | head -c 100)"

  if [[ -n "$FEISHU_APP_ID" && -n "$FEISHU_APP_SECRET" ]]; then
    return 0
  fi

  return 1
}

# Try to get credentials
if ! get_creds_from_env; then
  if ! get_creds_from_config; then
    echo '{"success": false, "error": "Unable to resolve Feishu credentials. Set FEISHU_APP_ID and FEISHU_APP_SECRET env vars, or provide --config path."}'
    exit 0
  fi
fi

# Get tenant_access_token
TOKEN_RESPONSE="$(curl -s -X POST "${FEISHU_API_BASE}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d "{\"app_id\":\"${FEISHU_APP_ID}\",\"app_secret\":\"${FEISHU_APP_SECRET}\"}" 2>/dev/null)"

TENANT_TOKEN="$(echo "$TOKEN_RESPONSE" | grep -o '"tenant_access_token":"[^"]*"' | head -1 | sed 's/"tenant_access_token":"//;s/"//')"

if [[ -z "$TENANT_TOKEN" ]]; then
  echo '{"success": false, "error": "Failed to get tenant_access_token from Feishu API"}'
  exit 0
fi

# Dissolve group
DISSOLVE_RESPONSE="$(curl -s -X DELETE "${FEISHU_API_BASE}/open-apis/im/v1/chats/${CHAT_ID}" \
  -H "Authorization: Bearer ${TENANT_TOKEN}" 2>/dev/null)"

# Check response code (Feishu returns {"code": 0} on success)
CODE="$(echo "$DISSOLVE_RESPONSE" | grep -o '"code":[0-9]*' | head -1 | sed 's/"code"://')"

if [[ "$CODE" == "0" ]]; then
  echo "{\"success\": true, \"chatId\": \"${CHAT_ID}\"}"
else
  ERROR_MSG="$(echo "$DISSOLVE_RESPONSE" | grep -o '"msg":"[^"]*"' | head -1 | sed 's/"msg":"//;s/"//' || echo 'Unknown error')"
  echo "{\"success\": false, \"error\": \"Failed to dissolve group: ${ERROR_MSG}\"}"
fi
