#!/usr/bin/env bash
# chat/check-deps.sh — Check and report Chat Skill dependencies
#
# Usage:
#   bash scripts/chat/check-deps.sh
#
# Exit codes:
#   0 — all dependencies satisfied
#   1 — missing required dependencies

set -euo pipefail

errors=0
warnings=0

# ---- Color helpers (fallback to plain text if no tty) ----
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

ok()   { printf "${GREEN}✅${NC} %s: %s\\n" "$1" "$(command -v "$1" 2>/dev/null || echo "found")"; }
fail() { printf "${RED}❌${NC} %s: not found\\n" "$1"; errors=$((errors + 1)); }
warn() { printf "${YELLOW}⚠️${NC}  %s\\n" "$1"; warnings=$((warnings + 1)); }

echo "=== Chat Skill Dependency Check ==="
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

# ---- Optional: check realpath -m support ----
if command -v realpath >/dev/null 2>&1; then
  if realpath -m /tmp/nonexistent-test-$$ >/dev/null 2>&1; then
    ok "realpath -m"
  else
    warn "realpath -m: not supported (BusyBox?). Scripts will use fallback path construction."
  fi
else
  warn "realpath: not found. Scripts will use fallback path construction."
fi

# ---- Optional: check date -u support ----
if date -u +"%Y-%m-%dT%H:%M:%SZ" >/dev/null 2>&1; then
  ok "date -u (UTC)"
else
  warn "date -u: UTC format may not work correctly"
fi

echo ""

if [ "$errors" -gt 0 ]; then
  echo "--- Installation Instructions ---"
  echo ""
  if ! command -v jq >/dev/null 2>&1; then
    echo "  jq (JSON processor):"
    echo "    Alpine:   apk add jq"
    echo "    Debian:   apt-get install jq"
    echo "    macOS:    brew install jq"
    echo "    Fedora:   dnf install jq"
    echo ""
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "  flock (file locking):"
    echo "    Alpine:   apk add util-linux"
    echo "    Debian:   apt-get install util-linux"
    echo "    macOS:    (not available — scripts will skip locking)"
    echo "    Fedora:   dnf install util-linux"
    echo ""
  fi
  printf "${RED}❌ Missing %d required dependency(ies). Please install and re-run.\\n" "$errors"
  exit 1
fi

if [ "$warnings" -gt 0 ]; then
  printf "${YELLOW}⚠️  All required dependencies satisfied (%d warning(s)).\\n" "$warnings"
else
  printf "${GREEN}✅ All dependencies satisfied.\\n"
fi

exit 0
