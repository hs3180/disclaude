#!/bin/bash
#
# Regression test for Issue #4727 / #4725.
#
# Pins the agentPool busy-count extraction that a run-all/rest suite relies on
# to know when a background Agent turn has converged. The REST async receipt
# (HTTP 200) must NOT be treated as completion — the pool's busy count is the
# source of truth, and a non-zero busy value means the suite must keep draining.
#
# The extraction under test is the shared `pool_busy()` in common.sh — the SAME
# function used by rest-channel-test.sh::wait_for_agent_pool_idle — so a change
# to the real drain logic is caught here, not silently diverged.
#
# Usage:
#   ./tests/integration/test-pool-idle.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "health_body" "expect_busy" "label"
check() {
    local body="$1" expect="$2" label="$3" got
    got=$(pool_busy "$body")
    if [ -z "$got" ]; then got="<none>"; fi
    if [ "$got" = "$expect" ]; then
        log_pass "$label: busy=$got (expected $expect)"
    else
        log_fail "$label: busy=$got expected $expect"
        _fail_count=$((_fail_count + 1))
    fi
}

check '{"status":"ok","agentPool":{"active":3,"busy":2},"exit":1}' "2" "busy-2-draining"
check '{"status":"ok","agentPool":{"active":5,"busy":0},"exit":1}' "0" "busy-0-idle"
check '{"status":"ok"}' "<none>" "no-pool-field"
check '{"agentPool":{"busy":0}}' "0" "busy-0-no-active"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count pool-idle assertion(s) failed"
    exit 1
fi
log_info "pool-idle regression tests passed"
exit 0