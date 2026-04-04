#!/usr/bin/env bash
# research/finalize.sh — Finalize a research project
#
# Marks the research as completed (or cancelled) and optionally records
# the final report path.
#
# Environment variables:
#   RESEARCH_TOPIC (required) Research topic identifier
#   RESEARCH_STATUS (required) Final status: completed|cancelled
#   RESEARCH_REPORT_PATH (optional) Path to the final report file
#
# Exit codes:
#   0 — success
#   1 — validation error or write failure

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

if [ -z "${RESEARCH_STATUS:-}" ]; then
  echo "ERROR: RESEARCH_STATUS environment variable is required"
  exit 1
fi

# Validate topic format
if ! echo "$RESEARCH_TOPIC" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
  echo "ERROR: Invalid research topic '$RESEARCH_TOPIC'"
  exit 1
fi

# Validate final status
if [ "$RESEARCH_STATUS" != "completed" ] && [ "$RESEARCH_STATUS" != "cancelled" ]; then
  echo "ERROR: RESEARCH_STATUS must be 'completed' or 'cancelled', got '$RESEARCH_STATUS'"
  exit 1
fi

# ---- Step 2: Locate and validate state file ----
BASE_DIR=$(cd workspace/research 2>/dev/null && pwd || (mkdir -p workspace/research && cd workspace/research && pwd))
# Use string concatenation instead of realpath -m (not available on Alpine/BusyBox)
RESEARCH_DIR="${BASE_DIR}/${RESEARCH_TOPIC}"
STATE_FILE="${RESEARCH_DIR}/state.json"

# Path traversal check
if [[ "$RESEARCH_DIR" != "${BASE_DIR}/"* ]]; then
  echo "ERROR: Path traversal detected for topic '$RESEARCH_TOPIC'"
  exit 1
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' not found (no state.json at $STATE_FILE)"
  exit 1
fi

# Validate existing state is valid JSON
jq empty "$STATE_FILE" 2>/dev/null || {
  echo "ERROR: State file '$STATE_FILE' is not valid JSON"
  exit 1
}

# Check current status
current_status=$(jq -r '.status' "$STATE_FILE" 2>/dev/null)
if [ "$current_status" = "completed" ] || [ "$current_status" = "cancelled" ]; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' is already '$current_status', cannot finalize again"
  exit 1
fi

# ---- Step 3: Acquire lock ----
exec 9>"${STATE_FILE}.lock"
if ! flock -n 9; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' is being modified by another process"
  exit 1
fi

# ---- Step 4: Finalize state ----
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
REPORT_PATH="${RESEARCH_REPORT_PATH:-null}"

tmpfile=$(mktemp "${STATE_FILE}.XXXXXX")
# shellcheck disable=SC2064
trap "rm -f '$tmpfile'" EXIT

jq --arg status "$RESEARCH_STATUS" \
   --arg ts "$NOW" \
   --arg report "$REPORT_PATH" \
   '.status = $status | .finalizedAt = $ts | .updatedAt = $ts | .reportPath = (if $report == "null" then null else $report end)' \
   "$STATE_FILE" > "$tmpfile"

mv "$tmpfile" "$STATE_FILE"
trap - EXIT
exec 9>&-

# ---- Step 5: Output summary ----
total_findings=$(jq '.findings | length' "$STATE_FILE")
total_progress=$(jq '.progress | length' "$STATE_FILE")
total_interactions=$(jq '.userInteractions | length' "$STATE_FILE")
outline_version=$(jq -r '.outlineVersion' "$STATE_FILE")

echo "OK: Research project '$RESEARCH_TOPIC' finalized as '$RESEARCH_STATUS'"
echo "  Outline versions: $outline_version"
echo "  Areas completed: $total_progress"
echo "  Findings recorded: $total_findings"
echo "  User interactions: $total_interactions"
if [ "$REPORT_PATH" != "null" ]; then
  echo "  Report: $REPORT_PATH"
fi
