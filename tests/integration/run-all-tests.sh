#!/bin/bash
#
# Integration Test: Run All Tests
#
# This script runs all integration tests in sequence, sharing a single
# server instance to reduce startup overhead.
#
# Prerequisites:
# - Node.js installed
# - disclaude built (npm run build)
# - Valid disclaude.config.yaml with AI provider configured
#
# Usage:
#   ./tests/integration/run-all-tests.sh [options]
#
# Options:
#   --timeout SECONDS   Request timeout (default: 60)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#   --tag TAG           Filter tests by tag (fast, ai)
#   --test NAME         Filter tests by name (substring match)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-60}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# Additional args for tag/test filtering (passthrough to sub-scripts)
FILTER_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --tag|--name) FILTER_ARGS+=("$1" "$2"); shift 2 ;;
        *) shift ;;
    esac
done

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan_body() {
    echo ""
    echo "Test Suites:"
    echo "  1. REST Channel Tests (8 tests)"
    echo "     - Health check, chat, error handling"
    echo ""
    echo "  2. Use Case 1 - Basic Reply (3 tests)"
    echo "     - Health check, basic greeting, chatId preservation"
    echo ""
    echo "  3. Use Case 2 - Task Execution (4 tests)"
    echo "     - Health check, calculation, file listing, text analysis"
    echo ""
    echo "  4. Use Case 3 - Multi-turn Conversation (4 tests)"
    echo "     - Health check, number context, name context, context isolation"
    echo ""
    echo "  5. MCP Tools Tests (4 tests)"
    echo "     - Health check, send_text, send_file, tool result format"
    echo ""
    echo "  6. Multimodal Tests (5 tests)"
    echo "     - Health check, single image, multi-image, mixed message, screenshot"
    echo ""
    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo "  - Project Root: $PROJECT_ROOT"
    echo ""
    echo "Prerequisites:"
    echo "  - Node.js installed"
    echo "  - disclaude built (npm run build)"
    echo "  - Valid disclaude.config.yaml"
    echo "  - API key configured in config file"
    echo ""
}

# =============================================================================
# Test Runner Functions
# =============================================================================

run_test_script() {
    local script="$1"
    local name="$2"
    local args=()

    args+=("--port" "$REST_PORT")
    args+=("--timeout" "$TIMEOUT")
    if [ "$VERBOSE" = true ]; then
        args+=("--verbose")
    fi
    # Passthrough filter args
    args+=("${FILTER_ARGS[@]}")

    echo ""
    echo "=========================================="
    echo "  Running: $name"
    echo "=========================================="

    if bash "$script" "${args[@]}"; then
        return 0
    else
        return 1
    fi
}

# =============================================================================
# Main Test Runner
# =============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  Integration Tests: All Test Suites"
    echo "=========================================="
    echo ""

    if [ "$DRY_RUN" = true ]; then
        echo "  (Dry Run - Test Plan Only)"
        show_test_plan_body
        exit 0
    fi

    check_prerequisites || exit 1

    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo ""

    log_info "Starting test server..."
    start_server || exit 1

    local failed=0

    if ! run_test_script "$SCRIPT_DIR/rest-channel-test.sh" "REST Channel Tests"; then
        failed=$((failed + 1))
    fi

    if ! run_test_script "$SCRIPT_DIR/use-case-1-basic-reply.sh" "Use Case 1 - Basic Reply"; then
        failed=$((failed + 1))
    fi

    if ! run_test_script "$SCRIPT_DIR/use-case-2-task-execution.sh" "Use Case 2 - Task Execution"; then
        failed=$((failed + 1))
    fi

    if ! run_test_script "$SCRIPT_DIR/use-case-3-multi-turn.sh" "Use Case 3 - Multi-turn Conversation"; then
        failed=$((failed + 1))
    fi

    if ! run_test_script "$SCRIPT_DIR/mcp-tools-test.sh" "MCP Tools Tests"; then
        failed=$((failed + 1))
    fi

    if ! run_test_script "$SCRIPT_DIR/multimodal-test.sh" "Multimodal Tests"; then
        failed=$((failed + 1))
    fi

    echo ""
    echo "=========================================="
    if [ $failed -eq 0 ]; then
        log_info "All test suites passed!"
    else
        log_error "$failed test suite(s) failed"
    fi
    echo "=========================================="

    cleanup
    exit $failed
}

main
