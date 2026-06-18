#!/bin/sh
# docker-entrypoint.sh
# Infrastructure-layer entrypoint for Primary Node.
# 1. Protect primary process from OOM killer (Issue #4114)
# 2. Auto-configure lark-cli auth from disclaude.config.yaml (Issue #3987)
#
# Issue #4114: A runaway agent subprocess (e.g., pip source build) exhausted the
# container's memory limit, pushing the primary node into uninterruptible-sleep and
# dragging the host into swap thrash. We protect the primary process by lowering its
# oom_score_adj so the kernel prefers killing agent-spawned hogs instead.
set -e

# ---------------------------------------------------------------------------
# Step 1: Protect the primary node process from OOM killer (Issue #4114)
# ---------------------------------------------------------------------------
# Set oom_score_adj to -500 for the current process (the entrypoint/tini).
# This lowers the OOM kill priority so the kernel prefers agent-spawned
# subprocesses (compiler jobs, pip builds) as OOM victims.
#
# Range: -1000 (never kill) to +1000 (always kill first). -500 is a strong
# preference without making the process completely unkillable.
#
# Requires: the entrypoint must run as root (before USER directive in Dockerfile).
# oom_score_adj is inherited by child processes; agent subprocesses that consume
# large RSS will naturally become OOM candidates via the kernel's heuristics.
OOM_SCORE_ADJ="${OOM_SCORE_ADJ:--500}"

if [ -w /proc/self/oom_score_adj ] 2>/dev/null; then
  printf "%s" "$OOM_SCORE_ADJ" > /proc/self/oom_score_adj 2>/dev/null && \
    echo "[entrypoint] OOM score adj set to $OOM_SCORE_ADJ" || \
    echo "[entrypoint] WARNING: failed to set oom_score_adj (OOM protection disabled)"
else
  echo "[entrypoint] WARNING: /proc/self/oom_score_adj not writable — OOM protection skipped"
  echo "[entrypoint]   Hint: ensure ENTRYPOINT is set before USER in Dockerfile"
fi

# ---------------------------------------------------------------------------
# Step 2: Auto-configure lark-cli auth (Issue #3987)
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
# Step 3: Launch the application
# ---------------------------------------------------------------------------
# If running as root, drop to the non-root user (disclaude) before exec.
# This allows the entrypoint to run privileged steps (oom_score_adj) while
# the application itself runs as a non-root user.
# Uses gosu (Debian) or su-exec (Alpine) for clean privilege dropping.
RUN_USER="${DISCLAUDE_USER:-disclaude}"

if [ "$(id -u)" = "0" ] && [ -n "$RUN_USER" ]; then
  # Prefer gosu (Debian); fall back to su-exec (Alpine) for compatibility.
  if command -v gosu >/dev/null 2>&1; then
    exec gosu "$RUN_USER" tini -- "$@"
  elif command -v su-exec >/dev/null 2>&1; then
    exec su-exec "$RUN_USER" tini -- "$@"
  else
    echo "[entrypoint] WARNING: neither gosu nor su-exec found — running as root"
    exec tini -- "$@"
  fi
else
  exec tini -- "$@"
fi
