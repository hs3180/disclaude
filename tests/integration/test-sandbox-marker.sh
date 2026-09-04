#!/bin/bash
#
# Regression test for Issue #4692.
#
# Pins has_sandbox_marker(): the Codex Compatibility E2E workspace-write check
# must treat an outer-sandbox rejection (EACCES / Operation not permitted /
# sandbox_apply) as an ENVIRONMENTAL blocker (SKIP) rather than a Disclaude
# regression (FAIL). This test verifies the classification the SKIP decision
# hinges on.
#
# Usage:
#   ./tests/integration/test-sandbox-marker.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# usage: check "text" "expect_marker(0|1)" "label"
check() {
    local text="$1" expect="$2" label="$3" rc=0
    if has_sandbox_marker "$text"; then rc=0; else rc=1; fi
    if [ "$rc" = "$expect" ]; then
        log_pass "$label: marker=$rc (expected $expect)"
    else
        log_fail "$label: got marker=$rc expected $expect"
        _fail_count=$((_fail_count + 1))
    fi
}

# Markers -> env-block detected (0)
check "sandbox_apply: Operation not permitted" 0 "sandbox-apply"
check "RuntimeError: EACCES permission denied" 0 "eacces"
check "tool error: Operation not allowed" 0 "operation-not-allowed"
check "Permission denied (os error 13)" 0 "permission-denied"
# No marker -> not env-blocked (1)
check "probe file written successfully; messageId om_x" 1 "normal-success"
check "Agent replied but no file produced" 1 "no-marker"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count sandbox-marker assertion(s) failed"
    exit 1
fi
log_info "sandbox-marker regression tests passed"
exit 0