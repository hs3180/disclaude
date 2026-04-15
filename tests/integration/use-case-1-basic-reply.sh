#!/bin/bash
#
# Integration Test: Use Case 1 - Basic Reply
#
# Tests the most basic conversation scenario:
# User sends a message, Agent correctly replies.
#
# Usage:
#   ./tests/integration/use-case-1-basic-reply.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 30)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-30}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

test_basic_greeting() {
    log_info "Test: Basic greeting (你好)..."

    assert_sync_chat_ok "你好" || return 1

    # Validate response contains greeting keywords
    if echo "$RESPONSE_TEXT" | grep -iqE "你好|hello|hi|help|有什么|我可以|帮助"; then
        log_pass "Agent responded with a greeting"
    else
        log_fail "Agent response does not contain greeting keywords"
        return 1
    fi
}

test_custom_chatid() {
    log_info "Test: Custom chatId preservation..."

    local custom_chat_id="cli-test-use-case-1-$$"
    assert_sync_chat_ok "你好" "$custom_chat_id" || return 1

    # Check chatId is preserved in response body
    if echo "$RESPONSE_BODY" | grep -q "\"chatId\":\"$custom_chat_id\""; then
        log_pass "Custom chatId preserved in response"
    else
        log_fail "Custom chatId not preserved in response"
        log_debug "Expected chatId: $custom_chat_id"
        return 1
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "Basic greeting" test_basic_greeting "ai" "Agent responds to '你好'"
declare_test "Custom chatId" test_custom_chatid "fast" "Verify chatId preservation"

main_test_suite "Integration Test: Use Case 1 - Basic Reply"
