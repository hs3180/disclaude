#!/usr/bin/env bash
# schedule/dogfooding.sh — Version-aware dogfooding health check script
#
# Compares current package.json version with last tested version.
# If changed, outputs version info and runs health checks for the
# dogfooding skill to consume.
#
# Dependencies: node (required), jq (optional — node fallback available)
#
# Output: JSON with version info and health check results
#
# Exit codes:
#   0 — version changed, health checks passed (or mixed)
#   1 — fatal error (missing dependencies)
#   2 — no version change detected (skip execution)

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}"
STATE_FILE="${STATE_FILE:-$REPO_ROOT/workspace/.dogfooding-state.json}"
REPORTS_DIR="${REPORTS_DIR:-$REPO_ROOT/workspace/reports}"

# ---- jq fallback via node ----
_jq() {
  if command -v jq &>/dev/null; then
    jq "$@"
  else
    # Fallback: use node for simple JSON operations
    local filter="$1"
    shift
    node -e "
      const fs = require('fs');
      const input = fs.readFileSync('/dev/stdin', 'utf8');
      const data = JSON.parse(input);
      const result = $filter;
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result));
    " "$@"
  fi
}

# ---- Step 0: Environment check ----
if ! command -v node &>/dev/null; then
  echo "FATAL: Missing required dependency: node"
  exit 1
fi

# ---- Step 1: Version change detection ----
if [ ! -f "$REPO_ROOT/package.json" ]; then
  echo "FATAL: package.json not found at $REPO_ROOT/package.json"
  exit 1
fi

CURRENT_VERSION=$(node -e "console.log(require('$REPO_ROOT/package.json').version)")
LAST_TESTED="none"

if [ -f "$STATE_FILE" ]; then
  LAST_TESTED=$(node -e "
    try {
      const s = require('$STATE_FILE');
      console.log(s.lastTestedVersion || 'none');
    } catch { console.log('none'); }
  " 2>/dev/null || echo "none")
fi

if [ "$CURRENT_VERSION" = "$LAST_TESTED" ]; then
  echo "INFO: No version change detected ($CURRENT_VERSION). Skipping dogfooding."
  exit 2
fi

echo "INFO: Version change detected: $LAST_TESTED -> $CURRENT_VERSION"

# ---- Step 2: Health checks ----
RESULTS="{"
RESULTS+="\"versionChange\":{\"from\":\"$LAST_TESTED\",\"to\":\"$CURRENT_VERSION\"},"

# 2.1: Process health (PM2)
if command -v pm2 &>/dev/null; then
  PM2_OUTPUT=$(pm2 list --no-color 2>/dev/null || echo "pm2-error")
  if echo "$PM2_OUTPUT" | grep -q "pm2-error"; then
    RESULTS+="\"processHealth\":{\"status\":\"skip\",\"reason\":\"PM2 not running\"},"
  else
    PM2_ONLINE=$(echo "$PM2_OUTPUT" | grep -c "online" || true)
    PM2_ONLINE=${PM2_ONLINE:-0}
    PM2_STOPPED=$(echo "$PM2_OUTPUT" | grep -cE "stopped|errored" || true)
    PM2_STOPPED=${PM2_STOPPED:-0}
    RESULTS+="\"processHealth\":{\"status\":\"$([ "$PM2_STOPPED" -eq 0 ] && echo "pass" || echo "partial")\",\"online\":$PM2_ONLINE,\"stopped\":$PM2_STOPPED},"
  fi
else
  RESULTS+="\"processHealth\":{\"status\":\"skip\",\"reason\":\"PM2 not available\"},"
fi

# 2.2: Configuration integrity
if [ -f "$REPO_ROOT/disclaude.config.yaml" ] || [ -f "$REPO_ROOT/disclaude.config.yml" ]; then
  CONFIG_FILE="$REPO_ROOT/disclaude.config.yaml"
  [ -f "$CONFIG_FILE" ] || CONFIG_FILE="$REPO_ROOT/disclaude.config.yml"
  CONFIG_LINES=$(wc -l < "$CONFIG_FILE")
  RESULTS+="\"configIntegrity\":{\"status\":\"pass\",\"file\":\"$(basename "$CONFIG_FILE")\",\"lines\":$CONFIG_LINES},"
else
  RESULTS+="\"configIntegrity\":{\"status\":\"skip\",\"reason\":\"No config file found\"},"
fi

# 2.3: Recent errors in logs
if command -v pm2 &>/dev/null; then
  ERROR_COUNT=$(pm2 logs --lines 100 --nostream 2>/dev/null | grep -ci "error\|fail\|exception" || echo "0")
  RESULTS+="\"recentErrors\":{\"status\":\"$([ "$ERROR_COUNT" -le 5 ] && echo "pass" || echo "partial")\",\"count\":$ERROR_COUNT},"
else
  RESULTS+="\"recentErrors\":{\"status\":\"skip\",\"reason\":\"PM2 not available\"},"
fi

# 2.4: Skill loading
SKILL_COUNT=0
if [ -d "$REPO_ROOT/skills" ]; then
  SKILL_COUNT=$(find "$REPO_ROOT/skills" -name "SKILL.md" 2>/dev/null | wc -l)
  RESULTS+="\"skillLoading\":{\"status\":\"$([ "$SKILL_COUNT" -gt 0 ] && echo "pass" || echo "fail")\",\"count\":$SKILL_COUNT},"
else
  RESULTS+="\"skillLoading\":{\"status\":\"fail\",\"reason\":\"skills/ directory not found\",\"count\":0},"
fi

# 2.5: Schedule health
SCHEDULE_COUNT=0
if [ -d "$REPO_ROOT/schedules" ]; then
  SCHEDULE_COUNT=$(find "$REPO_ROOT/schedules" -name "*.md" 2>/dev/null | wc -l)
  RESULTS+="\"scheduleHealth\":{\"status\":\"$([ "$SCHEDULE_COUNT" -gt 0 ] && echo "pass" || echo "fail")\",\"count\":$SCHEDULE_COUNT},"
else
  RESULTS+="\"scheduleHealth\":{\"status\":\"fail\",\"reason\":\"schedules/ directory not found\",\"count\":0},"
fi

# 2.6: GitHub API connectivity
if command -v gh &>/dev/null; then
  GH_USER=$(gh api user --jq '.login' 2>/dev/null || echo "")
  # Validate that the response looks like a username (no JSON, no error messages)
  if [ -n "$GH_USER" ] && echo "$GH_USER" | grep -qE '^[a-zA-Z0-9_-]+$'; then
    RESULTS+="\"githubApi\":{\"status\":\"pass\",\"user\":\"$GH_USER\"},"
  else
    RESULTS+="\"githubApi\":{\"status\":\"partial\",\"reason\":\"gh authenticated but API call failed or returned unexpected data\"},"
  fi
else
  RESULTS+="\"githubApi\":{\"status\":\"skip\",\"reason\":\"gh CLI not available\"},"
fi

# 2.7: Dependency status
if command -v npm &>/dev/null && [ -f "$REPO_ROOT/package.json" ]; then
  OUTDATED_COUNT=$(npm outdated --json 2>/dev/null | _jq 'keys | length' 2>/dev/null || echo "unknown")
  RESULTS+="\"dependencyStatus\":{\"status\":\"check\",\"outdated\":$OUTDATED_COUNT}"
else
  RESULTS+="\"dependencyStatus\":{\"status\":\"skip\",\"reason\":\"npm not available\"}"
fi

RESULTS+="}"

echo "$RESULTS"

# ---- Step 3: Update state file ----
mkdir -p "$(dirname "$STATE_FILE")"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
node -e "
  const fs = require('fs');
  const state = { lastTestedVersion: '$CURRENT_VERSION', lastTestedAt: '$TIMESTAMP' };
  fs.writeFileSync('$STATE_FILE', JSON.stringify(state, null, 2));
"

echo "INFO: Dogfooding complete for version $CURRENT_VERSION. State updated."
