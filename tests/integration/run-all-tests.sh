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
#   --retries N         Max retries per test suite on failure (default: 2)
#   --delay SECONDS     Delay between test suites for rate limit avoidance (default: 5)
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
MAX_RETRIES="${MAX_RETRIES:-2}"
INTER_SUITE_DELAY="${INTER_SUITE_DELAY:-5}"
RETRY_INITIAL_DELAY="${RETRY_INITIAL_DELAY:-5}"
RETRY_BACKOFF="${RETRY_BACKOFF:-2}"

source "$SCRIPT_DIR/common.sh"
parse_common_args "$@"
register_cleanup

# Additional args for tag/test filtering (passthrough to sub-scripts)
FILTER_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --retries) MAX_RETRIES="$2"; shift 2 ;;
        --delay) INTER_SUITE_DELAY="$2"; shift 2 ;;
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
    echo "  - Default Timeout: ${TIMEOUT}s"
    echo "  - Per-Suite Timeouts:"
    echo "      - Use Case 2 (Task Execution): 180s (multi-round LLM tool calls)"
    echo "      - MCP Tools Tests: 180s (multi-round tool calls)"
    echo "      - All other suites: ${TIMEOUT}s (default)"
    echo "  - Max Retries: ${MAX_RETRIES}"
    echo "  - Inter-suite Delay: ${INTER_SUITE_DELAY}s (rate limit avoidance)"
    echo "  - Retry Backoff: ${RETRY_INITIAL_DELAY}s × ${RETRY_BACKOFF}^attempt"
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
    local suite_timeout="${3:-$TIMEOUT}"
    local args=()

    args+=("--port" "$REST_PORT")
    args+=("--timeout" "$suite_timeout")
    if [ "$VERBOSE" = true ]; then
        args+=("--verbose")
    fi
    # Passthrough filter args
    args+=("${FILTER_ARGS[@]}")

    local attempt=1
    local max_attempts=$((MAX_RETRIES + 1))

    while [ $attempt -le $max_attempts ]; do
        echo ""
        echo "=========================================="
        echo "  Running: $name (attempt ${attempt}/${max_attempts})"
        echo "=========================================="

        if bash "$script" "${args[@]}"; then
            if [ $attempt -gt 1 ]; then
                log_warn "$name passed on attempt ${attempt}/${max_attempts}"
                RETRIED_SUCCESSES=$((RETRIED_SUCCESSES + 1))
            fi
            return 0
        else
            if [ $attempt -lt $max_attempts ]; then
                local delay=$((RETRY_INITIAL_DELAY * RETRY_BACKOFF ** (attempt - 1)))
                log_warn "$name failed (attempt ${attempt}/${max_attempts}), retrying in ${delay}s (exponential backoff)..."
                sleep "$delay"
            fi
        fi

        attempt=$((attempt + 1))
    done

    log_error "$name failed after ${max_attempts} attempt(s)"
    TOTAL_RETRIES=$((TOTAL_RETRIES + MAX_RETRIES))
    return 1
}

# Run a test suite with inter-suite delay
# Delay is skipped before the first suite and after retries
_SUITE_COUNT=0

run_suite() {
    local script="$1"
    local name="$2"
    local suite_timeout="${3:-$TIMEOUT}"

    # Add delay before suite (skip for the very first one)
    if [ $_SUITE_COUNT -gt 0 ] && [ "$INTER_SUITE_DELAY" -gt 0 ] 2>/dev/null; then
        log_info "Waiting ${INTER_SUITE_DELAY}s before next suite (rate limit avoidance)..."
        sleep "$INTER_SUITE_DELAY"
    fi
    _SUITE_COUNT=$((_SUITE_COUNT + 1))

    run_test_script "$script" "$name" "$suite_timeout"
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
    echo "  - Default Timeout: ${TIMEOUT}s"
    echo "  - Per-Suite Timeouts:"
    echo "      - Use Case 2 (Task Execution): 180s"
    echo "      - MCP Tools Tests: 180s"
    echo "      - All other suites: ${TIMEOUT}s (default)"
    echo "  - Max Retries: ${MAX_RETRIES}"
    echo "  - Inter-suite Delay: ${INTER_SUITE_DELAY}s"
    echo ""

    log_info "Starting test server..."
    start_server || exit 1

    local failed=0
    local RETRIED_SUCCESSES=0
    local TOTAL_RETRIES=0

    if ! run_suite "$SCRIPT_DIR/rest-channel-test.sh" "REST Channel Tests"; then
        failed=$((failed + 1))
    fi

    if ! run_suite "$SCRIPT_DIR/use-case-1-basic-reply.sh" "Use Case 1 - Basic Reply"; then
        failed=$((failed + 1))
    fi

    if ! run_suite "$SCRIPT_DIR/use-case-2-task-execution.sh" "Use Case 2 - Task Execution" 180; then
        failed=$((failed + 1))
    fi

    if ! run_suite "$SCRIPT_DIR/use-case-3-multi-turn.sh" "Use Case 3 - Multi-turn Conversation"; then
        failed=$((failed + 1))
    fi

    if ! run_suite "$SCRIPT_DIR/mcp-tools-test.sh" "MCP Tools Tests" 180; then
        failed=$((failed + 1))
    fi

    if ! run_suite "$SCRIPT_DIR/multimodal-test.sh" "Multimodal Tests"; then
        failed=$((failed + 1))
    fi

    echo ""
    echo "=========================================="
    if [ $failed -eq 0 ]; then
        log_info "All test suites passed!"
    else
        log_error "$failed test suite(s) failed"
    fi
    if [ $RETRIED_SUCCESSES -gt 0 ]; then
        log_warn "${RETRIED_SUCCESSES} suite(s) passed after retry"
    fi
    echo "=========================================="

    cleanup
    exit $failed
}

main
