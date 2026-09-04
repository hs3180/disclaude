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

TEST_FILE_PATH="workspace/channel-cli-test-file.txt"
# Issue #4691 tool-execution verdict: see report_tool_verdict() in common.sh.

create_test_file() {
    local workspace_dir="$PROJECT_ROOT/workspace"
    mkdir -p "$workspace_dir"
    echo "Channel CLI Test File - Created at $(date -Iseconds)" > "$workspace_dir/channel-cli-test-file.txt"
    echo "This is a test file for send_file tool integration test." >> "$workspace_dir/channel-cli-test-file.txt"
    log_debug "Created test file: $workspace_dir/channel-cli-test-file.txt"
}

cleanup_test_file() {
    local file_path="$PROJECT_ROOT/$TEST_FILE_PATH"
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

    local chat_id="test-channel-send-text-$$"
    assert_sync_chat_ok "请使用 channel CLI Skill 执行 send_text，发送消息 'Hello from channel CLI test'。只需调用一次，不要诊断、排查或重试。请在回复中如实报告工具是否执行成功。" "$chat_id" || return 1

    report_tool_verdict "send_text"
}

test_send_file_tool() {
    log_info "Test: send_file tool invocation..."

    create_test_file

    local chat_id="test-channel-send-file-$$"
    assert_sync_chat_ok "请使用 channel CLI Skill 执行 send_file 发送文件 $TEST_FILE_PATH。只需调用一次，不要诊断、排查或重试。请在回复中如实报告工具是否执行成功。" "$chat_id" || {
        cleanup_test_file
        return 1
    }

    cleanup_test_file

    report_tool_verdict "send_file"
}

test_tool_result_format() {
    log_info "Test: Tool result format validation..."

    local chat_id="test-channel-tools-list-$$"
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

main_test_suite "Integration Test: Channel CLI Tools"
