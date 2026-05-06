#!/bin/bash
#
# Integration Test: Feishu IPC Transport Layer
#
# Tests the Unix socket IPC chain end-to-end using mock handlers:
#   Client → Unix Socket → Server → Mock Handler → Response
#
# No real Feishu API credentials needed. Tests run via vitest with
# a dedicated config that is excluded from the default unit test suite.
#
# Usage:
#   ./tests/integration/feishu-ipc-test.sh [options]
#
# Options:
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Plan
# =============================================================================

show_test_plan_body() {
    echo ""
    echo "Test Suites:"
    echo "  Feishu IPC Integration Tests (35 tests)"
    echo "    - sendMessage: 7 tests (text, thread, mentions, errors)"
    echo "    - sendCard: 10 tests (card, thread, description, errors)"
    echo "    - sendInteractive: 8 tests (interactive, actionPrompts, context)"
    echo "    - uploadFile: 7 tests (file upload, thread, errors)"
    echo "    - multi-card: 3 tests (LRU eviction, cross-card resolution)"
    echo ""
    echo "Prerequisites:"
    echo "  - Node.js installed"
    echo "  - disclaude built (npm run build)"
    echo "  - No Feishu credentials needed (mock handlers)"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Feishu IPC Transport"
    echo "=========================================="
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  (Dry Run - Test Plan Only)"
        show_test_plan_body
        exit 0
    fi

    # Build is required for vitest to resolve @disclaude/* imports
    log_info "Building project..."
    (cd "$PROJECT_ROOT" && npm run build:packages > /dev/null 2>&1) || {
        log_fail "Build failed"
        exit 1
    }

    log_info "Running Feishu IPC integration tests..."
    echo ""

    if (cd "$PROJECT_ROOT" && npx vitest --run --config tests/integration/feishu/vitest.config.ts); then
        echo ""
        log_info "All Feishu IPC tests passed!"
        exit 0
    else
        echo ""
        log_fail "Feishu IPC tests failed"
        exit 1
    fi
}

main
