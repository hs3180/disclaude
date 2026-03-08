#!/bin/bash
#
# Integration Test: REST Channel Basic Tests
#
# This script tests the REST Channel functionality without requiring
# a full Agent setup. It tests:
# - Health check endpoint
# - Chat endpoint (async mode)
# - Error handling
# - CORS support
#
# Usage:
#   ./tests/integration/rest-channel-test.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 180)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#
# Environment variables:
#   DISCLAUDE_CONFIG - Path to config file (passed to --config)
#

set -e

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set defaults before sourcing common.sh
REST_PORT="${REST_PORT:-3099}"
HOST="${HOST:-127.0.0.1}"
TIMEOUT="${TIMEOUT:-180}"
CONFIG_PATH="${DISCLAUDE_CONFIG:-}"

# Source common functions
source "$SCRIPT_DIR/common.sh"

# Parse common arguments
parse_common_args "$@"

# Register cleanup handler
register_cleanup

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  REST Channel Integration Tests"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Scenarios:"
    echo "  1. Health check - Verify /api/health endpoint"
    echo "  2. Chat valid request - Test message submission"
    echo "  3. Chat missing message - Error handling (400)"
    echo "  4. Chat invalid JSON - Error handling (400)"
    echo "  5. Custom chatId - Verify chatId preservation"
    echo "  6. CORS headers - Verify CORS support"
    echo "  7. OPTIONS preflight - Test CORS preflight"
    echo "  8. Unknown route - Test 404 response"
    echo "  9. Control missing fields - Error handling (400)"
    echo "  10. Empty body - Error handling (400)"
    echo ""
    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo "  - Project Root: $PROJECT_ROOT"
    if [ -n "$CONFIG_PATH" ]; then
        echo "  - Config: ${CONFIG_PATH}"
    fi
    echo ""
}

# =============================================================================
# Test Functions
# =============================================================================

# Test 2: Chat Endpoint - Valid Request (Async Mode)
test_chat_valid_request() {
    log_info "Testing: POST /api/chat with valid message"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"test message"}')
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "200" ]; then
        if echo "$RESPONSE_BODY" | grep -q '"success":true' && \
           echo "$RESPONSE_BODY" | grep -q '"messageId"' && \
           echo "$RESPONSE_BODY" | grep -q '"chatId"'; then
            log_pass "Chat endpoint accepts valid request and returns expected fields"
        else
            log_fail "Chat endpoint returned 200 but missing required fields"
        fi
    else
        log_fail "Chat endpoint returned status $RESPONSE_STATUS (expected 200)"
    fi
}

# Test 3: Chat Endpoint - Missing Message
test_chat_missing_message() {
    log_info "Testing: POST /api/chat with missing message"

    local result
    result=$(make_request "POST" "/api/chat" '{}')
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "400" ]; then
        if echo "$RESPONSE_BODY" | grep -q '"error"'; then
            log_pass "Chat endpoint rejects missing message with 400"
        else
            log_fail "Chat endpoint returned 400 but missing error message"
        fi
    else
        log_fail "Chat endpoint returned status $RESPONSE_STATUS (expected 400)"
    fi
}

# Test 4: Chat Endpoint - Invalid JSON
test_chat_invalid_json() {
    log_info "Testing: POST /api/chat with invalid JSON"

    local response
    local status

    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${API_URL}/api/chat" \
        -H "Content-Type: application/json" \
        -d "not valid json" \
        --max-time "$TIMEOUT" 2>&1)

    status=$(echo "$response" | tail -n 1)

    if [ "$status" = "400" ]; then
        log_pass "Chat endpoint rejects invalid JSON with 400"
    else
        log_fail "Chat endpoint returned status $status (expected 400)"
    fi
}

# Test 5: Custom ChatId
test_chat_custom_chatid() {
    log_info "Testing: POST /api/chat with custom chatId"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"test","chatId":"custom-test-id-123"}')
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "200" ]; then
        if echo "$RESPONSE_BODY" | grep -q '"chatId":"custom-test-id-123"'; then
            log_pass "Chat endpoint preserves custom chatId"
        else
            log_fail "Chat endpoint did not preserve custom chatId"
        fi
    else
        log_fail "Chat endpoint returned status $RESPONSE_STATUS (expected 200)"
    fi
}

# Test 6: CORS Headers
test_cors_headers() {
    log_info "Testing: CORS headers present"

    local response
    local cors_header

    response=$(curl -s -I "${API_URL}/api/health" --max-time "$TIMEOUT" 2>&1)
    cors_header=$(echo "$response" | grep -i "access-control-allow-origin" || true)

    if [ -n "$cors_header" ]; then
        log_pass "CORS headers are present"
    else
        log_fail "CORS headers are missing"
    fi
}

# Test 7: OPTIONS Preflight
test_options_preflight() {
    log_info "Testing: OPTIONS preflight request"

    local result
    result=$(make_request "OPTIONS" "/api/chat")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "204" ]; then
        log_pass "OPTIONS preflight returns 204"
    else
        log_fail "OPTIONS preflight returned status $RESPONSE_STATUS (expected 204)"
    fi
}

# Test 8: 404 for Unknown Routes
test_unknown_route() {
    log_info "Testing: 404 for unknown routes"

    local result
    result=$(make_request "GET" "/unknown/path")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "404" ]; then
        log_pass "Unknown route returns 404"
    else
        log_fail "Unknown route returned status $RESPONSE_STATUS (expected 404)"
    fi
}

# Test 9: Control Endpoint - Missing Required Fields
test_control_missing_fields() {
    log_info "Testing: POST /api/control with missing fields"

    local result
    result=$(make_request "POST" "/api/control" '{"type":"reset"}')
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "400" ]; then
        log_pass "Control endpoint rejects missing chatId with 400"
    else
        log_fail "Control endpoint returned status $RESPONSE_STATUS (expected 400)"
    fi
}

# Test 10: Empty Request Body
test_empty_body() {
    log_info "Testing: POST /api/chat with empty body"

    local response
    local status

    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${API_URL}/api/chat" \
        -H "Content-Type: application/json" \
        --max-time "$TIMEOUT" 2>&1)

    status=$(echo "$response" | tail -n 1)

    if [ "$status" = "400" ]; then
        log_pass "Empty body returns 400"
    else
        log_fail "Empty body returned status $status (expected 400)"
    fi
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  REST Channel Integration Tests"
    echo "=========================================="
    echo ""

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        show_test_plan
        exit 0
    fi

    echo "API URL: ${API_URL}"
    echo "Timeout: ${TIMEOUT}s"
    if [ -n "$CONFIG_PATH" ]; then
        echo "Config: ${CONFIG_PATH}"
    fi
    echo ""

    # Start server if not already running
    log_info "Checking if REST server is running..."
    if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
        log_info "Server is already running"
    else
        log_info "Server not running, starting automatically..."
        if ! start_server; then
            exit 1
        fi
    fi
    echo ""

    # Run tests
    echo "Running tests..."
    echo ""

    test_health_check || true
    test_chat_valid_request || true
    test_chat_missing_message || true
    test_chat_invalid_json || true
    test_chat_custom_chatid || true
    test_cors_headers || true
    test_options_preflight || true
    test_unknown_route || true
    test_control_missing_fields || true
    test_empty_body || true

    # Print summary and exit
    print_summary
}

main
