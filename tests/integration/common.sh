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
# Timeout for API requests - increased to 120s for AI processing with MCP tool calls
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

    # Start server in background (using new primary-node CLI)
    # Note: Port and host are read from config file (channels.rest.port, channels.rest.host)
    node packages/primary-node/dist/cli.js start ${config_arg} > "${SERVER_LOG}" 2>&1 &
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
# Note: Returns "000" status when curl fails to connect (timeout, connection refused, etc.)
# Use make_request_with_error for detailed error information.
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
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" 2>&1)
    else
        response=$(curl -s -w "\n%{http_code}" \
            -X "$method" \
            "${API_URL}${path}" \
            ${headers:+-H "$headers"} \
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" 2>&1)
    fi

    status=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | sed '$d')

    echo "$status|$body"
}

# Make HTTP request with detailed error information
# Usage: result=$(make_request_with_error "METHOD" "/path" '{"body": "data"}' "Header: value")
# Returns: "status_code|error_type|error_message|response_body"
# Error types: SUCCESS, CONNECTION_TIMEOUT, CONNECTION_REFUSED, DNS_ERROR, SSL_ERROR, HTTP_ERROR, NETWORK_ERROR
# Example error output: "000|CONNECTION_REFUSED|Failed to connect to 127.0.0.1:3099|"
make_request_with_error() {
    local method="$1"
    local path="$2"
    local body="${3:-}"
    local headers="${4:-}"

    local response
    local status
    local curl_exit_code
    local curl_error_file
    local error_type="SUCCESS"
    local error_msg=""
    local time_info=""

    curl_error_file=$(mktemp)

    if [ -n "$body" ]; then
        response=$(curl -s -w "\n%{http_code}|%{time_total}|%{errormsg}" \
            -X "$method" \
            "${API_URL}${path}" \
            -H "Content-Type: application/json" \
            ${headers:+-H "$headers"} \
            -d "$body" \
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" \
            -o "$curl_error_file" 2>&1)
        curl_exit_code=$?
    else
        response=$(curl -s -w "\n%{http_code}|%{time_total}|%{errormsg}" \
            -X "$method" \
            "${API_URL}${path}" \
            ${headers:+-H "$headers"} \
            --connect-timeout "$TIMEOUT" \
            --max-time "$TIMEOUT" \
            -o "$curl_error_file" 2>&1)
        curl_exit_code=$?
    fi

    # Parse curl output: last line contains "http_code|time_total|errormsg"
    local last_line
    last_line=$(echo "$response" | tail -n 1)
    status=$(echo "$last_line" | cut -d'|' -f1)
    time_info=$(echo "$last_line" | cut -d'|' -f2)
    error_msg=$(echo "$last_line" | cut -d'|' -f3-)
    response=$(echo "$response" | sed '$d')

    # Read response body from temp file (may be empty on error)
    local response_body
    if [ -f "$curl_error_file" ]; then
        response_body=$(cat "$curl_error_file" 2>/dev/null || echo "")
        rm -f "$curl_error_file"
    fi

    # Determine error type based on curl exit code and HTTP status
    if [ "$curl_exit_code" -ne 0 ]; then
        case "$curl_exit_code" in
            6)
                error_type="DNS_ERROR"
                error_msg="Could not resolve host: ${HOST}"
                ;;
            7)
                error_type="CONNECTION_REFUSED"
                error_msg="Failed to connect to ${HOST}:${REST_PORT} (connection refused)"
                ;;
            28)
                error_type="CONNECTION_TIMEOUT"
                error_msg="Connection timed out after ${TIMEOUT}s"
                ;;
            35)
                error_type="SSL_ERROR"
                error_msg="SSL connection error"
                ;;
            *)
                error_type="CURL_ERROR"
                error_msg="curl failed with exit code ${curl_exit_code}: ${error_msg}"
                ;;
        esac
    elif [ "$status" = "000" ]; then
        error_type="NETWORK_ERROR"
        error_msg="No HTTP response received (server crashed or network issue)"
    elif [ "$status" -ge 500 ]; then
        error_type="HTTP_ERROR"
        error_msg="Server returned HTTP ${status}"
    fi

    # Return structured output: status|error_type|error_msg|response_body
    echo "${status}|${error_type}|${error_msg}|${response_body}"
}

# Format error for display (helper for make_request_with_error)
# Usage: format_error "result_from_make_request_with_error"
# Returns: Human-readable error string
format_request_error() {
    local result="$1"
    local status=$(echo "$result" | cut -d'|' -f1)
    local error_type=$(echo "$result" | cut -d'|' -f2)
    local error_msg=$(echo "$result" | cut -d'|' -f3)

    local response_body=$(echo "$result" | cut -d'|' -f4-)

    if [ "$error_type" = "SUCCESS" ]; then
        echo "HTTP ${status}"
    else
        echo "${error_type}: ${error_msg}"
        if [ -n "$response_body" ] && [ "$response_body" != "" ]; then
            echo "  Server response: ${response_body}"
        fi
        echo "  Server log: ${SERVER_LOG}"
    fi
}

# Make synchronous chat request (waits for agent response)
# Usage: result=$(make_sync_request "message" "chatId")
# Returns: "status_code|response_body"
make_sync_request() {
    local message="$1"
    local chatId="${2:-}"
    local body

    if [ -n "$chatId" ]; then
        body=$(jq -n --arg msg "$message" --arg cid "$chatId" '{message: $msg, chatId: $cid}')
    else
        body=$(jq -n --arg msg "$message" '{message: $msg}')
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
# Note: Provides detailed error info when status is 000 (network error)
assert_status() {
    local expected="$1"
    local test_name="${2:-status check}"

    if [ "$RESPONSE_STATUS" = "$expected" ]; then
        log_pass "$test_name: status is $expected"
        return 0
    else
        if [ "$RESPONSE_STATUS" = "000" ]; then
            log_fail "$test_name: Request failed (HTTP 000 - no response received)"
            log_error "  This usually means:"
            log_error "  - Server is not running (check with: curl ${API_URL}/api/health)"
            log_error "  - Connection was refused or timed out"
            log_error "  - Server crashed during request processing"
            log_error "  Server log: ${SERVER_LOG}"
            # Show last few lines of server log for debugging
            if [ -f "${SERVER_LOG}" ]; then
                log_error "  Last server activity:"
                tail -10 "${SERVER_LOG}" | sed 's/^/    /'

                # Issue #3003: Extract timing timeline from server logs
                # Find the most recent chatId from sync requests and show its timeline
                local recent_chatId
                recent_chatId=$(grep -o '"chatId":"[^"]*"' "${SERVER_LOG}" | tail -1 | cut -d'"' -f4)
                if [ -n "$recent_chatId" ]; then
                    log_error "  Request timeline (chatId: ${recent_chatId}):"
                    grep "$recent_chatId" "${SERVER_LOG}" | \
                      grep -E "(Received chat request|processMessage called|Starting SDK query|TTFT|Tool call|Task completed|Sync request completed|timeout|Iterator error)" | \
                      tail -15 | sed 's/^/    /'
                fi
            fi
        else
            log_fail "$test_name: expected status $expected, got $RESPONSE_STATUS"
        fi
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
# Assertion Functions
# =============================================================================

# Assert JSON field equals expected value
# Usage: assert_json_field_equals "field" "value" "test_name"
assert_json_field_equals() {
    local field="$1"
    local expected="$2"
    local test_name="${3:-field check}"
    local actual
    actual=$(extract_json_field "$field")

    if [ "$actual" = "$expected" ]; then
        log_pass "$test_name: $field is '$expected'"
        return 0
    else
        log_fail "$test_name: expected $field='$expected', got '$actual'"
        return 1
    fi
}

# Assert JSON field matches pattern (case-insensitive)
# Usage: assert_json_field_contains "field" "pattern" "test_name"
assert_json_field_contains() {
    local field="$1"
    local pattern="$2"
    local test_name="${3:-field contains}"
    local actual
    actual=$(extract_json_field "$field")

    if echo "$actual" | grep -iqE "$pattern"; then
        log_pass "$test_name: $field matches /$pattern/"
        return 0
    else
        log_fail "$test_name: $field does not match /$pattern/ (got: '$actual')"
        return 1
    fi
}

# Assert JSON boolean field is true
# Usage: assert_json_bool "field" "test_name"
assert_json_bool() {
    local field="$1"
    local test_name="${2:-bool check}"
    local actual
    actual=$(extract_json_bool "$field")

    if [ "$actual" = "true" ]; then
        log_pass "$test_name: $field is true"
        return 0
    else
        log_fail "$test_name: expected $field=true, got '$actual'"
        return 1
    fi
}

# Assert response body is not empty
# Usage: assert_response_not_empty "test_name"
assert_response_not_empty() {
    local test_name="${1:-response check}"

    if [ -n "$RESPONSE_BODY" ] && [ "$RESPONSE_BODY" != "" ]; then
        log_pass "$test_name: response body is not empty"
        return 0
    else
        log_fail "$test_name: response body is empty"
        return 1
    fi
}

# Assert response body matches pattern (case-insensitive)
# Usage: assert_body_matches "pattern" "test_name"
assert_body_matches() {
    local pattern="$1"
    local test_name="${2:-body matches}"

    if echo "$RESPONSE_BODY" | grep -iqE "$pattern"; then
        log_pass "$test_name: body matches /$pattern/"
        return 0
    else
        log_fail "$test_name: body does not match /$pattern/"
        return 1
    fi
}

# Combined assertion: send sync chat and validate HTTP 200 + success + non-empty response
# Sets RESPONSE_TEXT to the extracted response field value
# Issue #3003: Includes timing diagnostics on failure
# Usage: assert_sync_chat_ok "message" ["chatId"]
# Returns: 0 on success, 1 on failure
assert_sync_chat_ok() {
    local message="$1"
    local chat_id="${2:-}"
    local result

    local request_start_ms
    request_start_ms=$(date +%s%N 2>/dev/null || date +%s)

    result=$(make_sync_request "$message" "$chat_id")

    local request_end_ms
    request_end_ms=$(date +%s%N 2>/dev/null || date +%s)

    parse_response "$result"

    RESPONSE_TEXT=$(extract_json_field "response")

    # Issue #3003: Calculate and report client-side timing
    if [ "$request_start_ms" != "$request_end_ms" ]; then
        local client_elapsed_ms=$(( (request_end_ms - request_start_ms) / 1000000 ))
        if [ "$RESPONSE_STATUS" = "000" ] || [ "$RESPONSE_STATUS" != "200" ]; then
            log_error "Client-side elapsed: ${client_elapsed_ms}ms (timeout: ${TIMEOUT}s = $((TIMEOUT * 1000))ms)"
            # Show server-side timeline for this chatId
            if [ -n "$chat_id" ] && [ -f "${SERVER_LOG}" ]; then
                log_error "Server-side timeline for ${chat_id}:"
                grep "$chat_id" "${SERVER_LOG}" | \
                  grep -E "(Received chat request|processMessage|Starting SDK|TTFT|Tool call|Task completed|Iterator error)" | \
                  tail -15 | sed 's/^/    /'
            fi
        elif [ -n "$VERBOSE" ] && [ "$VERBOSE" = true ]; then
            log_info "Client-side elapsed: ${client_elapsed_ms}ms"
        fi
    fi

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Chat request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    if [ "$(extract_json_bool "success")" != "true" ]; then
        log_fail "Chat request returned success=false"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    if [ -z "$RESPONSE_TEXT" ]; then
        log_fail "Chat request returned empty response text"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi

    log_pass "Chat request successful (HTTP 200, non-empty response)"
    log_info "Response: $RESPONSE_TEXT"
    return 0
}

# =============================================================================
# Rate-Limit-Aware Request Helpers
# =============================================================================

# Retry configuration for rate-limit-aware requests
RATE_LIMIT_MAX_RETRIES="${RATE_LIMIT_MAX_RETRIES:-3}"
RATE_LIMIT_INITIAL_DELAY="${RATE_LIMIT_INITIAL_DELAY:-5}"
RATE_LIMIT_BACKOFF="${RATE_LIMIT_BACKOFF:-2}"

# Detect if a failure looks like a rate-limit issue
# Returns: 0 if rate-limit-like, 1 otherwise
is_rate_limit_failure() {
    local status="$1"
    local body="${2:-}"

    # HTTP 429 is explicitly rate limit
    if [ "$status" = "429" ]; then
        return 0
    fi

    # HTTP 000 (no response) often indicates timeout from rate-limited upstream
    if [ "$status" = "000" ]; then
        return 0
    fi

    # Check response body for rate limit indicators
    if echo "$body" | grep -iqE "rate.?limit|429|速率限制|访问量过大|request frequency"; then
        return 0
    fi

    return 1
}

# Send sync chat request with automatic retry on rate-limit-like failures
# Uses exponential backoff: RATE_LIMIT_INITIAL_DELAY * RATE_LIMIT_BACKOFF^attempt
# Usage: assert_sync_chat_ok_with_retry "message" ["chatId"]
# Returns: 0 on success, 1 on failure
assert_sync_chat_ok_with_retry() {
    local message="$1"
    local chat_id="${2:-}"
    local max_retries="${RATE_LIMIT_MAX_RETRIES}"
    local initial_delay="${RATE_LIMIT_INITIAL_DELAY}"
    local backoff="${RATE_LIMIT_BACKOFF}"

    local attempt=0
    while [ $attempt -le $max_retries ]; do
        local result
        result=$(make_sync_request "$message" "$chat_id")
        parse_response "$result"

        RESPONSE_TEXT=$(extract_json_field "response")

        # Success path
        if [ "$RESPONSE_STATUS" = "200" ] && [ "$(extract_json_bool "success")" = "true" ] && [ -n "$RESPONSE_TEXT" ]; then
            if [ $attempt -gt 0 ]; then
                log_info "Request succeeded on attempt $((attempt + 1)) (rate-limit retry)"
            fi
            log_pass "Chat request successful (HTTP 200, non-empty response)"
            log_info "Response: $RESPONSE_TEXT"
            return 0
        fi

        # Check if failure is rate-limit-like and we have retries left
        if [ $attempt -lt $max_retries ] && is_rate_limit_failure "$RESPONSE_STATUS" "$RESPONSE_BODY"; then
            local delay=$((initial_delay * backoff ** attempt))
            log_warn "Rate-limit-like failure (HTTP $RESPONSE_STATUS), retrying in ${delay}s... (attempt $((attempt + 1))/$((max_retries + 1)))"
            sleep "$delay"
            attempt=$((attempt + 1))
            continue
        fi

        # Non-rate-limit failure or out of retries — report error
        if [ "$RESPONSE_STATUS" != "200" ]; then
            log_fail "Chat request failed with HTTP $RESPONSE_STATUS"
        elif [ "$(extract_json_bool "success")" != "true" ]; then
            log_fail "Chat request returned success=false"
        elif [ -z "$RESPONSE_TEXT" ]; then
            log_fail "Chat request returned empty response text"
        fi
        log_debug "Response: $RESPONSE_BODY"
        return 1
    done

    log_fail "Chat request failed after $((max_retries + 1)) attempts (rate-limit retries exhausted)"
    return 1
}

# =============================================================================
# Test Registration and Execution
# =============================================================================

# Arrays for test registration
declare -a _TEST_NAMES=()
declare -a _TEST_FUNCS=()
declare -a _TEST_TAGS=()
declare -a _TEST_DESCS=()
declare -a _TEST_TIMINGS=()

# Register a test case
# Usage: declare_test "name" "function" "tag" "description"
declare_test() {
    local name="$1"
    local func="$2"
    local tag="${3:-default}"
    local desc="${4:-}"
    _TEST_NAMES+=("$name")
    _TEST_FUNCS+=("$func")
    _TEST_TAGS+=("$tag")
    _TEST_DESCS+=("$desc")
}

# Run registered tests, optionally filtered by --tag or --name
# Usage: run_tests [--tag TAG] [--name NAME]
run_tests() {
    local filter_tag=""
    local filter_name=""
    local i

    while [[ $# -gt 0 ]]; do
        case $1 in
            --tag)   filter_tag="$2"; shift 2 ;;
            --name)  filter_name="$2"; shift 2 ;;
            *) shift ;;
        esac
    done

    for i in "${!_TEST_FUNCS[@]}"; do
        local name="${_TEST_NAMES[$i]}"
        local func="${_TEST_FUNCS[$i]}"
        local tag="${_TEST_TAGS[$i]}"
        local desc="${_TEST_DESCS[$i]}"

        # Apply filters
        if [ -n "$filter_tag" ] && [ "$tag" != "$filter_tag" ]; then
            continue
        fi
        if [ -n "$filter_name" ] && [[ "$name" != *"$filter_name"* ]]; then
            continue
        fi

        echo ""
        log_info "Running: $name"
        if [ -n "$desc" ]; then
            log_debug "  $desc"
        fi

        local start_time
        start_time=$(date +%s%N 2>/dev/null || date +%s)

        # Run test function
        if "$func"; then
            : # log_pass/log_fail already called inside
        else
            : # failure already recorded
        fi

        local end_time
        end_time=$(date +%s%N 2>/dev/null || date +%s)
        if [ "$start_time" != "$end_time" ]; then
            local elapsed=$(( (end_time - start_time) / 1000000 ))
            _TEST_TIMINGS+=("${name}: ${elapsed}ms")
        fi

        echo ""
    done
}

# Print registered tests (dry-run listing)
print_registered_tests() {
    local i
    echo "Registered tests:"
    for i in "${!_TEST_NAMES[@]}"; do
        local name="${_TEST_NAMES[$i]}"
        local tag="${_TEST_TAGS[$i]}"
        local desc="${_TEST_DESCS[$i]}"
        printf "  [%s] %-40s %s\n" "$tag" "$name" "$desc"
    done
    echo ""
    echo "Total: ${#_TEST_NAMES[@]} test(s)"
}

# Print test timings from last run
print_test_timings() {
    if [ ${#_TEST_TIMINGS[@]} -eq 0 ]; then
        return
    fi
    echo ""
    echo "Test timings:"
    for timing in "${_TEST_TIMINGS[@]}"; do
        echo "  $timing"
    done
}

# =============================================================================
# Standard Main Entry Point
# =============================================================================

# Standard test suite entry point - replaces boilerplate in each test file
# Usage: main_test_suite "Suite Name" [setup_function]
main_test_suite() {
    local suite_name="$1"
    local setup_func="${2:-}"

    echo ""
    echo "=========================================="
    echo "  $suite_name"
    echo "=========================================="
    echo ""

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        print_registered_tests
        echo ""
        echo "Configuration:"
        echo "  - REST Port: $REST_PORT"
        echo "  - Timeout: ${TIMEOUT}s"
        echo "  - Project Root: ${PROJECT_ROOT:-.}"
        exit 0
    fi

    # Run setup if provided (e.g., create_test_images)
    if [ -n "$setup_func" ]; then
        "$setup_func"
    fi

    # Start server
    log_info "Checking server..."
    if ! is_server_running; then
        start_server || exit 1
    else
        log_info "Server already running on port ${REST_PORT}"
    fi
    echo ""

    # Run registered tests
    log_info "Running tests..."
    run_tests

    # Print timings and summary
    print_test_timings
    print_summary
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
