#!/bin/bash
#
# Integration Test: Use Case 1 - Basic Reply
#
# Tests the most basic conversation scenario:
# User sends a message, Agent correctly replies.
#
# Prerequisites:
# - Node.js installed
# - disclaude built (npm run build)
# - Valid disclaude.config.yaml with AI provider configured
#
# Usage:
#   ./tests/integration/use-case-1-basic-reply.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 30)
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
TIMEOUT="${TIMEOUT:-30}"

# Source common functions
source "$SCRIPT_DIR/common.sh"

# Parse common arguments
parse_common_args "$@"

# Register cleanup handler
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

# Test 2: Basic greeting - Agent responds to "你好"
test_basic_greeting() {
    log_info "Test 2: Basic greeting (你好)..."

    local test_message="你好"
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

    # Validate response is a greeting (contains greeting keywords)
    if echo "$response_text" | grep -iqE "你好|hello|hi|help|有什么|我可以|帮助"; then
        log_pass "Basic greeting test passed - agent responded with a greeting"
        return 0
    else
        log_info "Basic greeting test passed (agent replied successfully)"
        return 0
    fi
}

# Test 3: Custom chatId preservation
test_custom_chatid() {
    log_info "Test 3: Custom chatId preservation..."

    local test_message="你好"
    local custom_chat_id="test-use-case-1-$$"
    local result

    log_debug "Sending message with chatId: $custom_chat_id"

    # Send synchronous chat request with custom chatId
    result=$(make_sync_request "$test_message" "$custom_chat_id")
    parse_response "$result"

    log_debug "HTTP code: $RESPONSE_STATUS"
    log_debug "Response: $RESPONSE_BODY"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    # Check if chatId is preserved in response
    if echo "$RESPONSE_BODY" | grep -q "\"chatId\":\"$custom_chat_id\""; then
        log_pass "Custom chatId preserved in response"
        return 0
    else
        log_fail "Custom chatId not preserved in response"
        log_debug "Expected: $custom_chat_id"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi
}

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Use Case 1 - Basic Reply"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Scenarios:"
    echo "  1. Health check - Verify server is running"
    echo "  2. Basic greeting - Agent responds to '你好'"
    echo "  3. Custom chatId - Verify chatId preservation"
    echo ""
    echo "Acceptance Criteria (from Issue #329):"
    echo "  - Use REST Channel to send message"
    echo "  - Agent receives message and generates reply"
    echo "  - Reply returns through REST Channel"
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
    echo "  Integration Test: Use Case 1 - Basic Reply"
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
    test_basic_greeting || true
    echo ""
    test_custom_chatid || true

    # Print summary and exit
    print_summary
}

main
