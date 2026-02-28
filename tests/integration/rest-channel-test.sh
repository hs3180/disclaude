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
#   ./tests/integration/rest-channel-test.sh
#
# Environment variables:
#   DISCLAUDE_CONFIG - Path to config file (passed to --config)
#   REST_PORT        - REST API port (default: 3099)
#   HOST             - Test server host (default: 127.0.0.1)
#   TIMEOUT          - Request timeout in seconds (default: 10)
#   START_SERVER     - Set to 'true' to auto-start server (default: false)
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed
#

set -e

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
HOST="${HOST:-127.0.0.1}"
API_URL="http://${HOST}:${REST_PORT}"
TIMEOUT=10
CONFIG_PATH="${DISCLAUDE_CONFIG:-}"
START_SERVER="${START_SERVER:-false}"
SERVER_PID=""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0

# =============================================================================
# Helper Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_pass() {
    echo -e "${GREEN}[PASS]${NC} $1"
    TESTS_PASSED=$((TESTS_PASSED + 1))
}

log_fail() {
    echo -e "${RED}[FAIL]${NC} $1"
    TESTS_FAILED=$((TESTS_FAILED + 1))
}

log_skip() {
    echo -e "${YELLOW}[SKIP]${NC} $1"
}

# Start the test server
start_server() {
    log_info "Starting test server..."

    cd "$PROJECT_ROOT"

    # Build config argument if provided
    local config_arg=""
    if [ -n "$CONFIG_PATH" ]; then
        config_arg="--config ${CONFIG_PATH}"
        log_info "Using config file: ${CONFIG_PATH}"
    fi

    # Start server in background
    node dist/cli-entry.js start --mode primary --rest-port ${REST_PORT} --host ${HOST} ${config_arg} > /tmp/disclaude-test-server.log 2>&1 &
    SERVER_PID=$!

    # Wait for server to be ready
    log_info "Waiting for server to be ready..."
    local max_retries=30
    local retry=0
    while [ $retry -lt $max_retries ]; do
        if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
            log_info "Server is ready (PID: ${SERVER_PID})"
            return 0
        fi
        sleep 1
        retry=$((retry + 1))
    done

    log_fail "Server failed to start within ${max_retries} seconds"
    show_server_logs
    return 1
}

# Stop the test server
stop_server() {
    if [ -n "$SERVER_PID" ]; then
        log_info "Stopping test server (PID: ${SERVER_PID})..."
        kill $SERVER_PID 2>/dev/null || true
        wait $SERVER_PID 2>/dev/null || true
        SERVER_PID=""
    fi
}

# Show server logs for debugging
show_server_logs() {
    if [ -f /tmp/disclaude-test-server.log ]; then
        echo ""
        echo "Server logs:"
        echo "----------------------------------------"
        tail -50 /tmp/disclaude-test-server.log
        echo "----------------------------------------"
    fi
}

# Cleanup on exit
cleanup() {
    stop_server
}

# Register cleanup handler
trap cleanup EXIT

# Make HTTP request and return status code and body
make_request() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    local headers="${4:-}"

    local response
    local status

    if [ -n "$body" ]; then
        response=$(curl -s -w "\n%{http_code}" \
            -X "$method" \
            "${API_URL}${path}" \
            -H "Content-Type: application/json" \
            ${headers:+-H "$headers"} \
            -d "$body" \
            --max-time "$TIMEOUT" 2>&1)
    else
        response=$(curl -s -w "\n%{http_code}" \
            -X "$method" \
            "${API_URL}${path}" \
            ${headers:+-H "$headers"} \
            --max-time "$TIMEOUT" 2>&1)
    fi

    status=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | sed '$d')

    echo "$status|$body"
}

# =============================================================================
# Test Functions
# =============================================================================

# Test 1: Health Check Endpoint
test_health_check() {
    log_info "Testing: GET /api/health"

    local result
    result=$(make_request "GET" "/api/health")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "200" ]; then
        if echo "$body" | grep -q '"status":"ok"'; then
            log_pass "Health check returns 200 with status: ok"
        else
            log_fail "Health check returned 200 but body missing status: ok"
        fi
    else
        log_fail "Health check returned status $status (expected 200)"
    fi
}

# Test 2: Chat Endpoint - Valid Request (Async Mode)
test_chat_valid_request() {
    log_info "Testing: POST /api/chat with valid message"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"test message"}')

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "200" ]; then
        if echo "$body" | grep -q '"success":true' && \
           echo "$body" | grep -q '"messageId"' && \
           echo "$body" | grep -q '"chatId"'; then
            log_pass "Chat endpoint accepts valid request and returns expected fields"
        else
            log_fail "Chat endpoint returned 200 but missing required fields"
        fi
    else
        log_fail "Chat endpoint returned status $status (expected 200)"
    fi
}

# Test 3: Chat Endpoint - Missing Message
test_chat_missing_message() {
    log_info "Testing: POST /api/chat with missing message"

    local result
    result=$(make_request "POST" "/api/chat" '{}')

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "400" ]; then
        if echo "$body" | grep -q '"error"'; then
            log_pass "Chat endpoint rejects missing message with 400"
        else
            log_fail "Chat endpoint returned 400 but missing error message"
        fi
    else
        log_fail "Chat endpoint returned status $status (expected 400)"
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

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "200" ]; then
        if echo "$body" | grep -q '"chatId":"custom-test-id-123"'; then
            log_pass "Chat endpoint preserves custom chatId"
        else
            log_fail "Chat endpoint did not preserve custom chatId"
        fi
    else
        log_fail "Chat endpoint returned status $status (expected 200)"
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

    local status="${result%%|*}"

    if [ "$status" = "204" ]; then
        log_pass "OPTIONS preflight returns 204"
    else
        log_fail "OPTIONS preflight returned status $status (expected 204)"
    fi
}

# Test 8: 404 for Unknown Routes
test_unknown_route() {
    log_info "Testing: 404 for unknown routes"

    local result
    result=$(make_request "GET" "/unknown/path")

    local status="${result%%|*}"

    if [ "$status" = "404" ]; then
        log_pass "Unknown route returns 404"
    else
        log_fail "Unknown route returned status $status (expected 404)"
    fi
}

# Test 9: Control Endpoint - Missing Required Fields
test_control_missing_fields() {
    log_info "Testing: POST /api/control with missing fields"

    local result
    result=$(make_request "POST" "/api/control" '{"type":"reset"}')

    local status="${result%%|*}"

    if [ "$status" = "400" ]; then
        log_pass "Control endpoint rejects missing chatId with 400"
    else
        log_fail "Control endpoint returned status $status (expected 400)"
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
    echo "=============================================="
    echo "  REST Channel Integration Tests"
    echo "=============================================="
    echo ""
    echo "API URL: ${API_URL}"
    echo "Timeout: ${TIMEOUT}s"
    if [ -n "$CONFIG_PATH" ]; then
        echo "Config: ${CONFIG_PATH}"
    fi
    echo ""

    # Check if server is running or should be started
    log_info "Checking if REST server is running..."
    if ! curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
        if [ "$START_SERVER" = "true" ]; then
            log_info "Server not running, starting automatically..."
            if ! start_server; then
                exit 1
            fi
        else
            echo ""
            echo -e "${RED}Error: REST server is not running at ${API_URL}${NC}"
            echo ""
            echo "Please start the server first:"
            echo "  npm run build"
            echo "  node dist/cli-entry.js start --mode primary --rest-port ${REST_PORT}"
            if [ -n "$CONFIG_PATH" ]; then
                echo "  # Or with custom config:"
                echo "  node dist/cli-entry.js start --mode primary --rest-port ${REST_PORT} --config ${CONFIG_PATH}"
            fi
            echo ""
            echo "Or set START_SERVER=true to auto-start the server:"
            echo "  START_SERVER=true ./tests/integration/rest-channel-test.sh"
            echo ""
            exit 1
        fi
    else
        log_info "Server is already running"
    fi
    echo ""

    # Run tests
    echo "Running tests..."
    echo ""

    test_health_check
    test_chat_valid_request
    test_chat_missing_message
    test_chat_invalid_json
    test_chat_custom_chatid
    test_cors_headers
    test_options_preflight
    test_unknown_route
    test_control_missing_fields
    test_empty_body

    # Summary
    echo ""
    echo "=============================================="
    echo "  Test Summary"
    echo "=============================================="
    echo ""
    echo -e "  ${GREEN}Passed: ${TESTS_PASSED}${NC}"
    echo -e "  ${RED}Failed: ${TESTS_FAILED}${NC}"
    echo ""

    if [ "$TESTS_FAILED" -gt 0 ]; then
        if [ "$START_SERVER" = "true" ]; then
            show_server_logs
        fi
        exit 1
    fi

    exit 0
}

main "$@"
