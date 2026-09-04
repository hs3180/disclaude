#!/bin/bash
#
# Regression test for Issue #4728.
#
# Pins pool_is_drained(): the suite-boundary drain barrier must treat a suite as
# converged only when busy=0 AND pending async tasks = 0. An unfused negative
# (busy>0 or pending>0 from an un-finished async Agent, the #4725 pileup) must
# NOT be considered drained.
#
# Usage:
#   ./tests/integration/test-drain-barrier.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "busy" "pending" "expect(0=drained,1=not)" "label"
check() {
    local busy="$1" pending="$2" expect="$3" label="$4" rc=0
    if pool_is_drained "$busy" "$pending"; then rc=0; else rc=1; fi
    if [ "$rc" = "$expect" ]; then
        log_pass "$label: drained=$([ "$rc" = 0 ] && echo yes || echo no) (expected $expect)"
    else
        log_fail "$label: got drained=$([ "$rc" = 0 ] && echo yes || echo no) expected $expect"
        _fail_count=$((_fail_count + 1))
    fi
}

# converged -> drained
check "0" "0" 0 "both-zero"
check "" "0" 0 "missing-busy"
check "0" "" 0 "missing-pending"
check "" "" 0 "both-missing"
# not converged -> NOT drained
check "2" "0" 1 "busy-agent"
check "0" "3" 1 "pending-tasks"
check "1" "1" 1 "busy-and-pending"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count drain-barrier assertion(s) failed"
    exit 1
fi
log_info "drain-barrier regression tests passed"
exit 0