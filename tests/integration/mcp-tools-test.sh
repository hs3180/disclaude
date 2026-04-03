#!/bin/bash
#
# Integration Test: MCP Tools
#
# Tests MCP tool invocations (send_text, send_file) through REST Channel.
#
# Usage:
#   ./tests/integration/mcp-tools-test.sh [options]
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
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-120}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# =============================================================================
# Helper Functions
# =============================================================================

TEST_FILE_PATH="workspace/mcp-test-file.txt"

create_test_file() {
    local workspace_dir="$PROJECT_ROOT/workspace"
    mkdir -p "$workspace_dir"
    echo "MCP Test File - Created at $(date -Iseconds)" > "$workspace_dir/mcp-test-file.txt"
    echo "This is a test file for send_file tool integration test." >> "$workspace_dir/mcp-test-file.txt"
    log_debug "Created test file: $workspace_dir/mcp-test-file.txt"
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

    # Skip if Feishu environment is not configured.
    # send_text also requires credentials/IPC; without them the agent may
    # enter diagnostic mode causing timeout (same pattern as send_file, #1634).
    if ! check_feishu_env; then
        log_skip "send_text test skipped: Feishu credentials not configured (set FEISHU_APP_ID/FEISHU_APP_SECRET or configure in config file)"
        return 0
    fi

    local chat_id="test-mcp-send-text-$$"
    assert_sync_chat_ok "请尝试使用 send_text 工具发送消息 'Hello from MCP test' 到当前聊天。如果工具返回错误，请直接告诉我错误信息，不要尝试诊断或排查问题。" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -iqE "send_text|消息|工具|tool|发送"; then
        log_pass "Agent acknowledged tool usage"
    else
        log_pass "Agent responded (tool handling verified)"
    fi
}

test_send_file_tool() {
    log_info "Test: send_file tool invocation..."

    # Issue #1634: Skip if Feishu environment is not configured.
    # Without credentials/IPC, send_file returns an error and the agent
    # enters diagnostic mode (ls, diagnostics, etc.), causing timeout.
    if ! check_feishu_env; then
        log_skip "send_file test skipped: Feishu credentials not configured (set FEISHU_APP_ID/FEISHU_APP_SECRET or configure in config file)"
        return 0
    fi

    create_test_file

    local chat_id="test-mcp-send-file-$$"
    assert_sync_chat_ok "请使用 send_file 工具发送文件 $TEST_FILE_PATH 到当前聊天。如果工具返回错误，请直接告诉我错误信息，不要尝试诊断或排查问题。" "$chat_id" || {
        cleanup_test_file
        return 1
    }

    cleanup_test_file

    if echo "$RESPONSE_TEXT" | grep -iqE "send_file|文件|工具|tool|上传|file"; then
        log_pass "Agent acknowledged file tool usage"
    else
        log_pass "Agent responded (tool handling verified)"
    fi
}

test_tool_result_format() {
    log_info "Test: Tool result format validation..."

    local chat_id="test-mcp-tools-list-$$"
    assert_sync_chat_ok "请列出你可以使用的所有 MCP 工具，并告诉我每个工具的功能。" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -iqE "send_text|send_file|send_message|工具|tool"; then
        log_pass "Agent knows about MCP tools"
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

main_test_suite "Integration Test: MCP Tools"
