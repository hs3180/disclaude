#!/bin/bash
# Regression test for run-all-tests.sh runner-owned flags (Issue #4656).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER="$SCRIPT_DIR/run-all-tests.sh"

check_args() {
    local output
    output=$("$RUNNER" "$@" --dry-run 2>&1)
    echo "$output" | grep -q -- '- Max Retries: 0' || return 1
    echo "$output" | grep -q -- '- Inter-suite Delay: 0s' || return 1
}

check_args --retries 0 --delay 0 --verbose
check_args --verbose --delay 0 --retries 0
echo 'PASS: runner flags parse in either order and reach dry-run configuration'
