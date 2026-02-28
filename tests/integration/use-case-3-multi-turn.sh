#!/bin/bash
#
# Integration Test: Use Case 3 - Multi-turn Conversation with Context
#
# This script tests the multi-turn conversation scenario:
# Agent can maintain context across multiple turns of dialogue.
#
# Test Scenarios:
# 1. Health check - Verify server is running
# 2. Number context - Set favorite number, ask about it, then calculate
# 3. Name context - Introduce name and interests, ask about each
# 4. Separate chats - Verify different chatIds have isolated contexts
#
# Usage:
#   ./tests/integration/use-case-3-multi-turn.sh [options]
#
# Options:
#   --verbose, -v       Enable verbose output
#   --timeout, -t SECS  Request timeout (default: 60)
#   --port, -p PORT     REST API port (default: 3099)
#   --config, -c PATH   Config file path
#   --dry-run           Show configuration without running
#   --help, -h          Show help
#
# Acceptance Criteria (from Issue #331):
# - [x] Use REST Channel for multi-turn conversation
# - [x] Agent can reference first turn's info in second turn
# - [x] Context is correctly passed
# - [x] Does not depend on vitest framework
#

# Source common test environment
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/test-env.sh"

# Override timeout for agent responses
TIMEOUT="${TIMEOUT:-60}"

# Parse command line arguments
parse_common_args "$@"

# =============================================================================
# Helper Functions
# =============================================================================

# Send message and wait for reply
# Returns: reply content or empty on failure
send_and_wait() {
    local chatId="$1"
    local message="$2"
    local wait_timeout="${3:-90}"

    log_debug "Sending to $chatId: $message"

    local result
    result=$(make_request "POST" "/api/chat" "{\"message\":\"${message}\",\"chatId\":\"${chatId}\"}")

    local status="${result%%|*}"

    if [ "$status" != "200" ]; then
        log_fail "Failed to send message (status: $status)"
        return 1
    fi

    local reply
    reply=$(wait_for_reply "$chatId" "$wait_timeout")

    if [ -z "$reply" ]; then
        log_fail "No response received"
        return 1
    fi

    log_debug "Reply: $reply"
    echo "$reply"
    return 0
}

# =============================================================================
# Test Functions
# =============================================================================

# Test 1: Health Check
test_health_check() {
    log_info "Testing: Health check before multi-turn tests"

    local result
    result=$(make_request "GET" "/api/health")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" = "200" ]; then
        if echo "$body" | grep -q '"status":"ok"'; then
            log_pass "Server is healthy and ready"
        else
            log_fail "Health check returned 200 but body invalid"
        fi
    else
        log_fail "Health check returned status $status (expected 200)"
    fi
}

# Test 2: Number Context
test_number_context() {
    log_info "Testing: Number context (set favorite number, recall, calculate)"

    local chatId="test-number-context-$$"

    # Turn 1: Set favorite number
    log_info "Turn 1: Setting favorite number"
    local reply1
    reply1=$(send_and_wait "$chatId" "My favorite number is 42. Please remember this.")
    if [ -z "$reply1" ]; then
        log_fail "Failed at Turn 1: setting favorite number"
        return
    fi

    # Turn 2: Ask about the number
    log_info "Turn 2: Asking about favorite number"
    local reply2
    reply2=$(send_and_wait "$chatId" "What is my favorite number?")
    if [ -z "$reply2" ]; then
        log_fail "Failed at Turn 2: asking about favorite number"
        return
    fi

    # Verify context is maintained - should mention 42
    if echo "$reply2" | grep -q "42"; then
        log_pass "Agent correctly recalled favorite number (42)"
    else
        log_fail "Agent did not recall favorite number correctly"
        log_info "Agent response: $reply2"
        return
    fi

    # Turn 3: Use the number in calculation
    log_info "Turn 3: Using favorite number in calculation"
    local reply3
    reply3=$(send_and_wait "$chatId" "Multiply my favorite number by 2 and tell me the result.")
    if [ -z "$reply3" ]; then
        log_fail "Failed at Turn 3: calculation with favorite number"
        return
    fi

    # Verify calculation - should mention 84
    if echo "$reply3" | grep -q "84"; then
        log_pass "Agent correctly used context (42 * 2 = 84)"
    else
        log_fail "Agent did not calculate correctly with context"
        log_info "Agent response: $reply3"
    fi
}

# Test 3: Name Context
test_name_context() {
    log_info "Testing: Name context (introduce name and interests)"

    local chatId="test-name-context-$$"

    # Turn 1: Introduce name
    log_info "Turn 1: Introducing name"
    local reply1
    reply1=$(send_and_wait "$chatId" "Hi, my name is Alice and I like programming.")
    if [ -z "$reply1" ]; then
        log_fail "Failed at Turn 1: introducing name"
        return
    fi

    # Turn 2: Ask about name
    log_info "Turn 2: Asking about name"
    local reply2
    reply2=$(send_and_wait "$chatId" "What is my name?")
    if [ -z "$reply2" ]; then
        log_fail "Failed at Turn 2: asking about name"
        return
    fi

    # Verify context - should mention Alice
    if echo "$reply2" | grep -qi "Alice"; then
        log_pass "Agent correctly recalled name (Alice)"
    else
        log_fail "Agent did not recall name correctly"
        log_info "Agent response: $reply2"
        return
    fi

    # Turn 3: Ask about interest
    log_info "Turn 3: Asking about interest"
    local reply3
    reply3=$(send_and_wait "$chatId" "What do I like to do?")
    if [ -z "$reply3" ]; then
        log_fail "Failed at Turn 3: asking about interest"
        return
    fi

    # Verify context - should mention programming
    if echo "$reply3" | grep -qi "programming"; then
        log_pass "Agent correctly recalled interest (programming)"
    else
        log_fail "Agent did not recall interest correctly"
        log_info "Agent response: $reply3"
    fi
}

# Test 4: Separate Chat Context Isolation
test_context_isolation() {
    log_info "Testing: Context isolation between different chats"

    local chatId1="test-isolation-1-$$"
    local chatId2="test-isolation-2-$$"

    # Chat 1: Set name to Bob
    log_info "Chat 1: Setting name to Bob"
    local reply1
    reply1=$(send_and_wait "$chatId1" "My name is Bob.")
    if [ -z "$reply1" ]; then
        log_fail "Failed to set name in Chat 1"
        return
    fi

    # Chat 2: Set name to Carol
    log_info "Chat 2: Setting name to Carol"
    local reply2
    reply2=$(send_and_wait "$chatId2" "My name is Carol.")
    if [ -z "$reply2" ]; then
        log_fail "Failed to set name in Chat 2"
        return
    fi

    # Chat 1: Ask about name - should be Bob
    log_info "Chat 1: Asking about name (should be Bob)"
    local reply3
    reply3=$(send_and_wait "$chatId1" "What is my name?")
    if [ -z "$reply3" ]; then
        log_fail "Failed to ask name in Chat 1"
        return
    fi

    if echo "$reply3" | grep -qi "Bob" && ! echo "$reply3" | grep -qi "Carol"; then
        log_pass "Chat 1 correctly maintained its own context (Bob)"
    else
        log_fail "Chat 1 context was corrupted"
        log_info "Agent response: $reply3"
        return
    fi

    # Chat 2: Ask about name - should be Carol
    log_info "Chat 2: Asking about name (should be Carol)"
    local reply4
    reply4=$(send_and_wait "$chatId2" "What is my name?")
    if [ -z "$reply4" ]; then
        log_fail "Failed to ask name in Chat 2"
        return
    fi

    if echo "$reply4" | grep -qi "Carol" && ! echo "$reply4" | grep -qi "Bob"; then
        log_pass "Chat 2 correctly maintained its own context (Carol)"
    else
        log_fail "Chat 2 context was corrupted"
        log_info "Agent response: $reply4"
    fi
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    log_section "Use Case 3: Multi-turn Conversation Tests"

    echo "API URL: ${API_URL}"
    echo "Timeout: ${TIMEOUT}s"
    if [ -n "$CONFIG_PATH" ]; then
        echo "Config: ${CONFIG_PATH}"
    fi
    echo ""

    # Check prerequisites
    if ! check_prerequisites; then
        exit 1
    fi

    # Ensure server is running
    if ! ensure_server_running; then
        exit 1
    fi

    # Run tests
    echo "Running tests..."
    echo ""

    test_health_check
    test_number_context
    test_name_context
    test_context_isolation

    # Summary
    print_summary "Use Case 3 Test Summary"
}

main "$@"
