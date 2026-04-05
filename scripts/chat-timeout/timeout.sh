#!/usr/bin/env bash
# chat-timeout/timeout.sh — Bash wrapper for timeout.ts
#
# Detects timed-out active chats, dissolves groups via lark-cli,
# and marks them as expired.
#
# Environment variables (optional):
#   CHAT_MAX_PER_RUN  Max chats to process per execution (default: 10)
#   CHAT_DRY_RUN      If "true", report actions without executing (default: false)
#   LARK_TIMEOUT_MS   Timeout for lark-cli calls in ms (default: 30000)
#
# Exit codes:
#   0 — success
#   1 — fatal error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec npx tsx "$SCRIPT_DIR/timeout.ts" "$@"
