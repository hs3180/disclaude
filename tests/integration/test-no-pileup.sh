#!/bin/bash
#
# Regression test for Issue #4725 (epic).
#
# The epic: an async REST request returning HTTP 200 does NOT mean the Agent
# turn finished. A suite boundary that sees busy>0 / pending>0 (a leftover
# background Agent) must NOT proceed — it is a drain failure, not a silent
# sleep. This test pins the two decisions the runner's pre/post suite drain
# relies on: pool_is_drained() (the gate) and that busy/pending > 0 ⇒ not
# drained (the #4725 symptom: active growing 5→11 across suites).
#
# Usage:
#   ./tests/integration/test-no-pileup.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "busy" "pending" "expect(1=drained,0=not)" "label"
check() {
    local busy="$1" pending="$2" expect="$3" label="$4" rc=0
    if pool_is_drained "$busy" "$pending"; then rc=1; fi
    if [ "$rc" = "$expect" ]; then
        log_pass "$label: drained=$([ "$rc" = 1 ] && echo yes || echo no)"
    else
        log_fail "$label: drained=$([ "$rc" = 1 ] && echo yes || echo no) expected $expect (Async 200 must not be treated as done)"
        _fail_count=$((_fail_count + 1))
    fi
}

# Turn DONE -> drained (proceed)
check "0" "0" 1 "turn-done"
# Turn NOT done (async receipt only) -> NOT drained -> suite boundary blocks
check "1" "0" 0 "async-still-running"
check "4" "0" 0 "multiple-background-agents"
check "0" "1" 0 "pending-async-task"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count no-pileup assertion(s) failed"
    exit 1
fi
log_info "no-pileup regression tests passed"
exit 0