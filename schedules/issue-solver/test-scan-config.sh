#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Lightweight tests for scan.mjs config parsing & validation
# ---------------------------------------------------------------------------
set -euo pipefail

SCAN_DIR="$(cd "$(dirname "$0")" && pwd)"
PASS=0
FAIL=0

assert_exit() {
  local label="$1" expected="$2"
  shift 2
  local actual
  actual=$(env "$@" node "$SCAN_DIR/scan.mjs" 2>&1; echo $?)
  local code="${actual##*$'\n'}"
  if [ "$code" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    echo "  PASS: $label (exit $code)"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (expected exit $expected, got $code)"
  fi
}

assert_stderr_contains() {
  local label="$1" expected="$2"
  shift 2
  local output
  output=$(env "$@" node "$SCAN_DIR/scan.mjs" 2>&1 || true)
  if echo "$output" | grep -q "$expected"; then
    PASS=$((PASS + 1))
    echo "  PASS: $label"
  else
    FAIL=$((FAIL + 1))
    echo "  FAIL: $label (expected stderr to contain '$expected')"
    echo "        output: $output" | head -3
  fi
}

echo "=== scan.mjs config tests ==="
echo ""

echo "--- TARGET_REPO validation ---"
# Invalid format (no slash) should exit 1
assert_exit "reject TARGET_REPO without slash" 1 TARGET_REPO=myrepo

# Valid format should not exit at config stage (will fail at auth, but that's exit 0)
assert_exit "accept valid TARGET_REPO format" 0 TARGET_REPO=org/repo

echo ""
echo "--- Default REPO ---"
# No env var set: should not fail at config stage
assert_exit "default REPO accepted" 0

echo ""
echo "--- Error message content ---"
assert_stderr_contains "error message on bad format" "owner/repo" TARGET_REPO=badformat

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
[ "$FAIL" -eq 0 ] || exit 1
