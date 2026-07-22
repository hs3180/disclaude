#!/bin/bash
#
# Source-level unit test for the cold-start retry added to
# assert_sync_chat_ok (Issue #4321).
#
# Why a bash script (not vitest): the code under test is the bash function
# assert_sync_chat_ok in common.sh, so the regression test must also be bash.
# It sources common.sh, stubs the HTTP helpers (make_sync_request / parse_response
# / extract_* / log_*), and keeps common.sh's REAL is_rate_limit_failure — the
# retry gate — so the test exercises the actual branch logic.
#
# A file-backed counter is used because make_sync_request runs inside a
# command-substitution subshell (`result=$(make_sync_request ...)`), so an
# in-process counter would not survive.
#
# Run: bash tests/integration/test-common-retry.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export RATE_LIMIT_MAX_RETRIES=3
export RATE_LIMIT_INITIAL_DELAY=0   # no real backoff sleep during the test
export RATE_LIMIT_BACKOFF=1
export TIMEOUT=30
unset SERVER_LOG

source "$SCRIPT_DIR/common.sh" >/dev/null 2>&1

COUNTER=$(mktemp)
trap 'rm -f "$COUNTER"' EXIT
reset_counter() { echo 0 > "$COUNTER"; }
read_counter() { cat "$COUNTER"; }
bump_counter() { local n; n=$(cat "$COUNTER"); echo $((n + 1)) > "$COUNTER"; }

# Stub: make_sync_request just bumps the (file) call counter. parse_response
# (called in the parent shell) sets RESPONSE_STATUS based on the counter, so we
# control the cold-start/recovery sequence. extract_* + log_* are no-ops.
make_sync_request() { bump_counter; }
extract_json_field() { echo "hi there"; }
extract_json_bool() { echo "true"; }
log_warn() { :; }
log_info() { :; }
log_pass() { :; }
log_fail() { :; }
log_error() { :; }
log_debug() { :; }

pass=0; fail=0
check() {
  if [ "$1" = "$2" ]; then echo "PASS: $3 ($1)"; pass=$((pass + 1));
  else echo "FAIL: $3 (got $1 want $2)"; fail=$((fail + 1)); fi
}

# --- Test 1: cold-start (HTTP 000) then success → retries and succeeds ---
reset_counter
parse_response() {
  if [ "$(read_counter)" -le 1 ]; then
    RESPONSE_STATUS="000"; RESPONSE_BODY=""      # cold-start timeout
  else
    RESPONSE_STATUS="200"; RESPONSE_BODY='{"success":true,"response":"hi"}'
  fi
}
rc=0; assert_sync_chat_ok "你好" || rc=$?
check "$rc" "0" "cold-start then success returns 0"
check "$(read_counter)" "2" "cold-start retried once (2 make_sync_request calls)"

# --- Test 2: persistent failure (HTTP 500) → NO retry, fail fast ---
reset_counter
parse_response() { RESPONSE_STATUS="500"; RESPONSE_BODY='{"success":false}'; }
rc=0; assert_sync_chat_ok "你好" || rc=$?
check "$rc" "1" "HTTP 500 fails (returns 1)"
check "$(read_counter)" "1" "HTTP 500 NOT retried (1 call, fail fast)"

# --- Test 3: success on first try → NO retry ---
reset_counter
parse_response() { RESPONSE_STATUS="200"; RESPONSE_BODY='{"success":true,"response":"hi"}'; }
rc=0; assert_sync_chat_ok "你好" || rc=$?
check "$rc" "0" "first-try success returns 0"
check "$(read_counter)" "1" "success not retried (1 call)"

# --- Test 4: all attempts cold-start (HTTP 000) → exhausts retries, fails ---
reset_counter
parse_response() { RESPONSE_STATUS="000"; RESPONSE_BODY=""; }
rc=0; assert_sync_chat_ok "你好" || rc=$?
check "$rc" "1" "persistent cold-start exhausts retries → fails (1)"
check "$(read_counter)" "4" "persistent cold-start tried 4 times (max_retries+1)"

echo "---"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
