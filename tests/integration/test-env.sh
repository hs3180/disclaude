#!/bin/bash
#
# Integration Test Environment - Common Functions Library
#
# This script provides common functions for integration tests:
# - Server lifecycle management (start/stop)
# - HTTP request helpers
# - Logging utilities
# - Test result tracking
#
# Usage:
#   source tests/integration/test-env.sh
#
# Environment variables (can be overridden):
#   DISCLAUDE_CONFIG - Path to config file
#   REST_PORT        - REST API port (default: 3099)
#   HOST             - Test server host (default: 127.0.0.1)
#   TIMEOUT          - Request timeout in seconds (default: 30)
#   VERBOSE          - Enable verbose output (default: false)
#
# After sourcing, you can use:
#   start_server     - Start the test server
#   stop_server      - Stop the test server
#   make_request     - Make HTTP request
#   log_info/pass/fail/skip - Logging functions
#   wait_for_reply   - Wait for agent reply (for chat tests)
#

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
HOST="${HOST:-127.0.0.1}"
API_URL="http://${HOST}:${REST_PORT}"
TIMEOUT="${TIMEOUT:-30}"
CONFIG_PATH="${DISCLAUDE_CONFIG:-}"
VERBOSE="${VERBOSE:-false}"
SERVER_PID=""
SERVER_LOG="/tmp/disclaude-test-server-$$.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Test counters
TESTS_PASSED=0
TESTS_FAILED=0
TESTS_SKIPPED=0

# =============================================================================
# Logging Functions
# =============================================================================

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_debug() {
    if [ "$VERBOSE" = "true" ]; then
        echo -e "${CYAN}[DEBUG]${NC} $1"
    fi
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
    TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
}

log_section() {
    echo ""
    echo -e "${BLUE}==============================================${NC}"
    echo -e "${BLUE}  $1${NC}"
    echo -e "${BLUE}==============================================${NC}"
    echo ""
}

# =============================================================================
# Server Management Functions
# =============================================================================

# Start the test server
# Returns: 0 on success, 1 on failure
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
    node dist/cli-entry.js start --mode primary --rest-port ${REST_PORT} --host ${HOST} ${config_arg} > "$SERVER_LOG" 2>&1 &
    SERVER_PID=$!

    # Wait for server to be ready
    log_info "Waiting for server to be ready (PID: ${SERVER_PID})..."
    local max_retries=30
    local retry=0
    while [ $retry -lt $max_retries ]; do
        if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
            log_info "Server is ready"
            return 0
        fi
        sleep 1
        retry=$((retry + 1))
        log_debug "Waiting... ($retry/$max_retries)"
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

# Check if server is running
is_server_running() {
    if [ -n "$SERVER_PID" ] && kill -0 $SERVER_PID 2>/dev/null; then
        return 0
    fi
    return 1
}

# Ensure server is running (start if not)
ensure_server_running() {
    log_info "Checking if REST server is running..."
    if curl -s "${API_URL}/api/health" > /dev/null 2>&1; then
        log_info "Server is already running"
        return 0
    else
        log_info "Server not running, starting automatically..."
        start_server
        return $?
    fi
}

# Show server logs for debugging
show_server_logs() {
    if [ -f "$SERVER_LOG" ] && [ -s "$SERVER_LOG" ]; then
        echo ""
        echo "Server logs (last 50 lines):"
        echo "----------------------------------------"
        tail -50 "$SERVER_LOG"
        echo "----------------------------------------"
    fi
}

# Cleanup function to be called on exit
cleanup() {
    stop_server
    # Remove server log if tests passed
    if [ "$TESTS_FAILED" -eq 0 ] && [ -f "$SERVER_LOG" ]; then
        rm -f "$SERVER_LOG"
    fi
}

# Register cleanup handler
trap cleanup EXIT

# =============================================================================
# HTTP Request Helpers
# =============================================================================

# Make HTTP request and return status code and body
# Usage: make_request METHOD PATH [BODY] [EXTRA_HEADERS]
# Returns: "STATUS|BODY"
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

# Send chat message and return messageId
# Usage: send_chat_message MESSAGE [CHATID]
# Returns: messageId or empty on failure
send_chat_message() {
    local message="$1"
    local chatId="${2:-test-chat-$$}"

    local result
    result=$(make_request "POST" "/api/chat" "{\"message\":\"${message}\",\"chatId\":\"${chatId}\"}")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "200" ]; then
        # Extract messageId from response
        echo "$body" | grep -o '"messageId":"[^"]*"' | cut -d'"' -f4
    else
        return 1
    fi
}

# Wait for agent reply
# Usage: wait_for_reply CHATID [TIMEOUT_SECS]
# Returns: reply message or empty on timeout
wait_for_reply() {
    local chatId="$1"
    local wait_timeout="${2:-60}"
    local interval=2
    local elapsed=0

    log_debug "Waiting for reply on chatId: $chatId (timeout: ${wait_timeout}s)"

    while [ $elapsed -lt $wait_timeout ]; do
        local result
        result=$(make_request "GET" "/api/chat/${chatId}/messages")

        local status="${result%%|*}"
        local body="${result#*|}"

        if [ "$status" = "200" ]; then
            # Check if there are messages from agent (role: assistant)
            local agent_reply
            agent_reply=$(echo "$body" | grep -o '"role":"assistant"[^}]*"content":"[^"]*"' | head -1)
            if [ -n "$agent_reply" ]; then
                # Extract content
                echo "$agent_reply" | grep -o '"content":"[^"]*"' | cut -d'"' -f4
                return 0
            fi
        fi

        sleep $interval
        elapsed=$((elapsed + interval))
        log_debug "Waiting for reply... (${elapsed}s/${wait_timeout}s)"
    done

    log_fail "Timeout waiting for agent reply"
    return 1
}

# =============================================================================
# Test Summary Functions
# =============================================================================

# Print test summary
print_summary() {
    local title="${1:-Test Summary}"

    echo ""
    log_section "$title"
    echo -e "  ${GREEN}Passed: ${TESTS_PASSED}${NC}"
    echo -e "  ${RED}Failed: ${TESTS_FAILED}${NC}"
    echo -e "  ${YELLOW}Skipped: ${TESTS_SKIPPED}${NC}"
    echo ""

    if [ "$TESTS_FAILED" -gt 0 ]; then
        show_server_logs
        return 1
    fi

    return 0
}

# =============================================================================
# Utility Functions
# =============================================================================

# Generate unique chatId for testing
generate_chat_id() {
    echo "test-chat-$$-$(date +%s)"
}

# Check if a command exists
command_exists() {
    command -v "$1" >/dev/null 2>&1
}

# Validate prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command_exists node; then
        log_fail "Node.js is not installed"
        return 1
    fi

    # Check curl
    if ! command_exists curl; then
        log_fail "curl is not installed"
        return 1
    fi

    # Check if project is built
    if [ ! -d "$PROJECT_ROOT/dist" ]; then
        log_fail "Project not built. Run 'npm run build' first."
        return 1
    fi

    log_info "Prerequisites OK"
    return 0
}

# Parse common command line arguments
# Sets: VERBOSE, TIMEOUT, REST_PORT, CONFIG_PATH
parse_common_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --verbose|-v)
                VERBOSE="true"
                shift
                ;;
            --timeout|-t)
                TIMEOUT="$2"
                shift 2
                ;;
            --port|-p)
                REST_PORT="$2"
                API_URL="http://${HOST}:${REST_PORT}"
                shift 2
                ;;
            --config|-c)
                CONFIG_PATH="$2"
                shift 2
                ;;
            --dry-run)
                echo "Dry run mode - would execute tests with:"
                echo "  API_URL: $API_URL"
                echo "  TIMEOUT: $TIMEOUT"
                echo "  CONFIG: ${CONFIG_PATH:-none}"
                exit 0
                ;;
            --help|-h)
                echo "Usage: $0 [options]"
                echo ""
                echo "Options:"
                echo "  --verbose, -v       Enable verbose output"
                echo "  --timeout, -t SECS  Request timeout (default: 30)"
                echo "  --port, -p PORT     REST API port (default: 3099)"
                echo "  --config, -c PATH   Config file path"
                echo "  --dry-run           Show configuration without running"
                echo "  --help, -h          Show this help"
                exit 0
                ;;
            *)
                shift
                ;;
        esac
    done
}
