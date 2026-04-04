#!/usr/bin/env bash
# research/query.sh — Query research project status
#
# Displays the current state of a research project in a human-readable format.
#
# Environment variables:
#   RESEARCH_TOPIC (required) Research topic identifier
#
# Exit codes:
#   0 — success
#   1 — validation error or project not found

set -euo pipefail

# ---- Step 0: Check dependencies ----
if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed"
  exit 1
fi

# ---- Step 1: Validate inputs ----
if [ -z "${RESEARCH_TOPIC:-}" ]; then
  echo "ERROR: RESEARCH_TOPIC environment variable is required"
  exit 1
fi

if ! echo "$RESEARCH_TOPIC" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
  echo "ERROR: Invalid research topic '$RESEARCH_TOPIC'"
  exit 1
fi

# ---- Step 2: Locate state file ----
BASE_DIR=$(cd workspace/research 2>/dev/null && pwd || echo "")
if [ -z "$BASE_DIR" ]; then
  echo "ERROR: workspace/research directory not found"
  exit 1
fi
# Use string concatenation instead of realpath -m (not available on Alpine/BusyBox)
RESEARCH_DIR="${BASE_DIR}/${RESEARCH_TOPIC}"
STATE_FILE="${RESEARCH_DIR}/state.json"

# Path traversal check
if [[ "$RESEARCH_DIR" != "${BASE_DIR}/"* ]]; then
  echo "ERROR: Path traversal detected for topic '$RESEARCH_TOPIC'"
  exit 1
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' not found"
  exit 1
fi

jq empty "$STATE_FILE" 2>/dev/null || {
  echo "ERROR: State file '$STATE_FILE' is not valid JSON"
  exit 1
}

# ---- Step 3: Display status ----
topic=$(jq -r '.topic' "$STATE_FILE")
display_type=$(jq -r '.displayType' "$STATE_FILE")
status=$(jq -r '.status' "$STATE_FILE")
brief=$(jq -r '.brief' "$STATE_FILE")
outline_version=$(jq -r '.outlineVersion' "$STATE_FILE")
created=$(jq -r '.createdAt' "$STATE_FILE")
updated=$(jq -r '.updatedAt' "$STATE_FILE")
total_findings=$(jq '.findings | length' "$STATE_FILE")
total_progress=$(jq '.progress | length' "$STATE_FILE")
total_interactions=$(jq '.userInteractions | length' "$STATE_FILE")

# Status emoji
case "$status" in
  drafting)     status_emoji="📝" ;;
  negotiating)  status_emoji="🔄" ;;
  executing)    status_emoji="⚙️" ;;
  reviewing)    status_emoji="👀" ;;
  completed)    status_emoji="✅" ;;
  cancelled)    status_emoji="❌" ;;
  *)            status_emoji="❓" ;;
esac

echo "Research: $topic"
echo "  Status: ${status_emoji} ${status}"
echo "  Type: ${display_type}"
echo "  Brief: ${brief}"
echo "  Outline: v${outline_version}"
echo "  Created: ${created}"
echo "  Updated: ${updated}"
echo "  Progress: ${total_progress} areas completed"
echo "  Findings: ${total_findings} recorded"
echo "  Interactions: ${total_interactions}"

# Show findings summary if any
if [ "$total_findings" -gt 0 ]; then
  echo ""
  echo "Findings:"
  jq -r '.findings[] | "  - [\(.area // "general")] \(.content[0:80])\(if (.content | length) > 80 then "..." else "" end) (\(.source // "no source"))"' "$STATE_FILE"
fi

# Show progress summary if any
if [ "$total_progress" -gt 0 ]; then
  echo ""
  echo "Completed Areas:"
  jq -r '.progress[] | "  - \(.area): \(.summary[0:80])\(if (.summary | length) > 80 then "..." else "" end)"' "$STATE_FILE"
fi
