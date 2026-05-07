#!/bin/bash
#
# Integration Test: Chat Lifecycle (lark-cli)
#
# Tests real lark-cli group creation/dissolution with mapping table.
# Auto-skips when lark-cli is not installed.
#
# Usage:
#   ./tests/integration/chat-ipc-test.sh [options]
#
# Options:
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#
# Environment variables:
#   TEST_CHAT_USER_IDS  Comma-separated user open_ids for member tests

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
    echo "  Chat Lifecycle Integration Tests"
    echo "    - CC (创建群): 7 tests"
    echo "    - CD (解散群): 5 tests"
    echo "    - CL (列表): 2 tests"
    echo "    - CQ (查询): 2 tests"
    echo ""
    echo "Prerequisites:"
    echo "  - Node.js installed"
    echo "  - lark-cli installed and authenticated (tests auto-skip if unavailable)"
    echo "  - Optional: TEST_CHAT_USER_IDS for member-related tests"
    echo ""
}

# =============================================================================
# Main
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Chat Lifecycle"
    echo "=========================================="
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  (Dry Run - Test Plan Only)"
        show_test_plan_body
        exit 0
    fi

    # Check lark-cli availability
    if command -v lark-cli &> /dev/null; then
        echo "  lark-cli: $(lark-cli --version 2>/dev/null || echo 'version unknown')"
    else
        echo "  ⚠️  lark-cli not found — tests will auto-skip"
    fi

    if [ -n "$TEST_CHAT_USER_IDS" ]; then
        echo "  TEST_CHAT_USER_IDS: $TEST_CHAT_USER_IDS"
    fi

    echo ""

    log_info "Running Chat lifecycle integration tests..."
    echo ""

    if (cd "$PROJECT_ROOT" && npx vitest --run --config tests/integration/chat/vitest.config.ts); then
        echo ""
        log_info "All Chat lifecycle tests passed!"
        exit 0
    else
        echo ""
        log_pass "Chat lifecycle tests failed (or skipped)"
        exit 1
    fi
}

main
