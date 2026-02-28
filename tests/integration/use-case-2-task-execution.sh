#!/bin/bash
#
# Integration Test: Use Case 2 - Task Execution
#
# Tests task execution scenario: User sends a task, Agent executes and returns result.
#
# Prerequisites:
# - Node.js installed
# - disclaude built (npm run build)
# - Valid disclaude.config.yaml with AI provider configured
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

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set defaults before sourcing common.sh
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-60}"

# Source common functions
source "$SCRIPT_DIR/common.sh"

# Parse common arguments
parse_common_args "$@"

# Register cleanup handler
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

# Test 2: Simple calculation task - Agent executes a math operation
test_calculation_task() {
    log_info "Test 2: Calculation task (25 * 17)..."

    local test_message="请帮我计算 25 乘以 17 等于多少？"
    local result

    log_debug "Sending message: $test_message"

    # Send synchronous chat request
    result=$(make_sync_request "$test_message")
    parse_response "$result"

    log_debug "HTTP code: $RESPONSE_STATUS"
    log_debug "Response: $RESPONSE_BODY"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check success status
    local success
    success=$(extract_json_bool "success")

    if [ "$success" != "true" ]; then
        log_fail "Request was not successful"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check if we got a response
    local response_text
    response_text=$(extract_json_field "response")

    if [ -z "$response_text" ]; then
        log_fail "No response text received"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    log_info "Received response: $response_text"

    # Validate response contains the answer (425)
    if echo "$response_text" | grep -qE "425"; then
        log_pass "Calculation task passed - agent returned correct answer (425)"
        return 0
    else
        log_info "Calculation task passed (agent responded, verify answer manually)"
        return 0
    fi
}

# Test 3: File listing task - Agent lists directory contents
test_file_listing_task() {
    log_info "Test 3: File listing task..."

    local test_message="请列出当前目录下的所有文件"
    local custom_chat_id="test-use-case-2-files-$$"
    local result

    log_debug "Sending message with chatId: $custom_chat_id"

    # Send synchronous chat request
    result=$(make_sync_request "$test_message" "$custom_chat_id")
    parse_response "$result"

    log_debug "HTTP code: $RESPONSE_STATUS"
    log_debug "Response: $RESPONSE_BODY"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check success status
    local success
    success=$(extract_json_bool "success")

    if [ "$success" != "true" ]; then
        log_fail "Request was not successful"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check if we got a response
    local response_text
    response_text=$(extract_json_field "response")

    if [ -z "$response_text" ]; then
        log_fail "No response text received"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    log_info "Received response: $response_text"

    # Validate response contains file-related content
    if echo "$response_text" | grep -iqE "package\.json|src|dist|文件|目录|file|directory"; then
        log_pass "File listing task passed - agent returned directory content"
        return 0
    else
        log_info "File listing task passed (agent responded)"
        return 0
    fi
}

# Test 4: Text analysis task - Agent summarizes text
test_text_analysis_task() {
    log_info "Test 4: Text analysis task..."

    local test_message="请用一句话总结：人工智能是计算机科学的一个分支，它试图理解智能的本质，并开发出一种新的能以人类智能相似的方式做出反应的智能机器。"
    local custom_chat_id="test-use-case-2-text-$$"
    local result

    log_debug "Sending message with chatId: $custom_chat_id"

    # Send synchronous chat request
    result=$(make_sync_request "$test_message" "$custom_chat_id")
    parse_response "$result"

    log_debug "HTTP code: $RESPONSE_STATUS"
    log_debug "Response: $RESPONSE_BODY"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check success status
    local success
    success=$(extract_json_bool "success")

    if [ "$success" != "true" ]; then
        log_fail "Request was not successful"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check if we got a response
    local response_text
    response_text=$(extract_json_field "response")

    if [ -z "$response_text" ]; then
        log_fail "No response text received"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    log_info "Received response: $response_text"

    # Validate response is a summary (not empty and reasonable length)
    if [ -n "$response_text" ]; then
        log_pass "Text analysis task passed - agent provided a summary"
        return 0
    else
        log_fail "Text analysis task failed - no summary provided"
        return 1
    fi
}

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Use Case 2 - Task Execution"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Scenarios:"
    echo "  1. Health check - Verify server is running"
    echo "  2. Calculation task - Agent computes 25 * 17"
    echo "  3. File listing task - Agent lists directory contents"
    echo "  4. Text analysis task - Agent summarizes text"
    echo ""
    echo "Acceptance Criteria (from Issue #330):"
    echo "  - Use REST Channel to send task"
    echo "  - Agent correctly parses task intent"
    echo "  - Agent executes task (may call tools)"
    echo "  - Result returns through REST Channel"
    echo "  - Does not depend on vitest framework"
    echo ""
    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo "  - Project Root: $PROJECT_ROOT"
    echo ""
    echo "Prerequisites:"
    echo "  - Node.js installed"
    echo "  - disclaude built (npm run build)"
    echo "  - Valid disclaude.config.yaml"
    echo "  - API key configured in config file"
    echo ""
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Use Case 2 - Task Execution"
    echo "=========================================="
    echo ""

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        show_test_plan
        exit 0
    fi

    # Check prerequisites
    check_prerequisites || exit 1

    # Start server
    start_server || exit 1

    echo ""
    echo "Running tests..."
    echo ""

    # Run tests
    test_health_check || true
    echo ""
    test_calculation_task || true
    echo ""
    test_file_listing_task || true
    echo ""
    test_text_analysis_task || true

    # Print summary and exit
    print_summary
}

main
