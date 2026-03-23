#!/usr/bin/env bash
# create-group.sh - Create a Feishu group chat
#
# Usage:
#   ./create-group.sh --name "Group Name" [--members "ou_xxx,ou_yyy"] [--config /path/to/disclaude.config.yaml]
#
# Output (JSON):
#   {"success": true, "chatId": "oc_xxx", "name": "Group Name"}
#   {"success": false, "error": "Error message"}
#
# Authentication:
#   Credentials are resolved in order:
#   1. Environment variables: FEISHU_APP_ID, FEISHU_APP_SECRET
#   2. Config file: feishu.appId, feishu.appSecret (YAML)
#   3. Environment variables: FEISHU_APP_ID_FILE, FEISHU_APP_SECRET_FILE (file paths)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FEISHU_API_BASE="${FEISHU_API_BASE:-https://open.feishu.cn}"
CONFIG_FILE=""

# Parse arguments
GROUP_NAME=""
MEMBERS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      GROUP_NAME="$2"
      shift 2
      ;;
    --members)
      MEMBERS="$2"
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

if [[ -z "$GROUP_NAME" ]]; then
  echo '{"success": false, "error": "Missing required argument: --name"}'
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
    # Try default locations
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

  # Extract appId and appSecret from YAML (simple grep, no yaml parser needed)
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

# Build member list JSON array
MEMBERS_JSON="[]"
if [[ -n "$MEMBERS" ]]; then
  IFS=',' read -ra MEMBER_ARRAY <<< "$MEMBERS"
  MEMBERS_JSON="$(printf '%s\n' "${MEMBER_ARRAY[@]}" | jq -R . | jq -s .)"
fi

# Create group
CREATE_RESPONSE="$(curl -s -X POST "${FEISHU_API_BASE}/open-apis/im/v1/chats" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TENANT_TOKEN}" \
  -d "{\"name\":\"${GROUP_NAME}\",\"chat_mode\":\"group\",\"chat_type\":\"group\",\"user_id_list\":${MEMBERS_JSON}}" 2>/dev/null)"

CHAT_ID="$(echo "$CREATE_RESPONSE" | grep -o '"chat_id":"[^"]*"' | head -1 | sed 's/"chat_id":"//;s/"//')"

if [[ -z "$CHAT_ID" ]]; then
  ERROR_MSG="$(echo "$CREATE_RESPONSE" | grep -o '"msg":"[^"]*"' | head -1 | sed 's/"msg":"//;s/"//' || echo 'Unknown error')"
  echo "{\"success\": false, \"error\": \"Failed to create group: ${ERROR_MSG}\"}"
  exit 0
fi

echo "{\"success\": true, \"chatId\": \"${CHAT_ID}\", \"name\": \"${GROUP_NAME}\"}"
