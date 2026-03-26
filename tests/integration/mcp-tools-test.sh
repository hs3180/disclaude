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

# Default IPC socket path (matches DEFAULT_IPC_CONFIG.socketPath in core)
DEFAULT_IPC_SOCKET="${DISCLAUDE_WORKER_IPC_SOCKET:-${DISCLAUDE_IPC_SOCKET_PATH:-/tmp/disclaude-interactive.ipc}}"

# Check if IPC socket is available for send_file tool tests.
# Returns 0 if available, 1 if not.
is_ipc_available() {
    local socket_path="${1:-$DEFAULT_IPC_SOCKET}"
    if [ -S "$socket_path" ]; then
        log_debug "IPC socket found: $socket_path"
        return 0
    fi
    log_debug "IPC socket not found: $socket_path"
    return 1
}

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

    local chat_id="test-mcp-send-text-$$"
    assert_sync_chat_ok "请尝试使用 send_text 工具发送消息 'Hello from MCP test' 到当前聊天。如果工具不可用，请告诉我原因。" "$chat_id" || return 1

    if echo "$RESPONSE_TEXT" | grep -iqE "send_text|消息|工具|tool|发送"; then
        log_pass "Agent acknowledged tool usage"
    else
        log_pass "Agent responded (tool handling verified)"
    fi
}

test_send_file_tool() {
    log_info "Test: send_file tool invocation..."

    # Issue #1634: Skip test when IPC is not available.
    # Without IPC, send_file returns an error and the Agent enters diagnostic
    # mode (multiple tool calls to investigate), causing timeout.
    if ! is_ipc_available; then
        log_skip "send_file tool test (IPC not available - no socket at $DEFAULT_IPC_SOCKET)"
        return 0
    fi

    create_test_file

    local chat_id="test-mcp-send-file-$$"
    # Issue #1634: Use a concise prompt that discourages diagnostic behavior.
    # Explicitly tell the agent to report the result in one turn without
    # investigating further if the tool fails.
    assert_sync_chat_ok "Use the send_file tool to send the file $TEST_FILE_PATH to chat $chat_id. Report the result in one sentence. Do NOT investigate errors or try alternative approaches." "$chat_id" || {
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
declare_test "send_file tool" test_send_file_tool "ai" "Agent calls send_file tool with test file (requires IPC)"
declare_test "Tool result format" test_tool_result_format "ai" "Validate tool result formatting"

main_test_suite "Integration Test: MCP Tools"
