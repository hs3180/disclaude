#!/usr/bin/env bash
# chat-timeout/cleanup.sh — Bash wrapper for cleanup.ts
#
# Cleans up expired chat files that have passed the retention period.
#
# Environment variables (optional):
#   CHAT_RETENTION_HOURS  Hours to retain expired files (default: 1)
#   CHAT_MAX_PER_RUN      Max files to clean per execution (default: 50)
#   CHAT_DRY_RUN          If "true", report actions without executing (default: false)
#
# Exit codes:
#   0 — success
#   1 — fatal error

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

exec npx tsx "$SCRIPT_DIR/cleanup.ts" "$@"
