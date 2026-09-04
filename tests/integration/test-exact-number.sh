#!/bin/bash
#
# Regression test for Issue #4690.
#
# Pins assert_exact_number(): a session-context drift in the multi-turn suite
# (e.g. the agent forgets the remembered 42 and computes 7×2=14) must FAIL the
# suite, not be downgraded to a WARN as before.
#
# Usage:
#   ./tests/integration/test-exact-number.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "resp_text" "expected" "expected_rc(0|1)" "label"
check() {
    local text="$1" expected="$2" exp_rc="$3" label="$4" rc=0
    RESPONSE_TEXT="$text"
    if ! assert_exact_number "$expected" "$label" > /dev/null 2>&1; then
        rc=1
    fi
    if [ "$rc" = "$exp_rc" ]; then
        log_pass "$label: rc=$rc (expected $exp_rc)"
    else
        log_fail "$label: got rc=$rc expected $exp_rc"
        _fail_count=$((_fail_count + 1))
    fi
}

# exact match -> pass
check "42" "42" 0 "exact-match"
# extra prose around the number -> still extracts 42
check "我的幸运数字是 42，就是这样。" "42" 0 "number-in-prose"
# drift: model forgot 42 and answered 7 -> fail
check "7" "42" 1 "context-drift"
# drift compounding: 7*2=14 instead of 84 -> fail
check "14" "84" 1 "calculation-drift"
# no numeric reply at all -> fail
check "好的，我记住了。" "42" 1 "no-number"
# two numbers, first wrong -> fail (leading wrong value)
check "12 和 42" "42" 1 "leading-wrong-number"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count exact-number assertion(s) failed"
    exit 1
fi
log_info "exact-number regression tests passed"
exit 0