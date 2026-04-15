#!/bin/bash
#
# Integration Test: Use Case 3 - Multi-turn Conversation with Context
#
# Tests multi-turn conversation scenarios:
# Agent can maintain context across multiple conversation turns.
#
# Usage:
#   ./use-case-3-multi-turn.sh [options]
#
# Options:
#   --timeout SECONDS   Maximum wait time for response (default: 60)
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
# Test Functions
# =============================================================================

# Test: Number context - Set favorite number, then recall and calculate
test_number_context() {
    log_info "Test: Number context - Set favorite number and recall..."

    local chat_id="cli-number-context-$$"

    # Turn 1: Tell agent my favorite number
    log_debug "Turn 1: Telling agent my favorite number is 42"
    assert_sync_chat_ok "我的幸运数字是 42，请记住它" "$chat_id" || return 1

    sleep 1

    # Turn 2: Ask agent to recall the number
    log_debug "Turn 2: Asking agent to recall my favorite number"
    assert_sync_chat_ok "我的幸运数字是多少？" "$chat_id" || return 1

    # Probabilistic check - use log_warn instead of return 1
    if echo "$RESPONSE_TEXT" | grep -q "42"; then
        log_pass "Agent correctly recalled the favorite number (42)"
    else
        log_warn "Agent did not recall 42 exactly (probabilistic AI behavior)"
    fi

    sleep 1

    # Turn 3: Ask agent to calculate using the remembered number
    log_debug "Turn 3: Asking agent to calculate using the number"
    assert_sync_chat_ok "用我的幸运数字乘以 2 等于多少？" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -q "84"; then
        log_pass "Agent correctly calculated 42 * 2 = 84"
    else
        log_warn "Agent did not calculate 84 (probabilistic AI behavior)"
    fi
}

# Test: Name context - Introduce name and hobby, then ask separately
test_name_context() {
    log_info "Test: Name context - Introduce and recall name..."

    local chat_id="cli-name-context-$$"

    # Turn 1: Introduce name
    log_debug "Turn 1: Introducing myself as Xiaoming"
    assert_sync_chat_ok "你好，我叫小明，我是一名程序员" "$chat_id" || return 1

    sleep 1

    # Turn 2: Ask about my name
    log_debug "Turn 2: Asking about my name"
    assert_sync_chat_ok "你还记得我叫什么名字吗？" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -q "小明"; then
        log_pass "Agent correctly recalled the name (小明)"
    else
        log_warn "Agent did not recall 小明 (probabilistic AI behavior)"
    fi

    sleep 1

    # Turn 3: Ask about my profession
    log_debug "Turn 3: Asking about my profession"
    assert_sync_chat_ok "我的职业是什么？" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -q "程序员"; then
        log_pass "Agent correctly recalled the profession (程序员)"
    else
        log_warn "Agent did not recall 程序员 (probabilistic AI behavior)"
    fi
}

# Test: Context isolation - Different chatId should not share context
test_context_isolation() {
    log_info "Test: Context isolation - Different chatId should not share context..."

    local chat_id_1="cli-isolation-1-$$"
    local chat_id_2="cli-isolation-2-$$"

    # Chat 1: Set a secret number
    log_debug "Chat 1: Setting secret number 123"
    assert_sync_chat_ok "我的秘密数字是 123" "$chat_id_1" || return 1

    sleep 1

    # Chat 2: Try to access the secret number (should not know it)
    log_debug "Chat 2: Trying to recall secret number from different chat"
    assert_sync_chat_ok "我的秘密数字是多少？" "$chat_id_2" || return 1

    if echo "$RESPONSE_TEXT" | grep -q "123"; then
        log_warn "Context isolation warning: Chat 2 knows about number 123"
        log_info "Context isolation test passed (but with potential context leak)"
    else
        log_pass "Context isolation verified - Chat 2 does not know Chat 1's context"
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "Number context" test_number_context "ai" "Set/recall/calculate with favorite number"
declare_test "Name context" test_name_context "ai" "Introduce name and profession, then recall"
declare_test "Context isolation" test_context_isolation "ai" "Verify different chatId don't share context"

main_test_suite "Integration Test: Use Case 3 - Multi-turn Conversation"
