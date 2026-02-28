#!/bin/bash
#
# Common functions for integration tests
#
# This file provides shared functionality for integration tests:
# - Server lifecycle management
# - HTTP request helpers
# - Logging utilities
# - Test counters
#
# Usage:
#   source tests/integration/common.sh
#
# Required variables after sourcing:
#   PROJECT_ROOT - Path to project root directory
#
# Optional variables (defaults provided):
#   REST_PORT    - REST API port (default: 3099)
#   HOST         - Test server host (default: 127.0.0.1)
#   TIMEOUT      - Request timeout in seconds (default: 10)
#   CONFIG_PATH  - Path to config file (optional)
#

# Prevent multiple sourcing
if [ -n "$_COMMON_SH_LOADED" ]; then
    return 0
fi
_COMMON_SH_LOADED=1

# =============================================================================
# Default Configuration
# =============================================================================
REST_PORT="${REST_PORT:-3099}"
HOST="${HOST:-127.0.0.1}"
API_URL="http://${HOST}:${REST_PORT}"
# Timeout for API requests - increased to 60s for AI processing
TIMEOUT="${TIMEOUT:-30}"
# Default to test config file for integration tests (no MCP servers)
CONFIG_PATH="${CONFIG_PATH:-${PROJECT_ROOT}/disclaude.config.test.yaml}"
SERVER_PID=""

# Log file in current working directory
SERVER_LOG="disclaude-test-server.log"

# =============================================================================
# Colors for Output
# =============================================================================
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# =============================================================================
# Test Counters
# =============================================================================
TESTS_PASSED=0
TESTS_FAILED=0

# =============================================================================
# Logging Functions
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

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_debug() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${BLUE}[DEBUG]${NC} $1"
    fi
}

# =============================================================================
# Server Management Functions
# =============================================================================

# Check if a port is in use
# Returns: 0 if port is in use, 1 if port is free
is_port_in_use() {
    local port="$1"
    if command -v lsof &> /dev/null; then
        lsof -i:"$port" -sTCP:LISTEN > /dev/null 2>&1
    elif command -v ss &> /dev/null; then
        ss -tln | grep -q ":${port} "
    elif command -v netstat &> /dev/null; then
        netstat -tln | grep -q ":${port} "
    else
        # Fallback: try to connect
        curl -s "http://${HOST}:${port}/api/health" > /dev/null 2>&1
    fi
}

# Check if server is already running on the target port
# Returns: 0 if server is running and healthy, 1 otherwise
is_server_running() {
    curl -s "${API_URL}/api/health" > /dev/null 2>&1
}

# Wait for port to be released
# Returns: 0 if port is released, 1 if timeout
wait_for_port_release() {
    local port="$1"
    local max_retries="${2:-10}"
    local retry=0

    while [ $retry -lt $max_retries ]; do
        if ! is_port_in_use "$port"; then
            log_debug "Port $port is now free"
            return 0
        fi
        sleep 1
        retry=$((retry + 1))
        log_debug "Waiting for port $port to be released... ($retry/$max_retries)"
    done

    log_warn "Port $port still in use after ${max_retries} seconds"
    return 1
}

# Start the test server
# Returns: 0 on success, 1 on failure
start_server() {
    log_info "Starting test server on port ${REST_PORT}..."

    # Check if server is already running and healthy
    if is_server_running; then
        log_info "Server already running on port ${REST_PORT}, reusing existing server"
        SERVER_PID=""
        return 0
    fi

    # Wait for port to be released if it's in use but server is not healthy
    if is_port_in_use "$REST_PORT"; then
        log_warn "Port ${REST_PORT} is in use but server is not healthy, waiting for release..."
        if ! wait_for_port_release "$REST_PORT" 15; then
            log_error "Port ${REST_PORT} is still in use, cannot start server"
            # Try to kill any process using the port
            if command -v lsof &> /dev/null; then
                local pid_using_port
                pid_using_port=$(lsof -t -i:"$REST_PORT" 2>/dev/null | head -1)
                if [ -n "$pid_using_port" ]; then
                    log_warn "Killing process $pid_using_port using port ${REST_PORT}"
                    kill -9 "$pid_using_port" 2>/dev/null || true
                    sleep 2
                fi
            fi
        fi
    fi

    cd "$PROJECT_ROOT"

    # Build config argument if provided
    local config_arg=""
    if [ -n "$CONFIG_PATH" ]; then
        config_arg="--config ${CONFIG_PATH}"
        log_info "Using config file: ${CONFIG_PATH}"
    fi

    # Start server in background
    node dist/cli-entry.js start --mode primary --rest-port "${REST_PORT}" --host "${HOST}" ${config_arg} > "${SERVER_LOG}" 2>&1 &
    SERVER_PID=$!

    log_debug "Server PID: ${SERVER_PID}"

    # Wait for server to be ready
    local max_retries=30
    local retry=0
    while [ $retry -lt $max_retries ]; do
        if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
            log_info "Server is ready"
            return 0
        fi
        sleep 1
        retry=$((retry + 1))
        log_debug "Waiting for server... ($retry/$max_retries)"
    done

    log_error "Server failed to start within ${max_retries} seconds"
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

        # Wait for port to be released
        wait_for_port_release "$REST_PORT" 10 || true
    fi
}

# Show server logs for debugging
show_server_logs() {
    if [ -f "${SERVER_LOG}" ]; then
        echo ""
        echo "Server logs (${SERVER_LOG}):"
        echo "----------------------------------------"
        tail -50 "${SERVER_LOG}"
        echo "----------------------------------------"
    fi
}

# Cleanup function - should be called via trap
cleanup() {
    log_info "Cleaning up..."
    stop_server
}

# Register cleanup handler (call this in your test script)
register_cleanup() {
    trap cleanup EXIT
}

# =============================================================================
# HTTP Request Helpers
# =============================================================================

# Make HTTP request and return status code and body
# Usage: result=$(make_request "METHOD" "/path" '{"body": "data"}' "Header: value")
# Returns: "status_code|response_body"
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

# Make synchronous chat request (waits for agent response)
# Usage: result=$(make_sync_request "message" "chatId")
# Returns: "status_code|response_body"
make_sync_request() {
    local message="$1"
    local chatId="${2:-}"
    local body

    if [ -n "$chatId" ]; then
        body="{\"message\": \"$message\", \"chatId\": \"$chatId\"}"
    else
        body="{\"message\": \"$message\"}"
    fi

    make_request "POST" "/api/chat/sync" "$body"
}

# =============================================================================
# Prerequisite Checks
# =============================================================================

# Check if Node.js is installed
check_node() {
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        return 1
    fi
    log_debug "Node.js: $(node --version)"
    return 0
}

# Check if curl is installed
check_curl() {
    if ! command -v curl &> /dev/null; then
        log_error "curl is not installed"
        return 1
    fi
    return 0
}

# Check if project is built
check_build() {
    if [ ! -d "$PROJECT_ROOT/dist" ]; then
        log_error "Project not built. Run 'npm run build' first."
        return 1
    fi
    return 0
}

# Check if configuration file exists
check_config() {
    if [ ! -f "$PROJECT_ROOT/disclaude.config.yaml" ]; then
        log_error "Configuration file not found: $PROJECT_ROOT/disclaude.config.yaml"
        log_error "Please create a configuration file with AI provider settings."
        return 1
    fi
    return 0
}

# Run all prerequisite checks
check_prerequisites() {
    log_info "Checking prerequisites..."

    check_node || return 1
    check_curl || return 1
    check_build || return 1
    check_config || return 1

    log_info "Prerequisites OK"
    return 0
}

# =============================================================================
# Response Parsing Helpers
# =============================================================================

# Global variables for parsed response
RESPONSE_STATUS=""
RESPONSE_BODY=""

# Parse response from make_request format "status|body"
# Usage: parse_response "result"
# Sets: RESPONSE_STATUS, RESPONSE_BODY
parse_response() {
    local result="$1"
    RESPONSE_STATUS="${result%%|*}"
    RESPONSE_BODY="${result#*|}"
}

# Assert HTTP status code equals expected
# Usage: assert_status "expected_status" "test_name"
assert_status() {
    local expected="$1"
    local test_name="${2:-status check}"

    if [ "$RESPONSE_STATUS" = "$expected" ]; then
        log_pass "$test_name: status is $expected"
        return 0
    else
        log_fail "$test_name: expected status $expected, got $RESPONSE_STATUS"
        return 1
    fi
}

# Assert JSON body contains a string
# Usage: assert_body_contains "pattern" "test_name"
assert_body_contains() {
    local pattern="$1"
    local test_name="${2:-body check}"

    if echo "$RESPONSE_BODY" | grep -q "$pattern"; then
        log_pass "$test_name: body contains '$pattern'"
        return 0
    else
        log_fail "$test_name: body does not contain '$pattern'"
        log_debug "Body: $RESPONSE_BODY"
        return 1
    fi
}

# Extract JSON field value using grep (simple extraction)
# Usage: value=$(extract_json_field "fieldName")
extract_json_field() {
    local field="$1"
    echo "$RESPONSE_BODY" | grep -o "\"$field\":\"[^\"]*\"" | cut -d'"' -f4
}

# Extract JSON boolean field
# Usage: value=$(extract_json_bool "fieldName")
extract_json_bool() {
    local field="$1"
    echo "$RESPONSE_BODY" | grep -o "\"$field\":[^,}]*" | cut -d':' -f2 | tr -d ' '
}

# =============================================================================
# Common Test Functions
# =============================================================================

# Test health check endpoint - shared by all integration tests
# Usage: test_health_check
test_health_check() {
    log_info "Testing: GET /api/health"

    local result
    result=$(make_request "GET" "/api/health")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "200" ] && echo "$RESPONSE_BODY" | grep -q '"status":"ok"'; then
        log_pass "Health check returns 200 with status: ok"
        return 0
    else
        log_fail "Health check returned status $RESPONSE_STATUS (expected 200)"
        return 1
    fi
}

# =============================================================================
# Argument Parsing Helpers
# =============================================================================

# Common argument parser for integration tests
# Sets: VERBOSE, DRY_RUN, TIMEOUT, REST_PORT
# Usage: parse_common_args "$@"
parse_common_args() {
    VERBOSE=false
    DRY_RUN=false

    while [[ $# -gt 0 ]]; do
        case $1 in
            --timeout)
                TIMEOUT="$2"
                shift 2
                ;;
            --port)
                REST_PORT="$2"
                shift 2
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --dry-run)
                DRY_RUN=true
                shift
                ;;
            --help|-h)
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --timeout SECONDS   Request timeout (default: ${TIMEOUT:-30})"
                echo "  --port PORT         REST API port (default: ${REST_PORT:-3099})"
                echo "  --verbose           Enable verbose output"
                echo "  --dry-run           Show test plan without executing"
                echo "  --help, -h          Show this help message"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                echo "Use --help for usage information"
                exit 1
                ;;
        esac
    done
}

# =============================================================================
# Test Summary
# =============================================================================

# Print test summary and exit with appropriate code
print_summary() {
    echo ""
    echo "=========================================="

    if [ $TESTS_FAILED -eq 0 ]; then
        log_info "All tests passed! ($TESTS_PASSED/$TESTS_PASSED)"
        echo "=========================================="
        exit 0
    else
        log_error "$TESTS_FAILED test(s) failed"
        echo "=========================================="
        show_server_logs
        exit 1
    fi
}
