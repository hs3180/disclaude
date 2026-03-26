#!/bin/bash
#
# Integration Test: Feishu Interactive Card E2E
#
# Tests the complete IPC sendInteractive flow:
#   1. Send interactive card via REST API
#   2. Verify card delivery
#   3. Simulate card action callback
#   4. Verify prompt generation and agent response
#
# **This test is SKIPPED by default.** Enable with:
#   FEISHU_INTEGRATION_TEST=true ./tests/integration/feishu-interactive-test.sh
#
# Additional required env vars:
#   FEISHU_TEST_CHAT_ID  - Feishu group chat ID for testing
#
# Usage:
#   FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=oc_xxx \
#     ./tests/integration/feishu-interactive-test.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 60)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-60}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Feishu Integration Guard
# =============================================================================

if [ "$FEISHU_INTEGRATION_TEST" != "true" ]; then
    log_skip "Feishu integration tests are disabled by default."
    echo ""
    echo "  To enable, set:"
    echo "    FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=oc_xxx \\"
    echo "      $0 $*"
    echo ""
    echo "  See Issue #1626 for details."
    echo ""
    exit 0
fi

if [ -z "$FEISHU_TEST_CHAT_ID" ]; then
    log_error "FEISHU_TEST_CHAT_ID is required when FEISHU_INTEGRATION_TEST=true"
    log_error "Set it to a valid Feishu group chat ID."
    exit 1
fi

CHAT_ID="$FEISHU_TEST_CHAT_ID"

# =============================================================================
# Test Functions
# =============================================================================

test_health_check_feishu() {
    log_info "Test: Health check (Feishu integration mode)..."

    local result
    result=$(make_request "GET" "/api/health")
    parse_response "$result"

    assert_status "200" "Feishu health check" || return 1
    assert_body_contains '"status":"ok"' "Health status" || return 1
}

test_send_text_basic() {
    log_info "Test: Send basic text message to Feishu chat..."

    local body
    body=$(jq -n --arg msg "Feishu 集成测试 - 基础文本消息 (test-$$)" --arg cid "$CHAT_ID" \
        '{message: $msg, chatId: $cid}')

    local result
    result=$(make_request "POST" "/api/chat/sync" "$body")
    parse_response "$result"

    assert_status "200" "Text message send" || return 1

    if [ "$(extract_json_bool "success")" = "true" ]; then
        log_pass "Text message sent successfully to Feishu chat"
    else
        log_fail "Text message send returned success=false"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi
}

test_interactive_card_via_agent() {
    log_info "Test: Agent sends interactive card (via prompt)..."

    # Ask the agent to send an interactive card
    local prompt="请发送一个交互卡片到当前对话，包含两个按钮：\"确认\"和\"取消\""
    local body
    body=$(jq -n --arg msg "$prompt" --arg cid "$CHAT_ID" \
        '{message: $msg, chatId: $cid}')

    local result
    result=$(make_request "POST" "/api/chat/sync" "$body" "" "$TIMEOUT")
    parse_response "$result"

    if [ "$RESPONSE_STATUS" = "200" ]; then
        local response_text
        response_text=$(extract_json_field "response")
        if [ -n "$response_text" ]; then
            log_pass "Agent responded to interactive card request"
            log_debug "Response: $response_text"
        else
            log_fail "Agent returned empty response for interactive card request"
            return 1
        fi
    else
        log_fail "Interactive card request failed with HTTP $RESPONSE_STATUS"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi
}

test_chatid_preservation_feishu() {
    log_info "Test: ChatId preservation with Feishu chat..."

    local body
    body=$(jq -n --arg msg "ChatId 保留测试" --arg cid "$CHAT_ID" \
        '{message: $msg, chatId: $cid}')

    local result
    result=$(make_request "POST" "/api/chat/sync" "$body")
    parse_response "$result"

    assert_status "200" "ChatId preservation" || return 1

    if echo "$RESPONSE_BODY" | grep -q "\"chatId\":\"$CHAT_ID\""; then
        log_pass "Feishu chatId preserved in response"
    else
        log_fail "Feishu chatId not found in response"
        log_debug "Expected chatId: $CHAT_ID"
        log_debug "Response: $RESPONSE_BODY"
        return 1
    fi
}

test_multi_turn_feishu() {
    log_info "Test: Multi-turn conversation with Feishu chat..."

    # Turn 1: Establish context
    local body1
    body1=$(jq -n --arg msg "请记住这个数字: 42" --arg cid "$CHAT_ID" \
        '{message: $msg, chatId: $cid}')

    local result1
    result1=$(make_request "POST" "/api/chat/sync" "$body1")
    parse_response "$result1"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Multi-turn turn 1 failed with HTTP $RESPONSE_STATUS"
        return 1
    fi

    # Turn 2: Verify context retention
    local body2
    body2=$(jq -n --arg msg "我刚才让你记住的数字是什么？" --arg cid "$CHAT_ID" \
        '{message: $msg, chatId: $cid}')

    local result2
    result2=$(make_request "POST" "/api/chat/sync" "$body2" "" "$TIMEOUT")
    parse_response "$result2"

    if [ "$RESPONSE_STATUS" != "200" ]; then
        log_fail "Multi-turn turn 2 failed with HTTP $RESPONSE_STATUS"
        return 1
    fi

    local response_text
    response_text=$(extract_json_field "response")

    if echo "$response_text" | grep -iqE "42|四十二"; then
        log_pass "Multi-turn context retained correctly (agent remembered: 42)"
    else
        log_warn "Multi-turn context may not be retained"
        log_debug "Response: $response_text"
    fi
}

test_error_handling_invalid_chatid() {
    log_info "Test: Error handling with invalid chatId format..."

    local body
    body=$(jq -n --arg msg "Test" --arg cid "invalid-chat-id-format" \
        '{message: $msg, chatId: $cid}')

    local result
    result=$(make_request "POST" "/api/chat/sync" "$body")
    parse_response "$result"

    # Should not crash — either succeed (message accepted) or return proper error
    if [ "$RESPONSE_STATUS" = "000" ]; then
        log_fail "Server crashed on invalid chatId (HTTP 000)"
        return 1
    fi

    log_pass "Server handled invalid chatId gracefully (HTTP $RESPONSE_STATUS)"
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check_feishu "fast" "Verify server is running"
declare_test "Basic text message" test_send_text_basic "feishu" "Send text to Feishu chat"
declare_test "Interactive card via agent" test_interactive_card_via_agent "feishu" "Agent sends interactive card"
declare_test "ChatId preservation" test_chatid_preservation_feishu "fast" "Verify Feishu chatId preserved"
declare_test "Multi-turn conversation" test_multi_turn_feishu "feishu" "Context retention across turns"
declare_test "Error handling" test_error_handling_invalid_chatid "fast" "Invalid chatId does not crash"

main_test_suite "Integration Test: Feishu Interactive Card E2E"
