#!/bin/bash
#
# Regression test for Issue #4689.
#
# check_build() must probe the real per-package dist/ artifacts
# (packages/primary-node/dist/cli.js + packages/core/dist), NOT a root
# dist/ dir. A clean `npm run build` emits to packages/*/dist, so probing
# "$PROJECT_ROOT/dist" misreports "not built" even after a successful build.
#
# This test sources common.sh but overrides PROJECT_ROOT to a throwaway
# workspace so it can exercise both the happy and the missing-artifact paths
# without requiring a real build.
#
# Usage:
#   ./tests/integration/test-build-check.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Suppress the normal argument parsing noise; we only need the helpers.
source "$SCRIPT_DIR/common.sh"

_fail_count=0

workspace="$(mktemp -d "${TMPDIR:-/tmp}/build-check.XXXXXX")"
trap 'rm -rf "$workspace"' EXIT

# Simulate a real build graph: primary-node cli.js + core/dist present.
build_ok_workspace() {
    mkdir -p "$workspace/packages/primary-node/dist" "$workspace/packages/core/dist"
    printf '#!/usr/bin/env node\n' > "$workspace/packages/primary-node/dist/cli.js"
}

PROJECT_ROOT="$workspace"

case "${1:-}" in
    -h|--help)
        echo "Usage: $0 [--verbose]"
        exit 0
        ;;
esac

# --- happy path: real artifacts present -> check passes ---------------------
build_ok_workspace
PROJECT_ROOT="$workspace"
if check_build; then
    log_pass "check_build passes when per-package dist artifacts exist"
else
    log_fail "check_build should pass when packages/*/dist exist"
    _fail_count=$((_fail_count + 1))
fi

# --- failure path: primary-node cli.js missing -> check fails --------------
rm -rf "$workspace/packages/primary-node"
if check_build; then
    log_fail "check_build should fail when packages/primary-node/dist/cli.js is missing"
    _fail_count=$((_fail_count + 1))
else
    log_pass "check_build fails when primary-node cli.js is missing"
fi

# --- failure path: only a root dist exists (the old false-positive) --------
rm -rf "$workspace/packages"
mkdir -p "$workspace/dist"
if check_build; then
    log_fail "check_build must brute grep root dist (a bare root dist/ is NOT a valid build)"
    _fail_count=$((_fail_count + 1))
else
    log_pass "check_build ignores a stale root dist/ (Issue #4689)"
fi

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count build-check assertion(s) failed"
    exit 1
fi
log_info "build-check regression tests passed"
exit 0
