#!/usr/bin/env bash
# chat/check-deps.sh — Check and report Chat Skill dependencies
#
# Usage: bash scripts/chat/check-deps.sh
#
# Exit codes:
#   0 — all dependencies satisfied
#   1 — missing required dependency

set -euo pipefail

errors=0
warnings=0

# ---- Required commands ----
check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "✅ $1: $(command -v "$1")"
  else
    echo "❌ $1: not found"
    errors=$((errors + 1))
  fi
}

echo "Checking Chat Skill dependencies..."
echo ""

check_cmd jq
check_cmd flock
check_cmd date

# ---- Check realpath -m support (needed for create.sh, query.sh, response.sh) ----
if realpath -m /tmp/nonexistent-test-$$ >/dev/null 2>&1; then
  echo "✅ realpath -m: supported"
else
  echo "⚠️  realpath -m: not supported (BusyBox?). Will use fallback path resolution."
  warnings=$((warnings + 1))
fi

echo ""

# ---- Installation hints for missing dependencies ----
if [ "$errors" -gt 0 ]; then
  echo "❌ Missing $errors required dependenc$( [ "$errors" -gt 1 ] && echo "ies" || echo "y" ). Install with:"
  echo ""

  if ! command -v jq >/dev/null 2>&1; then
    echo "  jq (JSON processor):"
    echo "    Alpine:  apk add jq"
    echo "    Debian:  apt-get install jq"
    echo "    macOS:   brew install jq"
    echo ""
  fi

  if ! command -v flock >/dev/null 2>&1; then
    echo "  flock (file locking, Linux-only):"
    echo "    Alpine:  apk add util-linux"
    echo "    Debian:  apt-get install util-linux"
    echo "    Note: flock is not available on macOS"
    echo ""
  fi

  if ! command -v date >/dev/null 2>&1; then
    echo "  date (should be pre-installed):"
    echo "    Alpine:  apk add coreutils"
    echo "    Debian:  apt-get install coreutils"
    echo ""
  fi

  exit 1
fi

echo "✅ All dependencies satisfied ($warnings warning(s))"
exit 0
