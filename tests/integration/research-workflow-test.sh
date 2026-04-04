#!/usr/bin/env bash
# Integration tests for research workflow scripts
#
# Tests the full lifecycle: create → update → query → finalize
# Requires: jq (available in PATH), bash 4+

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TEST_DIR=$(mktemp -d)
PASSED=0
FAILED=0
TOTAL=0

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

cleanup() {
  rm -rf "$TEST_DIR"
}
trap cleanup EXIT

# Ensure jq is available
if ! command -v jq &>/dev/null; then
  echo -e "${RED}ERROR: jq is required but not found in PATH${NC}"
  exit 1
fi

pass() {
  PASSED=$((PASSED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${GREEN}PASS${NC}: $1"
}

fail() {
  FAILED=$((FAILED + 1))
  TOTAL=$((TOTAL + 1))
  echo -e "  ${RED}FAIL${NC}: $1"
  if [ -n "${2:-}" ]; then
    echo -e "         ${RED}Reason: $2${NC}"
  fi
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    pass "$desc"
  else
    fail "$desc" "expected '$expected', got '$actual'"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$desc"
  else
    fail "$desc" "output does not contain '$needle'"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    fail "$desc" "output should not contain '$needle'"
  else
    pass "$desc"
  fi
}

echo "========================================"
echo "Research Workflow Integration Tests"
echo "========================================"
echo "Test directory: $TEST_DIR"
echo ""

mkdir -p "$TEST_DIR/workspace/research"

# ---- Test Group 1: create.sh ----
echo "--- create.sh tests ---"

# Test 1.1: Missing RESEARCH_TOPIC
output=$(RESEARCH_TYPE="comparison" RESEARCH_BRIEF="test" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_TOPIC" "$output" "RESEARCH_TOPIC"

# Test 1.2: Missing RESEARCH_TYPE
output=$(RESEARCH_TOPIC="test-1" RESEARCH_BRIEF="test" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_TYPE" "$output" "RESEARCH_TYPE"

# Test 1.3: Missing RESEARCH_BRIEF
output=$(RESEARCH_TOPIC="test-1" RESEARCH_TYPE="comparison" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_BRIEF" "$output" "RESEARCH_BRIEF"

# Test 1.4: Invalid RESEARCH_TYPE
output=$(RESEARCH_TOPIC="test-1" RESEARCH_TYPE="invalid_type" RESEARCH_BRIEF="test" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects invalid RESEARCH_TYPE" "$output" "Invalid RESEARCH_TYPE"

# Test 1.5: Path traversal attempt
output=$(RESEARCH_TOPIC="../etc/passwd" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="test" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects path traversal" "$output" "Invalid research topic"

# Test 1.6: Topic with leading dot
output=$(RESEARCH_TOPIC=".hidden" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="test" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects leading dot topic" "$output" "Invalid research topic"

# Test 1.7: Oversized brief
long_brief=$(head -c 2001 < /dev/zero | tr '\0' 'x')
output=$(RESEARCH_TOPIC="test-1" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="$long_brief" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects oversized brief" "$output" "too long"

# Test 1.8: Invalid RESEARCH_OUTLINE JSON
output=$(RESEARCH_TOPIC="test-1" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="test brief" RESEARCH_OUTLINE="not json" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
assert_contains "rejects invalid outline JSON" "$output" "valid JSON"

# Test 1.9: Successful creation
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="Test research brief" RESEARCH_OUTLINE='{"areas":["area1","area2"]}' bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1)
  assert_contains "creates research project" "$output" "OK: Research project 'test-create' created"
  assert_eq "state.json exists" "yes" "$(test -f workspace/research/test-create/state.json && echo yes || echo no)"
  assert_eq "findings dir exists" "yes" "$(test -d workspace/research/test-create/findings && echo yes || echo no)"
)

# Test 1.10: Duplicate creation
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_TYPE="comparison" RESEARCH_BRIEF="Test research brief" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>&1 || true)
  assert_contains "rejects duplicate topic" "$output" "already exists"
)

# Test 1.11: Verify state.json content
(
  cd "$TEST_DIR"
  topic=$(jq -r '.topic' workspace/research/test-create/state.json)
  type=$(jq -r '.type' workspace/research/test-create/state.json)
  status=$(jq -r '.status' workspace/research/test-create/state.json)
  brief=$(jq -r '.brief' workspace/research/test-create/state.json)
  outline_area=$(jq -r '.outline.areas[0]' workspace/research/test-create/state.json)
  assert_eq "topic field correct" "test-create" "$topic"
  assert_eq "type field correct" "comparison" "$type"
  assert_eq "status is drafting" "drafting" "$status"
  assert_eq "brief field correct" "Test research brief" "$brief"
  assert_eq "outline preserved" "area1" "$outline_area"
)

echo ""

# ---- Test Group 2: update-progress.sh ----
echo "--- update-progress.sh tests ---"

# Test 2.1: Missing RESEARCH_TOPIC
output=$(RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_TOPIC" "$output" "RESEARCH_TOPIC"

# Test 2.2: Missing RESEARCH_ACTION
output=$(RESEARCH_TOPIC="test-create" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_ACTION" "$output" "RESEARCH_ACTION"

# Test 2.3: Missing RESEARCH_DATA
output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="set_status" bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_DATA" "$output" "RESEARCH_DATA"

# Test 2.4: Invalid action
output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="invalid_action" RESEARCH_DATA='{}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
assert_contains "rejects invalid action" "$output" "Invalid RESEARCH_ACTION"

# Test 2.5: Non-existent topic
output=$(RESEARCH_TOPIC="nonexistent" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
assert_contains "rejects non-existent topic" "$output" "not found"

# Test 2.6: Set status to executing
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1)
  assert_contains "sets status to executing" "$output" "Status updated to 'executing'"
  status=$(jq -r '.status' workspace/research/test-create/state.json)
  assert_eq "status is executing" "executing" "$status"
)

# Test 2.7: Complete an area
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="complete_area" RESEARCH_DATA='{"area":"area1","summary":"Found key differences in performance"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1)
  assert_contains "completes area" "$output" "Area 'area1' marked as completed"
  progress_count=$(jq '.progress | length' workspace/research/test-create/state.json)
  assert_eq "progress has 1 entry" "1" "$progress_count"
)

# Test 2.8: Add a finding
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="add_finding" RESEARCH_DATA='{"content":"React shows better performance in large-scale SPAs","source":"https://example.com/benchmark","area":"area1"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1)
  assert_contains "adds finding" "$output" "Finding recorded"
  findings_count=$(jq '.findings | length' workspace/research/test-create/state.json)
  assert_eq "findings has 1 entry" "1" "$findings_count"
)

# Test 2.9: Add user interaction
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="add_interaction" RESEARCH_DATA='{"type":"approval","detail":"User approved outline v1"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1)
  assert_contains "records interaction" "$output" "User interaction recorded"
  interactions_count=$(jq '.userInteractions | length' workspace/research/test-create/state.json)
  assert_eq "interactions has 1 entry" "1" "$interactions_count"
)

# Test 2.10: Update outline
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="update_outline" RESEARCH_DATA='{"outline":{"areas":["area1","area2","area3"],"version":2}}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1)
  assert_contains "updates outline" "$output" "Outline updated to version 2"
  outline_version=$(jq -r '.outlineVersion' workspace/research/test-create/state.json)
  assert_eq "outline version incremented" "2" "$outline_version"
)

# Test 2.11: Invalid finding (oversized content)
long_content=$(head -c 5001 < /dev/zero | tr '\0' 'x')
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="add_finding" RESEARCH_DATA="{\"content\":\"$long_content\"}" bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
  assert_contains "rejects oversized finding" "$output" "too long"
)

# Test 2.12: Invalid interaction type
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="add_interaction" RESEARCH_DATA='{"type":"invalid_type","detail":"test"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
  assert_contains "rejects invalid interaction type" "$output" "Invalid interaction type"
)

echo ""

# ---- Test Group 3: query.sh ----
echo "--- query.sh tests ---"

# Test 3.1: Missing RESEARCH_TOPIC
output=$(bash "$PROJECT_ROOT/scripts/research/query.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_TOPIC" "$output" "RESEARCH_TOPIC"

# Test 3.2: Non-existent topic
output=$(RESEARCH_TOPIC="nonexistent" bash "$PROJECT_ROOT/scripts/research/query.sh" 2>&1 || true)
assert_contains "rejects non-existent topic" "$output" "not found"

# Test 3.3: Successful query
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" bash "$PROJECT_ROOT/scripts/research/query.sh" 2>&1)
  assert_contains "shows topic" "$output" "Research: test-create"
  assert_contains "shows type" "$output" "Comparison"
  assert_contains "shows status" "$output" "executing"
  assert_contains "shows findings count" "$output" "Findings: 1 recorded"
  assert_contains "shows progress count" "$output" "Progress: 1 areas completed"
  assert_contains "shows findings summary" "$output" "React shows better performance"
)

echo ""

# ---- Test Group 4: finalize.sh ----
echo "--- finalize.sh tests ---"

# Test 4.1: Missing RESEARCH_TOPIC
output=$(RESEARCH_STATUS="completed" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_TOPIC" "$output" "RESEARCH_TOPIC"

# Test 4.2: Missing RESEARCH_STATUS
output=$(RESEARCH_TOPIC="test-create" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1 || true)
assert_contains "rejects missing RESEARCH_STATUS" "$output" "RESEARCH_STATUS"

# Test 4.3: Invalid RESEARCH_STATUS
output=$(RESEARCH_TOPIC="test-create" RESEARCH_STATUS="invalid" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1 || true)
assert_contains "rejects invalid status" "$output" "must be 'completed' or 'cancelled'"

# Test 4.4: Non-existent topic
output=$(RESEARCH_TOPIC="nonexistent" RESEARCH_STATUS="completed" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1 || true)
assert_contains "rejects non-existent topic" "$output" "not found"

# Test 4.5: Successful finalization as completed
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_STATUS="completed" RESEARCH_REPORT_PATH="workspace/research/test-create/report.md" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1)
  assert_contains "finalizes as completed" "$output" "finalized as 'completed'"
  assert_contains "shows summary" "$output" "Findings recorded: 1"
  status=$(jq -r '.status' workspace/research/test-create/state.json)
  finalized=$(jq -r '.finalizedAt' workspace/research/test-create/state.json)
  report=$(jq -r '.reportPath' workspace/research/test-create/state.json)
  assert_eq "status is completed" "completed" "$status"
  assert_not_contains "finalizedAt is set" "$finalized" "null"
  assert_eq "report path set" "workspace/research/test-create/report.md" "$report"
)

# Test 4.6: Double finalization rejected
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_STATUS="completed" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1 || true)
  assert_contains "rejects double finalization" "$output" "already 'completed'"
)

# Test 4.7: Update after finalization rejected
(
  cd "$TEST_DIR"
  output=$(RESEARCH_TOPIC="test-create" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>&1 || true)
  assert_contains "rejects update after finalization" "$output" "already 'completed'"
)

# Test 4.8: Finalization as cancelled
(
  cd "$TEST_DIR"
  RESEARCH_TOPIC="test-cancel" RESEARCH_TYPE="other" RESEARCH_BRIEF="Test cancellation" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>/dev/null
  output=$(RESEARCH_TOPIC="test-cancel" RESEARCH_STATUS="cancelled" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>&1)
  assert_contains "finalizes as cancelled" "$output" "finalized as 'cancelled'"
  status=$(jq -r '.status' workspace/research/test-cancel/state.json)
  assert_eq "status is cancelled" "cancelled" "$status"
)

echo ""

# ---- Test Group 5: Full lifecycle ----
echo "--- Full lifecycle test ---"

(
  cd "$TEST_DIR"
  TOPIC="lifecycle-test"

  # Create
  RESEARCH_TOPIC="$TOPIC" RESEARCH_TYPE="feasibility_study" RESEARCH_BRIEF="Can we migrate to TypeScript?" bash "$PROJECT_ROOT/scripts/research/create.sh" 2>/dev/null
  assert_eq "lifecycle: created" "drafting" "$(jq -r '.status' workspace/research/$TOPIC/state.json)"

  # Negotiate
  RESEARCH_TOPIC="$TOPIC" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"negotiating"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>/dev/null
  assert_eq "lifecycle: negotiating" "negotiating" "$(jq -r '.status' workspace/research/$TOPIC/state.json)"

  # Execute
  RESEARCH_TOPIC="$TOPIC" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"executing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>/dev/null
  RESEARCH_TOPIC="$TOPIC" RESEARCH_ACTION="complete_area" RESEARCH_DATA='{"area":"codebase-analysis","summary":"80% TypeScript ready"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>/dev/null
  RESEARCH_TOPIC="$TOPIC" RESEARCH_ACTION="add_finding" RESEARCH_DATA='{"content":"TypeScript migration is feasible","source":"internal audit","area":"codebase-analysis"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>/dev/null

  # Review
  RESEARCH_TOPIC="$TOPIC" RESEARCH_ACTION="set_status" RESEARCH_DATA='{"status":"reviewing"}' bash "$PROJECT_ROOT/scripts/research/update-progress.sh" 2>/dev/null
  assert_eq "lifecycle: reviewing" "reviewing" "$(jq -r '.status' workspace/research/$TOPIC/state.json)"

  # Finalize
  RESEARCH_TOPIC="$TOPIC" RESEARCH_STATUS="completed" bash "$PROJECT_ROOT/scripts/research/finalize.sh" 2>/dev/null
  assert_eq "lifecycle: completed" "completed" "$(jq -r '.status' workspace/research/$TOPIC/state.json)"
  assert_eq "lifecycle: 1 progress entry" "1" "$(jq '.progress | length' workspace/research/$TOPIC/state.json)"
  assert_eq "lifecycle: 1 finding" "1" "$(jq '.findings | length' workspace/research/$TOPIC/state.json)"
)

echo ""

# ---- Results ----
echo "========================================"
echo -e "Results: ${GREEN}${PASSED} passed${NC}, ${RED}${FAILED} failed${NC}, ${TOTAL} total"
echo "========================================"

if [ "$FAILED" -gt 0 ]; then
  exit 1
fi

exit 0
