#!/bin/bash
#
# Integration Test: Use Case 2 - Task Execution
#
# Tests task execution scenario: User sends a task, Agent executes and returns result.
#
# Usage:
#   ./tests/integration/use-case-2-task-execution.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 60)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-120}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

test_calculation_task() {
    log_info "Test: Calculation task (25 * 17)..."

    assert_sync_chat_ok "请帮我计算 25 乘以 17 等于多少？" || return 1

    if echo "$RESPONSE_TEXT" | grep -qE "425"; then
        log_pass "Agent returned correct answer (425)"
    else
        log_fail "Agent did not return expected answer '425'"
        return 1
    fi
}

test_file_listing_task() {
    log_info "Test: File listing task..."

    local chat_id="test-use-case-2-files-$$"
    assert_sync_chat_ok_with_retry "请列出当前目录下的所有文件" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -iqE "package\.json|src|dist|文件|目录|file|directory|ls|Running"; then
        log_pass "Agent returned directory content"
    else
        log_fail "Agent response does not contain file-related content"
        return 1
    fi
}

test_text_analysis_task() {
    log_info "Test: Text analysis task..."

    local chat_id="test-use-case-2-text-$$"
    assert_sync_chat_ok "请用一句话总结：人工智能是计算机科学的一个分支，它试图理解智能的本质，并开发出一种新的能以人类智能相似的方式做出反应的智能机器。" "$chat_id" || return 1

    # Validate response is a summary (non-empty)
    if [ -n "$RESPONSE_TEXT" ]; then
        log_pass "Agent provided a summary"
    else
        log_fail "No summary provided"
        return 1
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "Calculation task" test_calculation_task "ai" "Agent computes 25 * 17"
declare_test "File listing task" test_file_listing_task "ai" "Agent lists directory contents"
declare_test "Text analysis task" test_text_analysis_task "ai" "Agent summarizes text"

main_test_suite "Integration Test: Use Case 2 - Task Execution"
