#!/usr/bin/env bash
# =============================================================================
# common.sh - Shared utilities for temporary-session scripts
# =============================================================================
# Provides credential parsing, Feishu API token management, and common helpers.
# All JSON operations use jq. All curl calls use --max-time.
#
# Usage: source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
#
# Shellcheck compliant (SC variables intentionally exported for callers).
# =============================================================================
set -euo pipefail

# --- Configuration ---

# Curl timeout defaults (seconds)
CURL_TIMEOUT="${CURL_TIMEOUT:-30}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-10}"

# Feishu API endpoints
readonly FEISHU_API_BASE="https://open.feishu.cn/open-apis"
readonly FEISHU_AUTH_URL="${FEISHU_API_BASE}/auth/v3/tenant_access_token/internal"
readonly FEISHU_CHAT_CREATE_URL="${FEISHU_API_BASE}/im/v1/chats"
readonly FEISHU_CHAT_DELETE_URL_TEMPLATE="${FEISHU_API_BASE}/im/v1/chats/%s"

# --- Credential Loading ---

# Load Feishu credentials from disclaude.config.yaml.
# Searches current directory, parent directories, and common locations.
# Sets FEISHU_APP_ID and FEISHU_APP_SECRET on success.
#
# Returns 0 on success, 1 if credentials not found.
load_feishu_credentials() {
  local config_file=""

  # Search for config file in common locations
  local search_paths=(
    "./disclaude.config.yaml"
    "../disclaude.config.yaml"
    "../../disclaude.config.yaml"
    "$HOME/disclaude.config.yaml"
    "${DISCLADE_CONFIG_PATH:-}"
  )

  for path in "${search_paths[@]}"; do
    if [[ -n "$path" && -f "$path" ]]; then
      config_file="$path"
      break
    fi
  done

  if [[ -z "$config_file" ]]; then
    echo "ERROR: disclaude.config.yaml not found" >&2
    return 1
  fi

  # Use yq if available for robust YAML parsing, otherwise use grep+sed for flat fields
  if command -v yq &>/dev/null; then
    FEISHU_APP_ID=$(yq '.feishu.appId // empty' "$config_file")
    FEISHU_APP_SECRET=$(yq '.feishu.appSecret // empty' "$config_file")
  else
    # Fallback: extract flat feishu.appId and feishu.appSecret from YAML
    # Only works for simple (non-nested) values
    FEISHU_APP_ID=$(grep -E '^\s+appId:' "$config_file" | head -1 | sed 's/.*appId:[[:space:]]*//' | sed 's/["'\'']//g' | xargs)
    FEISHU_APP_SECRET=$(grep -E '^\s+appSecret:' "$config_file" | head -1 | sed 's/.*appSecret:[[:space:]]*//' | sed 's/["'\'']//g' | xargs)
  fi

  # Validate credentials
  if [[ -z "$FEISHU_APP_ID" || -z "$FEISHU_APP_SECRET" ]]; then
    echo "ERROR: feishu.appId or feishu.appSecret not found in $config_file" >&2
    return 1
  fi

  if [[ ${#FEISHU_APP_ID} -lt 8 || ${#FEISHU_APP_SECRET} -lt 8 ]]; then
    echo "ERROR: Feishu credentials appear invalid (too short)" >&2
    return 1
  fi

  export FEISHU_APP_ID FEISHU_APP_SECRET
  return 0
}

# --- Token Management ---

# Get Feishu tenant_access_token from API.
# Sets FEISHU_TENANT_TOKEN on success.
#
# Returns 0 on success, 1 on failure.
get_tenant_token() {
  local response
  response=$(curl -s --max-time "$CURL_TIMEOUT" --connect-timeout "$CURL_CONNECT_TIMEOUT" \
    -X POST "$FEISHU_AUTH_URL" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg id "$FEISHU_APP_ID" --arg secret "$FEISHU_APP_SECRET" \
      '{app_id: $id, app_secret: $secret}')")

  FEISHU_TENANT_TOKEN=$(echo "$response" | jq -r '.tenant_access_token // empty')

  if [[ -z "$FEISHU_TENANT_TOKEN" ]]; then
    local code expire
    code=$(echo "$response" | jq -r '.code // "unknown"')
    expire=$(echo "$response" | jq -r '.expire // "unknown"')
    echo "ERROR: Failed to get tenant_access_token (code: $code)" >&2
    return 1
  fi

  export FEISHU_TENANT_TOKEN
  return 0
}

# Ensure we have credentials and token. Combines load_feishu_credentials + get_tenant_token.
ensure_authenticated() {
  load_feishu_credentials || return 1
  get_tenant_token || return 1
}

# --- Validation ---

# Validate Feishu chatId format (e.g., oc_xxxxxxxxxxxxxxxx).
#
# Arguments:
#   $1 - chatId to validate
# Returns 0 if valid, 1 if invalid.
validate_chat_id() {
  local chat_id="$1"
  if ! echo "$chat_id" | grep -qE '^oc_[a-zA-Z0-9]+$'; then
    echo "ERROR: Invalid chatId format: $chat_id (expected oc_ followed by alphanumeric)" >&2
    return 1
  fi
  return 0
}

# Validate session ID format (alphanumeric, hyphens, underscores).
#
# Arguments:
#   $1 - session ID to validate
# Returns 0 if valid, 1 if invalid.
validate_session_id() {
  local session_id="$1"
  if ! echo "$session_id" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9_-]*$'; then
    echo "ERROR: Invalid session ID format: $session_id" >&2
    return 1
  fi
  return 0
}

# --- Session File Helpers ---

# Get the path to the temporary-sessions directory.
# Defaults to workspace/temporary-sessions relative to the repo root.
#
# Sets SESSIONS_DIR.
get_sessions_dir() {
  local search_paths=(
    "./workspace/temporary-sessions"
    "../workspace/temporary-sessions"
    "../../workspace/temporary-sessions"
    "${TEMP_SESSIONS_DIR:-}"
  )

  for path in "${search_paths[@]}"; do
    if [[ -n "$path" && -d "$(dirname "$path")" ]]; then
      mkdir -p "$path"
      SESSIONS_DIR="$path"
      export SESSIONS_DIR
      return 0
    fi
  done

  echo "ERROR: Could not locate workspace/temporary-sessions directory" >&2
  return 1
}

# Read a session JSON file.
#
# Arguments:
#   $1 - session file path
# Outputs: JSON content to stdout
read_session() {
  local file="$1"
  if [[ ! -f "$file" ]]; then
    echo "ERROR: Session file not found: $file" >&2
    return 1
  fi
  cat "$file"
}

# Atomically update a session JSON file using jq.
# Writes to a temp file first, then renames.
#
# Arguments:
#   $1 - session file path
#   $2 - jq filter expression
# Additional arguments are passed to jq as --arg/--argjson pairs.
#   e.g., update_session file '.status = "active"' --arg chatId "oc_xxx"
update_session() {
  local file="$1"
  local filter="$2"
  shift 2

  if [[ ! -f "$file" ]]; then
    echo "ERROR: Session file not found: $file" >&2
    return 1
  fi

  local tmp_file="${file}.tmp.$$"
  jq "$filter" "$file" "$@" > "$tmp_file" && mv "$tmp_file" "$file"
}

# --- Logging ---

# Log to stderr with timestamp.
log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >&2
}

log_error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
}

log_info() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] INFO: $*" >&2
}
