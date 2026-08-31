#!/bin/bash
# Regression test for provider errors wrapped in HTTP 200 responses (Issue #4655).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RATE_LIMIT_MAX_RETRIES=0
export TIMEOUT=30
unset SERVER_LOG

source "$SCRIPT_DIR/common.sh" >/dev/null 2>&1

make_sync_request() { :; }
extract_json_field() { echo "${RESPONSE_TEXT_FIXTURE:-ok}"; }
extract_json_bool() { echo "true"; }
log_warn() { :; }
log_info() { :; }
log_pass() { :; }
log_fail() { :; }
log_error() { :; }
log_debug() { :; }

pass=0
fail=0
check() {
    if [ "$1" = "$2" ]; then
        echo "PASS: $3"
        pass=$((pass + 1))
    else
        echo "FAIL: $3 (got $1 want $2)"
        fail=$((fail + 1))
    fi
}

parse_response() {
    RESPONSE_STATUS=200
    RESPONSE_BODY="$RESPONSE_BODY_FIXTURE"
}

RESPONSE_BODY_FIXTURE='{"success":true,"response":"done"}'
RESPONSE_TEXT_FIXTURE=done
rc=0; assert_sync_chat_ok "hello" || rc=$?
check "$rc" 0 "ordinary HTTP 200 response passes"

RESPONSE_BODY_FIXTURE='{"success":true,"response":"Codex exec exited with code 1"}'
RESPONSE_TEXT_FIXTURE='Codex exec exited with code 1'
rc=0; assert_sync_chat_ok "hello" || rc=$?
check "$rc" 1 "embedded Codex non-zero exit fails"

RESPONSE_BODY_FIXTURE='{"success":true,"response":"HTTP 400 from provider"}'
RESPONSE_TEXT_FIXTURE='HTTP 400 from provider'
rc=0; assert_sync_chat_ok "hello" || rc=$?
check "$rc" 1 "embedded provider HTTP error fails"

echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
