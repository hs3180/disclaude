#!/bin/sh
# docker-entrypoint.sh
# Auto-configure lark-cli auth from Feishu credentials in disclaude.config.yaml.
# Runs before the Node.js process starts, at the infrastructure layer.
#
# Issue #3987: Skills like dissolve-group, rename-group, lark-docs, and pr-scanner
# shell out to `lark-cli api` which requires pre-authenticated credentials.
# This script reads feishu.appId/appSecret from the mounted config file and
# runs `lark-cli config init` so those skills work out of the box.
set -e

CONFIG_FILE="${DISCLAUDE_CONFIG_PATH:-/app/disclaude.config.yaml}"

# --- Parse feishu credentials from YAML (no extra dependencies) ---
# Extract the feishu section: read lines between "^feishu:" and next top-level key
# Then extract appId and appSecret values (handles quoted and unquoted values).

if [ ! -f "$CONFIG_FILE" ]; then
  echo "[entrypoint] No disclaude.config.yaml found — skipping lark-cli auth init"
  exec tini -- "$@"
fi

# Extract feishu.appId and feishu.appSecret from YAML
# Uses awk to isolate the feishu: section and pull out the values.
# Handles: key: "value", key: 'value', key: value  (with optional inline comments)
parse_feishu_field() {
  awk '
    /^[a-zA-Z]/ { in_feishu = 0 }
    /^feishu:/ { in_feishu = 1; next }
    in_feishu && $1 == "'"$1"':" {
      val = $0
      sub(/^[^:]*:[[:space:]]*/, "", val)
      # Remove surrounding quotes
      gsub(/^["'"'"']|["'"'"']$/, "", val)
      # Remove inline comments
      sub(/[[:space:]]*#.*$/, "", val)
      print val
      exit
    }
  ' "$CONFIG_FILE"
}

APP_ID=$(parse_feishu_field "appId")
APP_SECRET=$(parse_feishu_field "appSecret")

if [ -z "$APP_ID" ] || [ -z "$APP_SECRET" ]; then
  echo "[entrypoint] Feishu appId/appSecret not configured — skipping lark-cli auth init"
  exec tini -- "$@"
fi

# --- Check if lark-cli is available ---
if ! command -v lark-cli >/dev/null 2>&1; then
  echo "[entrypoint] lark-cli binary not found — skipping auth init"
  exec tini -- "$@"
fi

# --- Idempotent: skip if already configured with matching appId ---
CONFIG_DIR="${LARK_CLI_CONFIG_DIR:-$HOME/.lark-cli}"
CONFIG_JSON="$CONFIG_DIR/config.json"

if [ -f "$CONFIG_JSON" ]; then
  EXISTING_ID=$(grep -o '"appId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_JSON" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
  if [ "$EXISTING_ID" = "$APP_ID" ]; then
    echo "[entrypoint] lark-cli already configured with matching appId — skipping"
    exec tini -- "$@"
  fi
fi

# --- Run lark-cli config init ---
printf "%s" "$APP_SECRET" | lark-cli config init --app-id "$APP_ID" --app-secret-stdin 2>/dev/null \
  && echo "[entrypoint] lark-cli auth configured successfully (appId: ${APP_ID%????????????????}...)" \
  || echo "[entrypoint] WARNING: lark-cli config init failed — skills using lark-cli may not work"

exec tini -- "$@"
