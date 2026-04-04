#!/usr/bin/env bash
# research/update-progress.sh — Update research project state
#
# Updates the research project state.json with new progress, findings,
# outline changes, or user interactions.
#
# Environment variables:
#   RESEARCH_TOPIC (required) Research topic identifier
#   RESEARCH_ACTION (required) Action to perform:
#     - update_outline: Update the research outline
#     - complete_area: Mark an investigation area as completed
#     - add_finding: Add a new finding
#     - add_interaction: Record a user interaction
#     - set_status: Change research status
#   RESEARCH_DATA   (required) JSON data for the action (format depends on action)
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

if [ -z "${RESEARCH_ACTION:-}" ]; then
  echo "ERROR: RESEARCH_ACTION environment variable is required"
  exit 1
fi

if [ -z "${RESEARCH_DATA:-}" ]; then
  echo "ERROR: RESEARCH_DATA environment variable is required"
  exit 1
fi

# Validate topic format
if ! echo "$RESEARCH_TOPIC" | grep -qE '^[a-zA-Z0-9][a-zA-Z0-9._-]*$'; then
  echo "ERROR: Invalid research topic '$RESEARCH_TOPIC'"
  exit 1
fi

# Validate action
VALID_ACTIONS="update_outline complete_area add_finding add_interaction set_status"
if ! echo "$VALID_ACTIONS" | grep -qw "$RESEARCH_ACTION"; then
  echo "ERROR: Invalid RESEARCH_ACTION '$RESEARCH_ACTION' — must be one of: $VALID_ACTIONS"
  exit 1
fi

# Validate RESEARCH_DATA is valid JSON
echo "$RESEARCH_DATA" | jq empty 2>/dev/null || {
  echo "ERROR: RESEARCH_DATA must be valid JSON"
  exit 1
}

# ---- Step 2: Locate and validate state file ----
BASE_DIR=$(cd workspace/research 2>/dev/null && pwd || (mkdir -p workspace/research && cd workspace/research && pwd))
# Use string concatenation instead of realpath -m (not available on Alpine/BusyBox)
RESEARCH_DIR="${BASE_DIR}/${RESEARCH_TOPIC}"
STATE_FILE="${RESEARCH_DIR}/state.json"

# Path traversal check (redundant with regex validation, but defense-in-depth)
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

# Check if already finalized
current_status=$(jq -r '.status' "$STATE_FILE" 2>/dev/null)
if [ "$current_status" = "completed" ] || [ "$current_status" = "cancelled" ]; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' is already '$current_status', cannot update"
  exit 1
fi

# ---- Step 3: Acquire lock ----
exec 9>"${STATE_FILE}.lock"
if ! flock -n 9; then
  echo "ERROR: Research project '$RESEARCH_TOPIC' is being updated by another process"
  exit 1
fi

# ---- Step 4: Apply action ----
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
tmpfile=$(mktemp "${STATE_FILE}.XXXXXX")
# shellcheck disable=SC2064
trap "rm -f '$tmpfile'" EXIT

case "$RESEARCH_ACTION" in
  update_outline)
    # RESEARCH_DATA: { "outline": { ... } }
    new_outline=$(echo "$RESEARCH_DATA" | jq -r '.outline')
    if [ "$new_outline" = "null" ] || [ -z "$new_outline" ]; then
      echo "ERROR: RESEARCH_DATA.outline is required for update_outline action"
      exec 9>&-
      exit 1
    fi
    echo "$new_outline" | jq empty 2>/dev/null || {
      echo "ERROR: RESEARCH_DATA.outline must be valid JSON"
      exec 9>&-
      exit 1
    }
    jq --argjson outline "$new_outline" \
       --arg ts "$NOW" \
       '.outline = $outline | .outlineVersion = (.outlineVersion + 1) | .updatedAt = $ts' \
       "$STATE_FILE" > "$tmpfile"
    echo "OK: Outline updated to version $(jq -r '.outlineVersion' "$tmpfile")"
    ;;

  complete_area)
    # RESEARCH_DATA: { "area": "area name", "summary": "key findings" }
    area=$(echo "$RESEARCH_DATA" | jq -r '.area')
    summary=$(echo "$RESEARCH_DATA" | jq -r '.summary // ""')
    if [ "$area" = "null" ] || [ -z "$area" ]; then
      echo "ERROR: RESEARCH_DATA.area is required for complete_area action"
      exec 9>&-
      exit 1
    fi
    jq --arg area "$area" \
       --arg summary "$summary" \
       --arg ts "$NOW" \
       '.progress += [{"area": $area, "summary": $summary, "completedAt": $ts}] | .updatedAt = $ts' \
       "$STATE_FILE" > "$tmpfile"
    echo "OK: Area '$area' marked as completed"
    ;;

  add_finding)
    # RESEARCH_DATA: { "content": "finding text", "source": "source URL or ref", "area": "related area" }
    content=$(echo "$RESEARCH_DATA" | jq -r '.content')
    source=$(echo "$RESEARCH_DATA" | jq -r '.source // ""')
    area=$(echo "$RESEARCH_DATA" | jq -r '.area // ""')
    if [ "$content" = "null" ] || [ -z "$content" ]; then
      echo "ERROR: RESEARCH_DATA.content is required for add_finding action"
      exec 9>&-
      exit 1
    fi
    if [ "${#content}" -gt 5000 ]; then
      echo "ERROR: Finding content too long (${#content} chars, max 5000)"
      exec 9>&-
      exit 1
    fi
    jq --arg content "$content" \
       --arg source "$source" \
       --arg area "$area" \
       --arg ts "$NOW" \
       '.findings += [{"content": $content, "source": $source, "area": $area, "recordedAt": $ts}] | .updatedAt = $ts' \
       "$STATE_FILE" > "$tmpfile"
    echo "OK: Finding recorded"
    ;;

  add_interaction)
    # RESEARCH_DATA: { "type": "modification|approval|redirect|cancellation", "detail": "description" }
    interaction_type=$(echo "$RESEARCH_DATA" | jq -r '.type')
    detail=$(echo "$RESEARCH_DATA" | jq -r '.detail')
    if [ "$interaction_type" = "null" ] || [ -z "$interaction_type" ]; then
      echo "ERROR: RESEARCH_DATA.type is required for add_interaction action"
      exec 9>&-
      exit 1
    fi
    valid_interaction_types="modification approval redirect cancellation question"
    if ! echo "$valid_interaction_types" | grep -qw "$interaction_type"; then
      echo "ERROR: Invalid interaction type '$interaction_type' — must be one of: $valid_interaction_types"
      exec 9>&-
      exit 1
    fi
    jq --arg type "$interaction_type" \
       --arg detail "$detail" \
       --arg ts "$NOW" \
       '.userInteractions += [{"type": $type, "detail": $detail, "timestamp": $ts}] | .updatedAt = $ts' \
       "$STATE_FILE" > "$tmpfile"
    echo "OK: User interaction recorded ($interaction_type)"
    ;;

  set_status)
    # RESEARCH_DATA: { "status": "negotiating|executing|reviewing|completed|cancelled" }
    new_status=$(echo "$RESEARCH_DATA" | jq -r '.status')
    if [ "$new_status" = "null" ] || [ -z "$new_status" ]; then
      echo "ERROR: RESEARCH_DATA.status is required for set_status action"
      exec 9>&-
      exit 1
    fi
    valid_statuses="drafting negotiating executing reviewing completed cancelled"
    if ! echo "$valid_statuses" | grep -qw "$new_status"; then
      echo "ERROR: Invalid status '$new_status' — must be one of: $valid_statuses"
      exec 9>&-
      exit 1
    fi
    # Prevent reverting from terminal states
    if [ "$current_status" = "completed" ] || [ "$current_status" = "cancelled" ]; then
      echo "ERROR: Cannot change status from '$current_status' to '$new_status'"
      exec 9>&-
      exit 1
    fi
    jq --arg status "$new_status" \
       --arg ts "$NOW" \
       '.status = $status | .updatedAt = $ts' \
       "$STATE_FILE" > "$tmpfile"
    echo "OK: Status updated to '$new_status'"
    ;;
esac

# ---- Step 5: Atomic write ----
mv "$tmpfile" "$STATE_FILE"
trap - EXIT
exec 9>&-
