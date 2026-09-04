#!/bin/bash
#
# Regression test for Issue #4730.
#
# Pins read_pool_stats(): the runner's per-suite lifecycle log must capture the
# Agent pool counters (active/busy/pending/evictions) so an integration run can
# be reconstructed per-suite. Missing/absent fields must default to 0 rather
# than producing a fragile or blank line.
#
# Usage:
#   ./tests/integration/test-lifecycle-stats.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "health_body" "expected_substring" "label"
check() {
    local body="$1" expected="$2" label="$3" got
    got=$(read_pool_stats "$body")
    if echo "$got" | grep -qF "$expected"; then
        log_pass "$label: '$got' contains '$expected'"
    else
        log_fail "$label: '$got' does not contain '$expected'"
        _fail_count=$((_fail_count + 1))
    fi
}

check '{"status":"ok","agentPool":{"active":5,"busy":2},"exit":1}' "active:5 busy:2 pending:0 evictions:0" "busy-pool"
check '{"status":"ok","agentPool":{"active":11,"busy":0,"pending":3},"exit":1}' "active:11 busy:0 pending:3 evictions:0" "pending-tasks"
check '{"agentPool":{"active":3,"busy":1},"evicted":4}' "active:3 busy:1 pending:0 evictions:4" "evictions"
check '{"status":"ok"}' "active:0 busy:0 pending:0 evictions:0" "no-pool-field"
check '' "active:0 busy:0 pending:0 evictions:0" "empty-body"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count lifecycle-stats assertion(s) failed"
    exit 1
fi
log_info "lifecycle-stats regression tests passed"
exit 0