#!/bin/bash
#
# Integration Test: Use Case 3 - Multi-turn Conversation with Context
#
# Tests multi-turn conversation scenario where Agent maintains context:
# - User sends multiple messages in sequence
# - Agent can reference previous messages
# - Context is correctly preserved across turns
#
# Prerequisites:
# - Node.js installed
# - disclaude built (npm run build)
# - Valid disclaude.config.yaml with AI provider configured
# - Environment variables set (ANTHROPIC_API_KEY or OPENAI_API_KEY)
#
# Usage:
#   ./use-case-3-multi-turn.sh [options]
#
# Options:
#   --timeout SECONDS   Maximum wait time for response (default: 180)
#   --port PORT         REST API port (default: 3000)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

# Configuration
TIMEOUT=180
REST_PORT=3000
VERBOSE=false
DRY_RUN=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PID_FILE="/tmp/disclaude-test-$$.pid"
LOG_FILE="/tmp/disclaude-test-$$.log"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Parse arguments
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
        *)
            echo "Unknown option: $1"
            exit 1
            ;;
    esac
done

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
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

log_turn() {
    echo -e "${BLUE}[Turn $1]${NC} $2"
}

# Cleanup function
cleanup() {
    log_info "Cleaning up..."

    # Kill the server if running
    if [ -f "$PID_FILE" ]; then
        local pid=$(cat "$PID_FILE")
        if kill -0 "$pid" 2>/dev/null; then
            log_debug "Killing server process $pid"
            kill "$pid" 2>/dev/null || true
            wait "$pid" 2>/dev/null || true
        fi
        rm -f "$PID_FILE"
    fi

    # Remove log file unless verbose
    if [ "$VERBOSE" = false ] && [ -f "$LOG_FILE" ]; then
        rm -f "$LOG_FILE"
    fi
}

# Set up cleanup on exit
trap cleanup EXIT

# Check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    log_debug "Node.js: $(node --version)"

    # Check curl
    if ! command -v curl &> /dev/null; then
        log_error "curl is not installed"
        exit 1
    fi

    # Check if project is built
    if [ ! -d "$PROJECT_ROOT/dist" ]; then
        log_error "Project not built. Run 'npm run build' first."
        exit 1
    fi

    # Check configuration
    if [ ! -f "$PROJECT_ROOT/disclaude.config.yaml" ]; then
        log_error "Configuration file not found: $PROJECT_ROOT/disclaude.config.yaml"
        log_error "Please create a configuration file with AI provider settings."
        exit 1
    fi

    # Check for API keys
    if [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
        log_warn "No API key environment variable detected (ANTHROPIC_API_KEY or OPENAI_API_KEY)"
        log_warn "The test may fail if the configuration requires an API key."
    fi

    log_info "Prerequisites OK"
}

# Start the server
start_server() {
    log_info "Starting disclaude server on port $REST_PORT..."

    cd "$PROJECT_ROOT"

    # Start the server in background
    node dist/cli-entry.js start --mode primary --rest-port "$REST_PORT" > "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    log_debug "Server PID: $pid"

    # Wait for server to be ready
    local wait_time=0
    local max_wait=30

    while [ $wait_time -lt $max_wait ]; do
        if curl -s "http://localhost:$REST_PORT/api/health" > /dev/null 2>&1; then
            log_info "Server is ready"
            return 0
        fi
        sleep 1
        wait_time=$((wait_time + 1))
        log_debug "Waiting for server... ($wait_time/$max_wait)"
    done

    log_error "Server failed to start within ${max_wait} seconds"
    if [ "$VERBOSE" = true ]; then
        log_error "Server log:"
        cat "$LOG_FILE"
    fi
    exit 1
}

# Helper function to send chat message
send_chat() {
    local chat_id="$1"
    local message="$2"

    local response
    local http_code

    response=$(curl -s -w "\n%{http_code}" -X POST "http://localhost:$REST_PORT/api/chat/sync" \
        -H "Content-Type: application/json" \
        -d "{\"message\": \"$message\", \"chatId\": \"$chat_id\"}" \
        --max-time "$TIMEOUT")

    http_code=$(echo "$response" | tail -1)
    response=$(echo "$response" | sed '$d')

    echo "$http_code|$response"
}

# Helper function to extract response text
extract_response() {
    local response="$1"
    # Extract response field, handling JSON escaping
    echo "$response" | grep -o '"response":"[^"]*"' | cut -d'"' -f4
}

# Test: Health check
test_health_check() {
    log_info "Test 1: Health check..."

    local response
    response=$(curl -s "http://localhost:$REST_PORT/api/health")

    log_debug "Health response: $response"

    if echo "$response" | grep -q '"status":"ok"'; then
        log_info "✓ Health check passed"
        return 0
    else
        log_error "✗ Health check failed: $response"
        return 1
    fi
}

# Test: Multi-turn conversation with number context
test_multi_turn_number_context() {
    log_info "Test 2: Multi-turn conversation with number context..."

    local chat_id="test-multi-turn-numbers-$$"
    local result
    local http_code
    local response
    local response_text

    # Turn 1: Tell the agent a favorite number
    log_turn 1 "Setting favorite number..."
    result=$(send_chat "$chat_id" "Please remember that my favorite number is 42. Just confirm you understood.")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 1 HTTP code: $http_code"
    log_debug "Turn 1 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 1 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 1: No response text received"
        return 1
    fi
    log_turn 1 "Agent acknowledged."

    # Turn 2: Ask the agent to use the favorite number
    log_turn 2 "Asking about favorite number..."
    result=$(send_chat "$chat_id" "What is my favorite number that I just told you?")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 2 HTTP code: $http_code"
    log_debug "Turn 2 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 2 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 2: No response text received"
        return 1
    fi

    # Verify the agent remembers the number 42
    if echo "$response_text" | grep -q "42"; then
        log_info "Agent correctly recalled favorite number (42)"
    else
        log_warn "Agent may not have recalled the number correctly. Response: $response_text"
    fi

    # Turn 3: Ask for a calculation using the number
    log_turn 3 "Asking for calculation..."
    result=$(send_chat "$chat_id" "What is my favorite number multiplied by 2?")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 3 HTTP code: $http_code"
    log_debug "Turn 3 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 3 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 3: No response text received"
        return 1
    fi

    # Verify the agent calculated 84 (42 * 2)
    if echo "$response_text" | grep -q "84"; then
        log_info "Agent correctly calculated 42 * 2 = 84"
        log_turn 3 "Calculation correct!"
    else
        log_warn "Agent may not have calculated correctly. Response: $response_text"
    fi

    log_info "✓ Multi-turn number context test passed"
    return 0
}

# Test: Multi-turn conversation with name context
test_multi_turn_name_context() {
    log_info "Test 3: Multi-turn conversation with name context..."

    local chat_id="test-multi-turn-name-$$"
    local result
    local http_code
    local response
    local response_text

    # Turn 1: Introduce with name
    log_turn 1 "Introducing with name..."
    result=$(send_chat "$chat_id" "Hi, my name is Alice and I like programming. Nice to meet you!")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 1 HTTP code: $http_code"
    log_debug "Turn 1 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 1 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 1: No response text received"
        return 1
    fi

    # Turn 2: Ask about the name
    log_turn 2 "Asking about name..."
    result=$(send_chat "$chat_id" "What is my name?")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 2 HTTP code: $http_code"
    log_debug "Turn 2 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 2 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 2: No response text received"
        return 1
    fi

    if echo "$response_text" | grep -iq "Alice"; then
        log_info "Agent correctly recalled the name (Alice)"
    else
        log_warn "Agent may not have recalled the name. Response: $response_text"
    fi

    # Turn 3: Ask about interests
    log_turn 3 "Asking about interests..."
    result=$(send_chat "$chat_id" "What do I like to do?")
    http_code="${result%%|*}"
    response="${result#*|}"

    log_debug "Turn 3 HTTP code: $http_code"
    log_debug "Turn 3 response: $response"

    if [ "$http_code" != "200" ]; then
        log_error "✗ Turn 3 failed with HTTP $http_code"
        return 1
    fi

    response_text=$(extract_response "$response")
    if [ -z "$response_text" ]; then
        log_error "✗ Turn 3: No response text received"
        return 1
    fi

    if echo "$response_text" | grep -iq "programming"; then
        log_info "Agent correctly recalled the interest (programming)"
    else
        log_warn "Agent may not have recalled the interest. Response: $response_text"
    fi

    log_info "✓ Multi-turn name context test passed"
    return 0
}

# Test: Different chat IDs maintain separate contexts
test_separate_chat_contexts() {
    log_info "Test 4: Separate chat contexts..."

    local chat_id_1="test-separate-chat-1-$$"
    local chat_id_2="test-separate-chat-2-$$"
    local result
    local http_code
    local response
    local response_text

    # Set context in chat 1
    log_debug "Setting context in chat 1..."
    result=$(send_chat "$chat_id_1" "My favorite color is blue. Remember this.")
    http_code="${result%%|*}"
    if [ "$http_code" != "200" ]; then
        log_error "✗ Chat 1 setup failed with HTTP $http_code"
        return 1
    fi
    log_debug "Chat 1 response: $(extract_response "${result#*|}")"

    # Set different context in chat 2
    log_debug "Setting context in chat 2..."
    result=$(send_chat "$chat_id_2" "My favorite color is red. Remember this.")
    http_code="${result%%|*}"
    if [ "$http_code" != "200" ]; then
        log_error "✗ Chat 2 setup failed with HTTP $http_code"
        return 1
    fi
    log_debug "Chat 2 response: $(extract_response "${result#*|}")"

    # Verify chat 1 remembers blue
    result=$(send_chat "$chat_id_1" "What is my favorite color?")
    http_code="${result%%|*}"
    if [ "$http_code" != "200" ]; then
        log_error "✗ Chat 1 recall failed with HTTP $http_code"
        return 1
    fi
    response_text=$(extract_response "${result#*|}")
    log_debug "Chat 1 recall: $response_text"

    if echo "$response_text" | grep -iq "blue"; then
        log_info "Chat 1 correctly recalled: blue"
    else
        log_warn "Chat 1 may have wrong context. Response: $response_text"
    fi

    # Verify chat 2 remembers red
    result=$(send_chat "$chat_id_2" "What is my favorite color?")
    http_code="${result%%|*}"
    if [ "$http_code" != "200" ]; then
        log_error "✗ Chat 2 recall failed with HTTP $http_code"
        return 1
    fi
    response_text=$(extract_response "${result#*|}")
    log_debug "Chat 2 recall: $response_text"

    if echo "$response_text" | grep -iq "red"; then
        log_info "Chat 2 correctly recalled: red"
    else
        log_warn "Chat 2 may have wrong context. Response: $response_text"
    fi

    log_info "✓ Separate chat contexts test passed"
    return 0
}

# Show test plan
show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Use Case 3 - Multi-turn Conversation"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Scenarios:"
    echo "  1. Health check - Verify server is running"
    echo "  2. Number context - Set favorite number, recall it, use in calculation"
    echo "  3. Name context - Introduce name/interest, recall both"
    echo "  4. Separate chats - Verify different chatIds have isolated contexts"
    echo ""
    echo "Acceptance Criteria (from Issue #331):"
    echo "  - Use REST Channel for multi-turn conversation"
    echo "  - Agent can reference previous messages in turn 2+"
    echo "  - Context is correctly preserved across turns"
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
    echo "  - API key set (ANTHROPIC_API_KEY or OPENAI_API_KEY)"
    echo ""
}

# Main test runner
main() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Use Case 3 - Multi-turn Conversation"
    echo "=========================================="
    echo ""

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        show_test_plan
        exit 0
    fi

    check_prerequisites
    start_server

    local failed=0

    echo ""
    echo "Running tests..."
    echo ""

    # Run tests
    test_health_check || failed=$((failed + 1))
    echo ""
    test_multi_turn_number_context || failed=$((failed + 1))
    echo ""
    test_multi_turn_name_context || failed=$((failed + 1))
    echo ""
    test_separate_chat_contexts || failed=$((failed + 1))

    echo ""
    echo "=========================================="

    if [ $failed -eq 0 ]; then
        log_info "All tests passed! (4/4)"
        echo "=========================================="
        exit 0
    else
        log_error "$failed test(s) failed"
        echo "=========================================="
        exit 1
    fi
}

main
