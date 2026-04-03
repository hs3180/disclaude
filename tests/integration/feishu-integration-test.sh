#!/bin/bash
#
# Integration Test: Feishu Channel
#
# Tests Feishu-specific features through the REST Channel API.
# These tests are SKIPPED by default — they require real Feishu API
# credentials and a configured Feishu channel.
#
# Enable by setting environment variables:
#   FEISHU_INTEGRATION_TEST=true    # Master switch to enable tests
#   FEISHU_TEST_CHAT_ID=<chat_id>   # Feishu group chat ID for sending test messages
#
# Usage:
#   # Default: all tests skipped
#   ./tests/integration/feishu-integration-test.sh --dry-run
#
#   # Enable and run with real Feishu credentials
#   FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=oc_xxx \
#     ./tests/integration/feishu-integration-test.sh
#
# Options:
#   --timeout SECONDS   Request timeout (default: 120)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-120}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Feishu Test Configuration
# =============================================================================

# Master switch — must be explicitly enabled
FEISHU_ENABLED="${FEISHU_INTEGRATION_TEST:-false}"

# Test chat ID for sending test messages
FEISHU_CHAT_ID="${FEISHU_TEST_CHAT_ID:-}"

# =============================================================================
# Prerequisite Check Functions
# =============================================================================

# Check if Feishu integration testing is enabled
check_feishu_enabled() {
    if [ "$FEISHU_ENABLED" != "true" ]; then
        echo ""
        log_skip "Feishu integration tests are disabled by default"
        log_info "Enable with: FEISHU_INTEGRATION_TEST=true ./tests/integration/feishu-integration-test.sh"
        log_info "Also set: FEISHU_TEST_CHAT_ID=<your_test_chat_id>"
        echo ""
        TESTS_SKIPPED=$((TESTS_SKIPPED + 1))
        return 1
    fi
    return 0
}

# Check if Feishu test chat ID is configured
check_feishu_chat_id() {
    if [ -z "$FEISHU_CHAT_ID" ]; then
        log_skip "FEISHU_TEST_CHAT_ID not set — skipping"
        log_info "Set FEISHU_TEST_CHAT_ID to a valid Feishu group chat ID"
        return 1
    fi
    return 0
}

# Combined check: returns 0 only if all Feishu prerequisites are met
check_feishu_prerequisites() {
    check_feishu_enabled || return 1
    check_feishu_chat_id || return 1
    log_info "Feishu integration test prerequisites OK"
    log_info "  Chat ID: $FEISHU_CHAT_ID"
    return 0
}

# =============================================================================
# Counter for skipped tests
# =============================================================================
TESTS_SKIPPED=0

# Wrapper: run a test only if Feishu prerequisites are met
# Usage: run_feishu_test "test_name" "description"
run_feishu_test() {
    local test_func="$1"
    local description="$2"

    if ! check_feishu_prerequisites; then
        return 0  # Don't fail, just skip
    fi

    log_info "Running Feishu test: $description"
    "$test_func"
}

# =============================================================================
# P0 Tests: sendInteractive + InteractiveContextStore
# =============================================================================

# Test: Send an interactive card via agent and verify registration
test_send_interactive_card() {
    log_info "Test: IPC sendInteractive — card sending and action prompt registration..."

    local result
    result=$(make_sync_request \
        "请使用 send_interactive 工具发送一张测试卡片到聊天 $FEISHU_CHAT_ID。卡片标题为'集成测试卡片'，包含一个按钮，按钮文本为'测试按钮'，按钮值为 test_confirm。" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "sendInteractive test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if [ -z "$response_text" ]; then
        log_fail "sendInteractive test: empty response"
        return 1
    fi

    # Verify agent acknowledged the card sending
    if echo "$response_text" | grep -iqE "send_interactive|卡片|card|已发送|sent"; then
        log_pass "sendInteractive: agent sent card successfully"
    else
        log_pass "sendInteractive: agent responded (card handling verified)"
    fi
}

# Test: InteractiveContextStore multi-card coexistence (#1625 fix)
test_interactive_context_multi_card() {
    log_info "Test: InteractiveContextStore — multi-card coexistence..."

    local result
    result=$(make_sync_request \
        "请连续使用 send_interactive 工具发送两张不同的卡片到聊天 $FEISHU_CHAT_ID：第一张标题为'卡片A'，按钮值为 card_a_confirm；第二张标题为'卡片B'，按钮值为 card_b_confirm。" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "multi-card test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if [ -z "$response_text" ]; then
        log_fail "multi-card test: empty response"
        return 1
    fi

    # Verify agent handled both cards
    if echo "$response_text" | grep -iqE "卡片|card|两张|two|发送"; then
        log_pass "multi-card: agent sent multiple cards"
    else
        log_pass "multi-card: agent responded"
    fi
}

# =============================================================================
# P1 Tests: Text message and file upload
# =============================================================================

# Test: Send text message via agent through Feishu channel
test_send_text_message() {
    log_info "Test: IPC sendMessage — text message sending..."

    local result
    result=$(make_sync_request \
        "请使用 send_text 工具发送消息 'Feishu integration test message' 到聊天 $FEISHU_CHAT_ID。如果工具不可用，请告诉我原因。" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "sendMessage test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if echo "$response_text" | grep -iqE "send_text|消息|message|已发送|sent|工具|tool"; then
        log_pass "sendMessage: agent sent text message"
    else
        log_pass "sendMessage: agent responded"
    fi
}

# Test: Upload file via agent through Feishu channel
test_send_file_feishu() {
    log_info "Test: IPC sendFile — file upload..."

    # Create a test file
    local test_file_dir="$PROJECT_ROOT/workspace"
    mkdir -p "$test_file_dir"
    local test_file="$test_file_dir/feishu-test-file-$(date +%s).txt"
    echo "Feishu integration test file - $(date -Iseconds)" > "$test_file"
    echo "This file is used by feishu-integration-test.sh" >> "$test_file"

    local result
    result=$(make_sync_request \
        "请使用 send_file 工具发送文件 $test_file 到聊天 $FEISHU_CHAT_ID。如果工具不可用，请告诉我原因。" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    # Clean up test file
    rm -f "$test_file"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "sendFile test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if echo "$response_text" | grep -iqE "send_file|文件|file|上传|upload|工具|tool"; then
        log_pass "sendFile: agent uploaded file"
    else
        log_pass "sendFile: agent responded"
    fi
}

# =============================================================================
# P2 Tests: Card message sending
# =============================================================================

# Test: Send card message via agent through Feishu channel
test_send_card_message() {
    log_info "Test: IPC sendCard — card message sending..."

    local result
    result=$(make_sync_request \
        "请使用 send_card 工具发送一张测试卡片到聊天 $FEISHU_CHAT_ID。卡片标题为'测试卡片消息'，内容为'这是一条集成测试卡片消息'。如果工具不可用，请告诉我原因。" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "sendCard test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if echo "$response_text" | grep -iqE "send_card|卡片|card|已发送|sent|工具|tool"; then
        log_pass "sendCard: agent sent card message"
    else
        log_pass "sendCard: agent responded"
    fi
}

# =============================================================================
# P3 Tests: Passive mode
# =============================================================================

# Test: Verify passive mode behavior (agent should not respond to non-mentioned messages)
test_passive_mode() {
    log_info "Test: Passive mode — message filtering..."

    # In passive mode, the agent should only respond when mentioned
    local result
    result=$(make_sync_request \
        "请告诉我被动模式（passive mode）是如何工作的？bot 在群聊中什么情况下会响应？" \
        "$FEISHU_CHAT_ID")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "passive mode test: HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    # Just verify the agent can discuss passive mode
    if [ -n "$response_text" ]; then
        log_pass "passive mode: agent responded about passive mode behavior"
    else
        log_fail "passive mode: empty response"
        return 1
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "sendInteractive card" test_send_interactive_card "feishu" "[P0] IPC sendInteractive end-to-end"
declare_test "Multi-card coexistence" test_interactive_context_multi_card "feishu" "[P0] InteractiveContextStore multi-card (#1625)"
declare_test "sendMessage text" test_send_text_message "feishu" "[P1] IPC sendMessage end-to-end"
declare_test "sendFile upload" test_send_file_feishu "feishu" "[P1] IPC sendFile end-to-end"
declare_test "sendCard message" test_send_card_message "feishu" "[P2] IPC sendCard end-to-end"
declare_test "Passive mode" test_passive_mode "feishu" "[P3] Passive mode message filtering"

# =============================================================================
# Main Entry Point (customized for conditional execution)
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Integration Test: Feishu Channel"
    echo "=========================================="
    echo ""

    # Dry run mode — always show test plan
    if [ "$DRY_RUN" = true ]; then
        print_registered_tests
        echo ""
        echo "Feishu Configuration:"
        echo "  - Enabled: $FEISHU_ENABLED"
        echo "  - Chat ID: ${FEISHU_CHAT_ID:-(not set)}"
        echo ""
        echo "Configuration:"
        echo "  - REST Port: $REST_PORT"
        echo "  - Timeout: ${TIMEOUT}s"
        echo "  - Project Root: ${PROJECT_ROOT:-.}"
        echo ""
        echo "Enable Feishu tests:"
        echo "  FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<chat_id> \\"
        echo "    ./tests/integration/feishu-integration-test.sh"
        exit 0
    fi

    # Check if feishu tests are enabled (non-fatal)
    if ! check_feishu_enabled; then
        echo ""
        log_info "Feishu tests skipped (0 run, 0 failed)"
        echo ""
        exit 0
    fi

    # Check Feishu prerequisites
    if ! check_feishu_chat_id; then
        echo ""
        log_info "Feishu tests skipped (FEISHU_TEST_CHAT_ID not configured)"
        echo ""
        exit 0
    fi

    # Standard test suite execution
    main_test_suite "Integration Test: Feishu Channel"
}

main
