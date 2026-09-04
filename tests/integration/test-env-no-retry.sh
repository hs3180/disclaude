#!/bin/bash
#
# Regression test for Issue #4710.
#
# run-all-tests.sh must NOT pointlessly retry a DETERMINISTIC environment
# failure. The detection is a sandbox-marker scan of the failed suite's output
# (sandbox_apply / Operation not permitted / EACCES / Permission denied). This
# test pins that marker pattern so the "skip retries" branch fires exactly when
# the environment blocked an operation, and never on a normal failure. The rule
# is suite-agnostic (the dedicated codex-compat suite was removed (#4787); any
# generic suite under a sandboxed backend is protected).
#
# Usage:
#   ./tests/integration/test-env-no-retry.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# Mirror of the runner's marker pattern in run_test_script().
ENV_MARKER_RE="sandbox_apply|Operation not permitted|Operation not allowed|EACCES|Permission denied"

_fail_count=0

# usage: check "output" "expect(0=retry,1=no-retry)" "label"
check() {
    local output="$1" expect="$2" label="$3" rc=1
    if echo "$output" | grep -qiE "$ENV_MARKER_RE"; then
        rc=0   # marker found -> no-retry branch
    fi
    local want_no_retry
    if [ "$expect" = "1" ]; then want_no_retry=0; else want_no_retry=1; fi
    if [ "$rc" = "$want_no_retry" ]; then
        log_pass "$label: env-detected=$([ "$rc" = 0 ] && echo yes || echo no) (expected $expect)"
    else
        log_fail "$label: env-detected=$([ "$rc" = 0 ] && echo yes || echo no) expected $expect"
        _fail_count=$((_fail_count + 1))
    fi
}

# Deterministic environment failures -> detect, no retry
check "sandbox_apply: Operation not permitted
[FAIL] workspace-write (S4) — sawActivity=true file=false" 1 "sandbox-reject"
check "[FAIL] write: RuntimeError EACCES permission denied" 1 "eacces"
check "write rejected by the OS sandbox: Permission denied" 1 "permission-denied"
# Normal failures / passes -> run the retry logic
check "[FAIL] Use Case 1: HTTP 500 provider error" 0 "provider-error"
check "All tests passed! (12/12)" 0 "all-passed"
check "quota exhausted (code 1308) usage cap" 0 "quota-no-marker"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count env-no-retry assertion(s) failed"
    exit 1
fi
log_info "env-no-retry regression tests passed"
exit 0