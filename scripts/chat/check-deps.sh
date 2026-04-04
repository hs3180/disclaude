#!/usr/bin/env bash
# chat/check-deps.sh — Check and report Chat Skill dependencies
#
# Verifies that all external tools required by the Chat Skill scripts
# (create.sh, query.sh, list.sh, response.sh) are available and functional.
#
# Exit codes:
#   0 — all required dependencies satisfied
#   1 — one or more required dependencies missing

set -euo pipefail

errors=0
warnings=0

# ---- Color output (optional, degraded gracefully) ----
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  NC='\033[0m' # No Color
else
  RED=''
  GREEN=''
  YELLOW=''
  NC=''
fi

ok()   { echo -e "${GREEN}✅ $1: $(command -v "$1" 2>/dev/null)${NC}"; }
fail() { echo -e "${RED}❌ $1: not found${NC}"; errors=$((errors + 1)); }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; warnings=$((warnings + 1)); }

echo "Chat Skill — Dependency Check"
echo "==============================="
echo ""

# ---- Required dependencies ----

if command -v jq >/dev/null 2>&1; then
  ok "jq"
else
  fail "jq"
fi

if command -v flock >/dev/null 2>&1; then
  ok "flock"
else
  fail "flock"
fi

if command -v date >/dev/null 2>&1; then
  ok "date"
else
  fail "date"
fi

if command -v realpath >/dev/null 2>&1; then
  ok "realpath"
else
  fail "realpath"
fi

echo ""

# ---- Optional: check realpath -m support ----
if command -v realpath >/dev/null 2>&1; then
  if realpath -m /tmp/nonexistent-chat-deps-test-$$ >/dev/null 2>&1; then
    echo -e "${GREEN}✅ realpath -m: supported${NC}"
  else
    warn "realpath -m: not supported (BusyBox?). Scripts will use fallback path resolution."
  fi
else
  warn "realpath -m: cannot check (realpath not available)"
fi

echo ""

# ---- Summary ----
if [ "$errors" -gt 0 ]; then
  echo -e "${RED}❌ Missing $errors required dependenc${errors:+y/ies}.${NC}"
  echo ""
  echo "Install with:"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  Alpine:   apk add jq"
    echo "  Debian:   apt-get install jq"
    echo "  macOS:    brew install jq"
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "  Alpine:   apk add util-linux  (provides flock)"
    echo "  Debian:   apt-get install util-linux"
  fi
  exit 1
fi

echo -e "${GREEN}✅ All required dependencies satisfied ($warnings warning(s))${NC}"
exit 0
