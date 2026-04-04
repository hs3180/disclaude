#!/usr/bin/env bash
# research/create.sh — Initialize a new research project
#
# Creates the research project directory structure and RESEARCH.md state file.
#
# Environment variables:
#   RESEARCH_TOPIC   (required) Research topic identifier (e.g. "react-vs-vue")
#   RESEARCH_TYPE    (required) Research type: technical_analysis|literature_review|feasibility_study|comparison|other
#   RESEARCH_BRIEF   (required) Brief description of the research goal
#   RESEARCH_OUTLINE (optional) JSON object with initial outline structure (default: '{}')
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

# ---- Step 1: Validate topic (path traversal protection) ----
if [ -z "${RESEARCH_TOPIC:-}" ]; then
  echo "ERROR: RESEARCH_TOPIC environment variable is required"
  exit 1
fi

if ! echo "$RESEARCH_TOPIC" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
  echo "ERROR: Invalid research topic '$RESEARCH_TOPIC' — must start with [a-zA-Z0-9], only [a-zA-Z0-9._-] allowed"
  exit 1
fi

# Topic length limit (prevent filesystem issues)
if [ "${#RESEARCH_TOPIC}" -gt 128 ]; then
  echo "ERROR: RESEARCH_TOPIC too long (${#RESEARCH_TOPIC} chars, max 128)"
  exit 1
fi

RESEARCH_BASE_DIR=$(cd workspace/research 2>/dev/null && pwd || (mkdir -p workspace/research && cd workspace/research && pwd))
# Use string concatenation instead of realpath -m (not available on Alpine/BusyBox)
# Path traversal is already prevented by the regex validation above
RESEARCH_DIR="${RESEARCH_BASE_DIR}/${RESEARCH_TOPIC}"
if [[ "$RESEARCH_DIR" != "${RESEARCH_BASE_DIR}/"* ]]; then
  echo "ERROR: Path traversal detected for topic '$RESEARCH_TOPIC'"
  exit 1
fi

# ---- Step 2: Validate type ----
if [ -z "${RESEARCH_TYPE:-}" ]; then
  echo "ERROR: RESEARCH_TYPE environment variable is required"
  exit 1
fi

VALID_TYPES="technical_analysis literature_review feasibility_study comparison other"
if ! echo "$VALID_TYPES" | grep -qw "$RESEARCH_TYPE"; then
  echo "ERROR: Invalid RESEARCH_TYPE '$RESEARCH_TYPE' — must be one of: $VALID_TYPES"
  exit 1
fi

# ---- Step 3: Validate brief ----
if [ -z "${RESEARCH_BRIEF:-}" ]; then
  echo "ERROR: RESEARCH_BRIEF environment variable is required"
  exit 1
fi

if [ "${#RESEARCH_BRIEF}" -gt 2000 ]; then
  echo "ERROR: RESEARCH_BRIEF too long (${#RESEARCH_BRIEF} chars, max 2000)"
  exit 1
fi

# ---- Step 4: Validate outline (optional) ----
# Use temp var to avoid bash parsing issue with {} inside ${...:-...}
_DEFAULT_OUTLINE='{}'
RESEARCH_OUTLINE="${RESEARCH_OUTLINE:-$_DEFAULT_OUTLINE}"
echo "$RESEARCH_OUTLINE" | jq empty 2>/dev/null || {
  echo "ERROR: RESEARCH_OUTLINE must be valid JSON, got '$RESEARCH_OUTLINE'"
  exit 1
}

OUTLINE_SIZE=$(echo "$RESEARCH_OUTLINE" | jq -r '. | tostring | length' 2>/dev/null || echo "0")
if [ "$OUTLINE_SIZE" -gt 16384 ]; then
  echo "ERROR: RESEARCH_OUTLINE too large ($OUTLINE_SIZE bytes, max 16384)"
  exit 1
fi

# ---- Step 5: Check uniqueness (TOCTOU-safe with flock) ----
LOCK_FILE="${RESEARCH_DIR}.lock"
mkdir -p "$(dirname "$RESEARCH_DIR")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "ERROR: Research topic '$RESEARCH_TOPIC' is being created by another process"
  exit 1
fi

if [ -d "$RESEARCH_DIR" ]; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' already exists at $RESEARCH_DIR"
  exec 9>&-
  exit 1
fi

# ---- Step 6: Create directory structure ----
mkdir -p "${RESEARCH_DIR}/findings"

# ---- Step 7: Write RESEARCH.md state file ----
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Display-friendly type name
case "$RESEARCH_TYPE" in
  technical_analysis) DISPLAY_TYPE="Technical Analysis" ;;
  literature_review)   DISPLAY_TYPE="Literature Review" ;;
  feasibility_study)   DISPLAY_TYPE="Feasibility Study" ;;
  comparison)          DISPLAY_TYPE="Comparison" ;;
  other)               DISPLAY_TYPE="Other" ;;
esac

jq -n \
  --arg topic "$RESEARCH_TOPIC" \
  --arg type "$RESEARCH_TYPE" \
  --arg display_type "$DISPLAY_TYPE" \
  --arg brief "$RESEARCH_BRIEF" \
  --argjson outline "$RESEARCH_OUTLINE" \
  --arg created "$NOW" \
  '{
    topic: $topic,
    type: $type,
    displayType: $display_type,
    brief: $brief,
    status: "drafting",
    outline: $outline,
    outlineVersion: 1,
    progress: [],
    findings: [],
    userInteractions: [],
    createdAt: $created,
    updatedAt: $created,
    finalizedAt: null,
    reportPath: null
  }' > "${RESEARCH_DIR}/state.json"

echo "OK: Research project '$RESEARCH_TOPIC' created at $RESEARCH_DIR"
echo "  Type: $DISPLAY_TYPE"
echo "  State: ${RESEARCH_DIR}/state.json"
echo "  Findings: ${RESEARCH_DIR}/findings/"
