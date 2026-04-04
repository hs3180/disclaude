#!/usr/bin/env bash
# chat/check-deps.sh — Check and report Chat Skill Bash script dependencies
#
# This script verifies that all external tools required by scripts/chat/*.sh
# are available and functional. Run this before first use on a new environment.
#
# Exit codes:
#   0 — all dependencies satisfied
#   1 — missing required dependencies
#
# Usage:
#   bash scripts/chat/check-deps.sh

set -euo pipefail

errors=0
warnings=0

# ---- Colors (optional, degraded gracefully) ----
if [ -t 1 ]; then
  GREEN='\033[0;32m'
  RED='\033[0;31m'
  YELLOW='\033[0;33m'
  NC='\033[0m'
else
  GREEN=''
  RED=''
  YELLOW=''
  NC=''
fi

ok()   { echo -e "${GREEN}OK${NC}   $1: $(command -v "$1" 2>/dev/null)"; }
fail() { echo -e "${RED}MISS${NC} $1: not found"; }
warn() { echo -e "${YELLOW}WARN${NC} $1"; }

# ---- Required dependencies ----

echo "=== Chat Skill Dependency Check ==="
echo ""

# jq — JSON processing (create.sh, query.sh, list.sh, response.sh)
if command -v jq >/dev/null 2>&1; then
  ok "jq"
else
  fail "jq"
  errors=$((errors + 1))
fi

# flock — file locking for concurrency safety (create.sh, response.sh)
if command -v flock >/dev/null 2>&1; then
  ok "flock"
else
  fail "flock"
  errors=$((errors + 1))
fi

# date — UTC timestamp generation (create.sh, response.sh)
if command -v date >/dev/null 2>&1; then
  ok "date"
  # Verify UTC support (-u flag)
  if date -u +"%Y-%m-%dT%H:%M:%SZ" >/dev/null 2>&1; then
    : # OK
  else
    warn "date: -u flag not supported"
    warnings=$((warnings + 1))
  fi
else
  fail "date"
  errors=$((errors + 1))
fi

# ---- Optional: realpath -m support check ----

echo ""
if command -v realpath >/dev/null 2>&1; then
  if realpath -m /tmp/nonexistent-test-$$ 2>/dev/null; then
    echo -e "${GREEN}OK${NC}   realpath -m: supported"
  else
    echo -e "${YELLOW}WARN${NC} realpath -m: not supported (BusyBox?) — scripts use built-in fallback"
    warnings=$((warnings + 1))
  fi
else
  echo -e "${YELLOW}WARN${NC} realpath: not found — scripts use built-in fallback"
  warnings=$((warnings + 1))
fi

# ---- Summary ----

echo ""
if [ "$errors" -gt 0 ]; then
  echo -e "${RED}FAIL${NC}  Missing $errors required dependencies"
  echo ""
  echo "Install with:"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  Alpine:  apk add jq"
    echo "  Debian:  apt-get install jq"
    echo "  macOS:   brew install jq"
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "  Alpine:  apk add util-linux"
    echo "  Debian:  apt-get install util-linux"
    echo "  macOS:   brew install util-linux"
  fi
  exit 1
fi

echo -e "${GREEN}OK${NC}   All dependencies satisfied ($warnings warning(s))"
exit 0
