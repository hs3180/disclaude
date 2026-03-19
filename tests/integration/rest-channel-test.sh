#!/bin/bash
#
# Integration Test: REST Channel Basic Tests
#
# Tests REST Channel functionality without requiring a full Agent setup:
# - Health check, chat, error handling, unknown routes
#
# Usage:
#   ./tests/integration/rest-channel-test.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 30)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
HOST="${HOST:-127.0.0.1}"
TIMEOUT="${TIMEOUT:-30}"
CONFIG_PATH="${DISCLAUDE_CONFIG:-}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

test_health_check() {
    log_info "Testing: GET /api/health"

    local result
    result=$(make_request "GET" "/api/health")
    parse_response "$result"

    assert_status "200" "Health check" || return 1
    assert_body_contains '"status":"ok"' "Health check body" || return 1
}

test_chat_valid_request() {
    log_info "Testing: POST /api/chat with valid message"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"test message"}')
    parse_response "$result"

    assert_status "200" "Chat valid request" || return 1
    assert_body_contains '"success":true' "Chat success field" || return 1
    assert_body_contains '"messageId"' "Chat messageId field" || return 1
    assert_body_contains '"chatId"' "Chat chatId field" || return 1
}

test_chat_missing_message() {
    log_info "Testing: POST /api/chat with missing message"

    local result
    result=$(make_request "POST" "/api/chat" '{}')
    parse_response "$result"

    assert_status "400" "Chat missing message" || return 1
    assert_body_contains '"error"' "Chat missing message error" || return 1
}

# Raw curl for invalid JSON (tests non-JSON input path)
test_chat_invalid_json() {
    log_info "Testing: POST /api/chat with invalid JSON"

    local response status
    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${API_URL}/api/chat" \
        -H "Content-Type: application/json" \
        -d "not valid json" \
        --max-time "$TIMEOUT" 2>&1)
    status=$(echo "$response" | tail -n 1)

    if [ "$status" = "400" ]; then
        log_pass "Chat rejects invalid JSON with 400"
    else
        log_fail "Chat returned status $status (expected 400)"
    fi
}

test_chat_custom_chatid() {
    log_info "Testing: POST /api/chat with custom chatId"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"test","chatId":"custom-test-id-123"}')
    parse_response "$result"

    assert_status "200" "Chat custom chatId" || return 1
    assert_body_contains '"chatId":"custom-test-id-123"' "Custom chatId preserved" || return 1
}

test_unknown_route() {
    log_info "Testing: 404 for unknown routes"

    local result
    result=$(make_request "GET" "/unknown/path")
    parse_response "$result"

    assert_status "404" "Unknown route" || return 1
}

test_control_missing_fields() {
    log_info "Testing: POST /api/control with missing fields"

    local result
    result=$(make_request "POST" "/api/control" '{"type":"reset"}')
    parse_response "$result"

    assert_status "400" "Control missing chatId" || return 1
}

# Raw curl for empty body (tests missing body path)
test_empty_body() {
    log_info "Testing: POST /api/chat with empty body"

    local response status
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
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify /api/health endpoint"
declare_test "Chat valid request" test_chat_valid_request "fast" "Test message submission"
declare_test "Chat missing message" test_chat_missing_message "fast" "Error handling (400)"
declare_test "Chat invalid JSON" test_chat_invalid_json "fast" "Error handling (400)"
declare_test "Custom chatId" test_chat_custom_chatid "fast" "Verify chatId preservation"
declare_test "Unknown route 404" test_unknown_route "fast" "Test 404 response"
declare_test "Control missing fields" test_control_missing_fields "fast" "Error handling (400)"
declare_test "Empty body" test_empty_body "fast" "Error handling (400)"

main_test_suite "REST Channel Integration Tests"
