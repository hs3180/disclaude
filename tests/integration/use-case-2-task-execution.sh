#!/bin/bash
#
# Integration Test: Use Case 2 - Task Execution
#
# This script tests the task execution scenario:
# User sends a task request, Agent executes it and returns the result.
#
# Test Scenarios:
# 1. Health check - Verify server is running
# 2. Calculation task - Agent performs a calculation
# 3. File system task - Agent lists directory contents
# 4. Analysis task - Agent analyzes and summarizes text
#
# Usage:
#   ./tests/integration/use-case-2-task-execution.sh [options]
#
# Options:
#   --verbose, -v       Enable verbose output
#   --timeout, -t SECS  Request timeout (default: 60)
#   --port, -p PORT     REST API port (default: 3099)
#   --config, -c PATH   Config file path
#   --dry-run           Show configuration without running
#   --help, -h          Show help
#
# Acceptance Criteria (from Issue #330):
# - [x] Use REST Channel to send task
# - [x] Agent correctly parses task intent
# - [x] Agent executes task (calls tools)
# - [x] Result returned via REST Channel
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
# Test Functions
# =============================================================================

# Test 1: Health Check
test_health_check() {
    log_info "Testing: Health check before task execution"

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

# Test 2: Calculation Task
test_calculation_task() {
    log_info "Testing: Calculation task (25 * 17)"

    local chatId=$(generate_chat_id)
    local message="What is 25 multiplied by 17? Please calculate and give me the result."

    log_debug "Sending message to chatId: $chatId"

    # Send the task
    local result
    result=$(make_request "POST" "/api/chat" "{\"message\":\"${message}\",\"chatId\":\"${chatId}\"}")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" != "200" ]; then
        log_fail "Failed to send calculation task (status: $status)"
        return
    fi

    log_info "Task sent, waiting for agent response..."

    # Wait for agent reply
    local reply
    reply=$(wait_for_reply "$chatId" 90)

    if [ -z "$reply" ]; then
        log_fail "No response received for calculation task"
        return
    fi

    log_debug "Agent reply: $reply"

    # Check if the reply contains the expected result (425)
    if echo "$reply" | grep -qi "425"; then
        log_pass "Agent correctly calculated 25 * 17 = 425"
    else
        log_fail "Agent did not return correct calculation result (expected 425)"
        log_info "Agent response: $reply"
    fi
}

# Test 3: File System Task
test_file_system_task() {
    log_info "Testing: File system task (list files)"

    local chatId=$(generate_chat_id)
    local message="Please list the files in the current directory and tell me what you see."

    log_debug "Sending message to chatId: $chatId"

    # Send the task
    local result
    result=$(make_request "POST" "/api/chat" "{\"message\":\"${message}\",\"chatId\":\"${chatId}\"}")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" != "200" ]; then
        log_fail "Failed to send file system task (status: $status)"
        return
    fi

    log_info "Task sent, waiting for agent response..."

    # Wait for agent reply
    local reply
    reply=$(wait_for_reply "$chatId" 90)

    if [ -z "$reply" ]; then
        log_fail "No response received for file system task"
        return
    fi

    log_debug "Agent reply: $reply"

    # Check if the reply contains some file-related content
    # The agent should mention files or directories
    if echo "$reply" | grep -qiE "(file|directory|folder|\.\w+|package\.json|src|dist)"; then
        log_pass "Agent successfully executed file listing task"
    else
        log_fail "Agent response doesn't indicate file system task execution"
        log_info "Agent response: $reply"
    fi
}

# Test 4: Analysis Task
test_analysis_task() {
    log_info "Testing: Analysis task (summarize text)"

    local chatId=$(generate_chat_id)
    local message="Please analyze this text and give me a one-sentence summary: 'The quick brown fox jumps over the lazy dog. This sentence contains every letter of the English alphabet and is commonly used for testing fonts and keyboards.'"

    log_debug "Sending message to chatId: $chatId"

    # Send the task
    local result
    result=$(make_request "POST" "/api/chat" "{\"message\":\"${message}\",\"chatId\":\"${chatId}\"}")

    local status="${result%%|*}"
    local body="${result#*|}"

    if [ "$status" != "200" ]; then
        log_fail "Failed to send analysis task (status: $status)"
        return
    fi

    log_info "Task sent, waiting for agent response..."

    # Wait for agent reply
    local reply
    reply=$(wait_for_reply "$chatId" 90)

    if [ -z "$reply" ]; then
        log_fail "No response received for analysis task"
        return
    fi

    log_debug "Agent reply: $reply"

    # Check if the reply contains a summary
    # The agent should mention pangram, alphabet, or testing
    if echo "$reply" | grep -qiE "(pangram|alphabet|sentence|letter|test|fox|dog)"; then
        log_pass "Agent successfully analyzed and summarized the text"
    else
        log_fail "Agent response doesn't indicate analysis task completion"
        log_info "Agent response: $reply"
    fi
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    log_section "Use Case 2: Task Execution Tests"

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
    test_calculation_task
    test_file_system_task
    test_analysis_task

    # Summary
    print_summary "Use Case 2 Test Summary"
}

main "$@"
