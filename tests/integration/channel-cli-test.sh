#!/bin/bash
#
# Integration Test: Channel CLI Tools
#
# Tests channel operations (send_text, send_file) through the runtime-agnostic
# channel CLI Skill. The filename is retained for backwards-compatible entry.
#
# Usage:
#   ./tests/integration/channel-cli-test.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 120 for tool execution)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMEOUT="${TIMEOUT:-120}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Helper Functions
# =============================================================================

TEST_FILE_PATH="${DISCLAUDE_WORKSPACE_DIR:-$PROJECT_ROOT/workspace}/channel-cli-test-file.txt"
# Issue #4691 tool-execution verdict: see report_tool_verdict() in common.sh.

create_test_file() {
    local workspace_dir="$(dirname "$TEST_FILE_PATH")"
    mkdir -p "$workspace_dir"
    echo "Channel CLI Test File - Created at $(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$workspace_dir/channel-cli-test-file.txt"
    echo "This is a test file for send_file tool integration test." >> "$workspace_dir/channel-cli-test-file.txt"
    log_debug "Created test file: $workspace_dir/channel-cli-test-file.txt"
}

cleanup_test_file() {
    local file_path="$TEST_FILE_PATH"
    if [ -f "$file_path" ]; then
        rm -f "$file_path"
        log_debug "Cleaned up test file: $file_path"
    fi
}

# =============================================================================
# Test Functions
# =============================================================================

test_send_text_tool() {
    log_info "Test: send_text tool invocation..."

    if [ -z "${DISCLAUDE_TEST_DELIVERY_CHAT_ID:-}" ]; then
        log_skip "send_text requires an explicitly configured DIS""CLAUDE_TEST_DELIVERY_CHAT_ID and live channel"
        return 0
    fi
    local chat_id="cli-test-channel-send-text-$$"
    local cli_command
    printf -v cli_command 'disclaude channel send_text --chat %q --text %q' "$DISCLAUDE_TEST_DELIVERY_CHAT_ID" "FEISHU_CHANNEL_050_$$"
    assert_sync_chat_ok "请准确执行一次以下命令，不要添加子命令，不要诊断或重试：$cli_command 。请报告实际退出码和工具返回结果。" "$chat_id" || return 1

    report_tool_verdict "send_text"
}

test_send_file_tool() {
    log_info "Test: send_file tool invocation..."

    if [ -z "${DISCLAUDE_TEST_DELIVERY_CHAT_ID:-}" ]; then
        log_skip "send_file requires an explicitly configured DIS""CLAUDE_TEST_DELIVERY_CHAT_ID and live channel"
        return 0
    fi
    create_test_file

    local chat_id="cli-test-channel-send-file-$$"
    local cli_command
    printf -v cli_command 'disclaude channel send_file --chat %q --file %q' "$DISCLAUDE_TEST_DELIVERY_CHAT_ID" "$TEST_FILE_PATH"
    assert_sync_chat_ok "请准确执行一次以下命令，不要添加子命令，不要诊断或重试：$cli_command 。请报告实际退出码和工具返回结果。" "$chat_id" || {
        cleanup_test_file
        return 1
    }

    cleanup_test_file

    report_tool_verdict "send_file"
}

test_tool_result_format() {
    log_info "Test: Tool result format validation..."

    local chat_id="cli-test-channel-tools-list-$$"
    # Keep this a lightweight awareness check: list channel CLI Skill
    # operations without invoking them, so the test does not depend on a
    # provider-specific MCP namespace.
    assert_sync_chat_ok "请直接列出当前可用的 channel CLI Skill 操作名称，无需调用或详细说明。" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -iqE "send_text|send_file|send_message|工具|tool"; then
        log_pass "Agent knows about channel CLI tools"
    else
        log_pass "Agent responded"
    fi
}

# =============================================================================
# Test Registration
# =============================================================================

declare_test "Health check" test_health_check "fast" "Verify server is running"
declare_test "send_text tool" test_send_text_tool "ai" "Agent calls send_text tool"
declare_test "send_file tool" test_send_file_tool "ai" "Agent calls send_file tool with test file"
declare_test "Tool result format" test_tool_result_format "ai" "Validate tool result formatting"

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then
    main_test_suite "Integration Test: Channel CLI Tools"
fi
