#!/usr/bin/env bash
# check-deps.sh — Verify Chat Skill runtime dependencies.
#
# Run this before executing any scripts/chat/*.ts scripts.
# This is a shell script (not TypeScript) because it checks whether
# the TypeScript runtime (tsx) itself is available.
#
# Exit codes:
#   0 — all dependencies satisfied
#   1 — missing or incompatible dependency
#
# Usage:
#   bash scripts/chat/check-deps.sh

set -euo pipefail

errors=0
warnings=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BOLD='\033[1m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}✅${NC} $1"; }
fail() { echo -e "  ${RED}❌${NC} $1"; errors=$((errors + 1)); }
warn() { echo -e "  ${YELLOW}⚠️${NC}  $1"; warnings=$((warnings + 1)); }

echo -e "${BOLD}Chat Skill — Dependency Check${NC}"
echo ""

# ---- 1. Node.js ----
if command -v node >/dev/null 2>&1; then
  node_version=$(node --version 2>/dev/null | sed 's/^v//')
  node_major=$(echo "$node_version" | cut -d. -f1)
  node_minor=$(echo "$node_version" | cut -d. -f2)

  if [ "$node_major" -gt 20 ] || { [ "$node_major" -eq 20 ] && [ "$node_minor" -ge 12 ]; }; then
    ok "Node.js v${node_version} (>= 20.12, fs.flock supported)"
  elif [ "$node_major" -ge 18 ]; then
    warn "Node.js v${node_version} (< 20.12) — fs.flock unavailable, file locking will be disabled"
  else
    fail "Node.js v${node_version} — requires >= 18.0.0"
  fi
else
  fail "Node.js not found — install from https://nodejs.org/"
fi

# ---- 2. tsx (TypeScript executor) ----
if command -v tsx >/dev/null 2>&1; then
  ok "tsx: $(command -v tsx)"
elif command -v npx >/dev/null 2>&1; then
  # Check if tsx is available via npx (might be a local dependency)
  if npx tsx --version >/dev/null 2>&1; then
    tsx_version=$(npx tsx --version 2>/dev/null | head -1)
    ok "tsx via npx: ${tsx_version}"
  else
    fail "tsx not found — run 'npm install' (tsx is a devDependency)"
  fi
else
  fail "npx not found — install Node.js from https://nodejs.org/"
fi

# ---- 3. npm (for installing dependencies) ----
if command -v npm >/dev/null 2>&1; then
  ok "npm: $(npm --version 2>/dev/null)"
else
  fail "npm not found — install Node.js from https://nodejs.org/"
fi

# ---- 4. workspace/chats directory ----
chat_dir="workspace/chats"
if [ -d "$chat_dir" ]; then
  ok "Chat directory: ${chat_dir}/"
elif [ -w "." ]; then
  ok "Chat directory: ${chat_dir}/ (will be created on first use)"
else
  warn "Current directory is not writable — chat file creation may fail"
fi

# ---- Summary ----
echo ""
if [ "$errors" -gt 0 ]; then
  echo -e "${RED}${BOLD}❌ ${errors} error(s) found${NC}"
  echo ""
  echo "Fix with:"
  echo "  1. Install Node.js >= 20.12: https://nodejs.org/"
  echo "  2. Install dependencies: npm install"
  echo "  3. Re-run this check: bash scripts/chat/check-deps.sh"
  exit 1
fi

if [ "$warnings" -gt 0 ]; then
  echo -e "${YELLOW}${BOLD}✅ All dependencies satisfied (${warnings} warning(s))${NC}"
else
  echo -e "${GREEN}${BOLD}✅ All dependencies satisfied${NC}"
fi
exit 0
