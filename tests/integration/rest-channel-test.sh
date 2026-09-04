#!/bin/bash
#
# Integration Test: REST Channel Basic Tests
#
# Tests REST Channel functionality without requiring a full Agent setup:
# - Health check, chat, error handling, unknown routes
#
# Usage:
#   ./tests/integration/rest-channel-test.sh [options]
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
HOST="${HOST:-127.0.0.1}"
TIMEOUT="${TIMEOUT:-30}"
CONFIG_PATH="${DISCLAUDE_CONFIG:-}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Test Functions
# =============================================================================

# Issue #4727: the sync POST /api/chat/sync endpoint returns only after the
# Agent turn completes, so a smoke test that verifies agent behavior leaves no
# idle background Agent in the shared process. The old async POST /api/chat
# returned as soon as the request was RECEIVED, spawning an Agent turn that
# could still be running when the next suite started (Issue #4725 pileup).
_test_sync_chat_ok() {
    local message="$1" chat_id="$2"
    assert_sync_chat_ok "$message" "$chat_id" || return 1
    log_pass "Agent turn completed (sync) for chat $chat_id"
}

# Issue #4727/#4725: poll /api/health until the Agent pool reports no busy
# turn. HTTP 200 on /api/chat only means "request received", NOT that the
# Agent finished — this helper makes that distinction observable and bounds it
# with a hard timeout.
wait_for_agent_pool_idle() {
    local timeout="${1:-30}" label="${2:-agent pool drain}" retry=0 busy=""
    while [ $retry -lt "$timeout" ]; do
        local result
        result=$(make_request "GET" "/api/health" 2>/dev/null) || true
        parse_response "$result"
        if [ "$RESPONSE_STATUS" = "200" ]; then
            # Shared extraction (common.sh::pool_busy) — keep in sync with
            # test-pool-idle.sh so the regression test pins the same logic.
            busy=$(pool_busy "$RESPONSE_BODY")
            if [ -z "$busy" ] || [ "$busy" = "0" ]; then
                log_pass "Agent pool idle (busy=0) — $label"
                return 0
            fi
        fi
        sleep 1
        retry=$((retry + 1))
    done
    log_fail "Agent pool not idle after ${timeout}s ($label): busy='${busy:-unparseable}' (Issue #4727)"
    return 1
}

test_health_check() {
    log_info "Testing: GET /api/health"

    local result
    result=$(make_request "GET" "/api/health")
    parse_response "$result"

    assert_status "200" "Health check" || return 1
    assert_body_contains '"status":"ok"' "Health check body" || return 1
}

test_chat_valid_request() {
    log_info "Testing: POST /api/chat/sync with valid message (Agent turn completes)"

    local chat_id="rest-sync-valid-$$"
    _test_sync_chat_ok "回复 OK 两个字即可" "$chat_id" || return 1
}

# Async POST /api/chat protocol test: a receipt (HTTP 200 + messageId) is NOT
# proof the Agent turn finished. This keeps coverage of the async path's field
# contract while explicitly proving the distinction (and draining the pool),
# so the REST suite never leaves an idle Agent for the next suite.
test_chat_async_receipt() {
    log_info "Testing: POST /api/chat returns receipt (HTTP 200) but Agent turn completes later"

    local result
    result=$(make_request "POST" "/api/chat" '{"message":"async protocol probe","chatId":"rest-async-probe-$$"}')
    parse_response "$result"

    assert_status "200" "Async chat receipt status" || return 1
    assert_body_contains '"success":true' "Async success field" || return 1
    assert_body_contains '"messageId"' "Async messageId field" || return 1
    # Issue #4727 regression: 200 ≠ completion — the pool must drain before
    # the suite is allowed to continue.
    wait_for_agent_pool_idle "${REST_DRAIN_TIMEOUT:-30}" "after async chat receipt" || return 1
}

test_chat_missing_message() {
    log_info "Testing: POST /api/chat with missing message"

    local result
    result=$(make_request "POST" "/api/chat" '{}')
    parse_response "$result"

    assert_status "400" "Chat missing message" || return 1
    assert_body_contains '"error"' "Chat missing message error" || return 1
}

# Raw curl for invalid JSON (tests non-JSON input path)
test_chat_invalid_json() {
    log_info "Testing: POST /api/chat with invalid JSON"

    local response status
    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${API_URL}/api/chat" \
        -H "Content-Type: application/json" \
        -d "not valid json" \
        --max-time "$TIMEOUT" 2>&1)
    status=$(echo "$response" | tail -n 1)

    if [ "$status" = "400" ]; then
        log_pass "Chat rejects invalid JSON with 400"
    else
        log_fail "Chat returned status $status (expected 400)"
    fi
}

test_chat_custom_chatid() {
    log_info "Testing: POST /api/chat/sync with custom chatId preserved"

    local chat_id="custom-test-id-123-$$"
    _test_sync_chat_ok "回复 OK 两个字即可" "$chat_id" || return 1
    assert_body_contains "\"chatId\":\"$chat_id\"" "Custom chatId preserved" || return 1
}

test_unknown_route() {
    log_info "Testing: 404 for unknown routes"

    local result
    result=$(make_request "GET" "/unknown/path")
    parse_response "$result"

    assert_status "404" "Unknown route" || return 1
}

test_control_missing_fields() {
    log_info "Testing: POST /api/control with missing fields"

    local result
    result=$(make_request "POST" "/api/control" '{"type":"reset"}')
    parse_response "$result"

    assert_status "400" "Control missing chatId" || return 1
}

# Raw curl for empty body (tests missing body path)
test_empty_body() {
    log_info "Testing: POST /api/chat with empty body"

    local response status
    response=$(curl -s -w "\n%{http_code}" \
        -X POST \
        "${API_URL}/api/chat" \
        -H "Content-Type: application/json" \
        --max-time "$TIMEOUT" 2>&1)
    status=$(echo "$response" | tail -n 1)

    if [ "$status" = "400" ]; then
        log_pass "Empty body returns 400"
    else
        log_fail "Empty body returned status $status (expected 400)"
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify /api/health endpoint"
declare_test "Chat valid request" test_chat_valid_request "fast" "Agent behavior via /api/chat/sync"
declare_test "Chat async receipt" test_chat_async_receipt "fast" "Async 200 != completion (receipt + drain)"
declare_test "Chat missing message" test_chat_missing_message "fast" "Error handling (400)"
declare_test "Chat invalid JSON" test_chat_invalid_json "fast" "Error handling (400)"
declare_test "Custom chatId" test_chat_custom_chatid "fast" "Verify chatId preservation"
declare_test "Unknown route 404" test_unknown_route "fast" "Test 404 response"
declare_test "Control missing fields" test_control_missing_fields "fast" "Error handling (400)"
declare_test "Empty body" test_empty_body "fast" "Error handling (400)"

main_test_suite "REST Channel Integration Tests"
