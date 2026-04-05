#!/usr/bin/env bash
# chat/check-deps.sh — Check and report Chat Skill dependencies
#
# Verifies that all required external tools are available and provides
# installation instructions for any missing dependencies.
#
# Exit codes:
#   0 — all dependencies satisfied
#   1 — one or more required dependencies missing

set -euo pipefail

errors=0
warnings=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m' # No Color

info()  { echo -e "  ${GREEN}✅${NC} $1: $2"; }
err()   { echo -e "  ${RED}❌${NC} $1: not found"; errors=$((errors + 1)); }
warn()  { echo -e "  ${YELLOW}⚠️${NC}  $1"; warnings=$((warnings + 1)); }

echo "Chat Skill Dependency Check"
echo "============================"

# ---- Required dependencies ----
echo ""
echo "Required:"

if command -v jq >/dev/null 2>&1; then
  info "jq" "$(command -v jq)"
else
  err "jq"
fi

if command -v flock >/dev/null 2>&1; then
  info "flock" "$(command -v flock)"
else
  err "flock"
fi

if command -v date >/dev/null 2>&1; then
  info "date" "$(command -v date)"
else
  err "date"
fi

# ---- Optional: realpath -m support ----
echo ""
echo "Optional:"

if command -v realpath >/dev/null 2>&1; then
  info "realpath" "$(command -v realpath)"
  # Check if realpath supports -m flag (GNU coreutils)
  if realpath -m /tmp/nonexistent-check-deps-$$ >/dev/null 2>&1; then
    info "realpath -m" "supported"
  else
    warn "realpath -m not supported (BusyBox?). Scripts use realpath -m for path normalization."
  fi
else
  warn "realpath" "not found. Scripts use realpath for path normalization."
fi

# ---- Summary ----
echo ""
if [ "$errors" -gt 0 ]; then
  echo -e "${RED}❌ $errors required dependencies(s) missing.${NC}"
  echo ""
  echo "Install with:"
  if ! command -v jq >/dev/null 2>&1; then
    echo "  Alpine:   apk add jq"
    echo "  Debian:   apt-get install jq"
    echo "  macOS:    brew install jq"
  fi
  if ! command -v flock >/dev/null 2>&1; then
    echo "  Alpine:   apk add util-linux"
    echo "  Debian:   apt-get install util-linux"
    echo "  macOS:    (included with macOS, from util-linux)"
  fi
  exit 1
fi

echo -e "${GREEN}✅ All required dependencies satisfied ($warnings warning(s))${NC}"
exit 0
