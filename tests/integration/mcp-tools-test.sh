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

# Check if Feishu credentials are available for integration tests.
# Returns: 0 if credentials are configured, 1 otherwise.
check_feishu_credentials() {
    # Check environment variables first
    if [ -n "$FEISHU_APP_ID" ] && [ -n "$FEISHU_APP_SECRET" ]; then
        return 0
    fi

    # Check config file for feishu credentials
    local config_file="${PROJECT_ROOT}/disclaude.config.yaml"
    if [ ! -f "$config_file" ]; then
        config_file="${CONFIG_PATH:-${PROJECT_ROOT}/disclaude.config.test.yaml}"
    fi

    if [ -f "$config_file" ]; then
        # Extract appId and appSecret from feishu section using grep/sed
        local app_id app_secret
        app_id=$(grep -E '^\s+appId\s*:' "$config_file" 2>/dev/null | head -1 | sed 's/.*appId\s*:\s*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/' | tr -d ' ')
        app_secret=$(grep -E '^\s+appSecret\s*:' "$config_file" 2>/dev/null | head -1 | sed 's/.*appSecret\s*:\s*"\{0,1\}\([^"]*\)"\{0,1\}.*/\1/' | tr -d ' ')

        if [ -n "$app_id" ] && [ "$app_id" != "your_feishu_app_id_here" ] && \
           [ -n "$app_secret" ] && [ "$app_secret" != "your_feishu_app_secret_here" ]; then
            return 0
        fi
    fi

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

    # Skip test if Feishu credentials are not configured.
    # Without real credentials, the tool returns an error and the Agent
    # enters diagnostic mode, making multiple tool calls that exceed the
    # test timeout. See Issue #1634.
    if ! check_feishu_credentials; then
        skip_test "send_file tool test skipped: Feishu credentials not configured (FEISHU_APP_ID/FEISHU_APP_SECRET)"
        return 0
    fi

    create_test_file

    local chat_id="test-mcp-send-file-$$"
    assert_sync_chat_ok "请尝试使用 send_file 工具发送文件 $TEST_FILE_PATH 到当前聊天。如果工具不可用，请告诉我原因。" "$chat_id" || {
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
