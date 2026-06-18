#!/bin/sh
# docker-entrypoint.sh
# Infrastructure-layer entrypoint for Primary Node.
# Auto-configure lark-cli auth from disclaude.config.yaml (Issue #3987)
#
# This entrypoint runs AS the disclaude user (USER directive in the Dockerfile).
# OOM protection (oom_score_adj) is applied host-side via docker-compose.yml's
# `oom_score_adj` field — cgroup v2 forbids writing a negative oom_score_adj from
# inside the container, so the earlier root+gosu design (Issue #4114) could not
# achieve it and only printed a warning. With no privileged steps needed here,
# the entrypoint no longer runs as root or drops privileges, which also fixes the
# lark-cli auth regression (config now lands in the disclaude user's /app/.lark-cli
# where the app can read it, instead of /root/.lark-cli).
set -e

# ---------------------------------------------------------------------------
# Auto-configure lark-cli auth (Issue #3987)
# ---------------------------------------------------------------------------

CONFIG_FILE="${DISCLAUDE_CONFIG_PATH:-/app/disclaude.config.yaml}"

if [ -f "$CONFIG_FILE" ]; then
  # Extract feishu.appId and feishu.appSecret from YAML
  # Uses awk to isolate the feishu: section and pull out the values.
  # Handles: key: "value", key: 'value', key: value  (with optional inline comments)
  # Also handles: key:"value", key: value (mixed whitespace)
  parse_feishu_field() {
    awk '
      /^[a-zA-Z]/ { in_feishu = 0 }
      /^feishu:/ { in_feishu = 1; next }
      in_feishu && $0 ~ /^[[:space:]]+'"${1}"'[[:space:]]*:/ {
        val = $0
        sub(/^[^:]*:[[:space:]]*/, "", val)
        # Remove surrounding quotes (both single and double)
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

  if [ -n "$APP_ID" ] && [ -n "$APP_SECRET" ] && command -v lark-cli >/dev/null 2>&1; then
    # Idempotent: skip if already configured with matching appId
    CONFIG_DIR="${LARK_CLI_CONFIG_DIR:-$HOME/.lark-cli}"
    CONFIG_JSON="$CONFIG_DIR/config.json"
    SKIP_LARK_CLI=false

    if [ -f "$CONFIG_JSON" ]; then
      EXISTING_ID=$(grep -o '"appId"[[:space:]]*:[[:space:]]*"[^"]*"' "$CONFIG_JSON" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/')
      if [ "$EXISTING_ID" = "$APP_ID" ]; then
        echo "[entrypoint] lark-cli already configured with matching appId — skipping"
        SKIP_LARK_CLI=true
      fi
    fi

    if [ "$SKIP_LARK_CLI" = false ]; then
      # Run lark-cli config init
      # Capture stderr for debugging (logged on failure only).
      LARK_ERR_FILE="${TMPDIR:-/tmp}/lark-cli-init-err.$$"
      BRAND="${LARK_CLI_BRAND:-feishu}"

      if printf "%s" "$APP_SECRET" | lark-cli config init --app-id "$APP_ID" --app-secret-stdin --brand "$BRAND" 2>"$LARK_ERR_FILE"; then
        # Mask appId: show first 8 chars, or full value if shorter
        if [ ${#APP_ID} -gt 8 ]; then
          MASKED_ID="${APP_ID%%${APP_ID#????????}}..."
        else
          MASKED_ID="$APP_ID"
        fi
        echo "[entrypoint] lark-cli auth configured successfully (appId: $MASKED_ID)"
      else
        ERR_MSG=$(cat "$LARK_ERR_FILE" 2>/dev/null)
        rm -f "$LARK_ERR_FILE"
        echo "[entrypoint] WARNING: lark-cli config init failed — skills using lark-cli may not work"
        [ -n "$ERR_MSG" ] && echo "[entrypoint]   Error: $ERR_MSG"
      fi
      rm -f "$LARK_ERR_FILE" 2>/dev/null || true
    fi
  else
    echo "[entrypoint] Feishu appId/appSecret not configured or lark-cli not found — skipping auth init"
  fi
else
  echo "[entrypoint] No disclaude.config.yaml found — skipping lark-cli auth init"
fi

# ---------------------------------------------------------------------------
# Launch the application
# ---------------------------------------------------------------------------
# Run under tini as PID 1 for proper signal handling / zombie reaping.
# No privilege dropping needed — the whole container already runs as disclaude.
exec tini -- "$@"
