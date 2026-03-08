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
#   --timeout SECONDS   Request timeout (default: 180)
#   --port PORT         REST API port (default: 3099)
#   --verbose           Enable verbose output
#   --dry-run           Show test plan without executing
#

set -e

# =============================================================================
# Configuration
# =============================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Set defaults before sourcing common.sh
REST_PORT="${REST_PORT:-3099}"
TIMEOUT="${TIMEOUT:-180}"

# Source common functions
source "$SCRIPT_DIR/common.sh"

# Parse common arguments
parse_common_args "$@"

# Register cleanup handler
register_cleanup

# =============================================================================
# Test Plan (Dry Run)
# =============================================================================

show_test_plan() {
    echo ""
    echo "=========================================="
    echo "  Integration Tests: All Test Suites"
    echo "  (Dry Run - Test Plan Only)"
    echo "=========================================="
    echo ""
    echo "Test Suites:"
    echo "  1. REST Channel Tests (10 tests)"
    echo "     - Health check, chat, error handling, CORS"
    echo ""
    echo "  2. Use Case 1 - Basic Reply (3 tests)"
    echo "     - Health check, basic greeting, chatId preservation"
    echo ""
    echo "  3. Use Case 2 - Task Execution (4 tests)"
    echo "     - Health check, calculation, file listing, text analysis"
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

# Run a test script and capture its result
run_test_script() {
    local script="$1"
    local name="$2"
    local args=()

    # Build arguments
    args+=("--port" "$REST_PORT")
    args+=("--timeout" "$TIMEOUT")
    if [ "$VERBOSE" = true ]; then
        args+=("--verbose")
    fi

    echo ""
    echo "=========================================="
    echo "  Running: $name"
    echo "=========================================="

    # Run the script in a subshell with the same server
    # The script should detect the running server and skip startup
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

    # Dry run mode
    if [ "$DRY_RUN" = true ]; then
        show_test_plan
        exit 0
    fi

    # Check prerequisites
    check_prerequisites || exit 1

    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${TIMEOUT}s"
    echo ""

    # Start server once for all tests
    log_info "Starting test server..."
    start_server || exit 1

    local failed=0

    # Run REST Channel Tests
    if ! run_test_script "$SCRIPT_DIR/rest-channel-test.sh" "REST Channel Tests"; then
        failed=$((failed + 1))
    fi

    # Run Use Case 1 Tests
    if ! run_test_script "$SCRIPT_DIR/use-case-1-basic-reply.sh" "Use Case 1 - Basic Reply"; then
        failed=$((failed + 1))
    fi

    # Run Use Case 2 Tests
    if ! run_test_script "$SCRIPT_DIR/use-case-2-task-execution.sh" "Use Case 2 - Task Execution"; then
        failed=$((failed + 1))
    fi

    # Print final summary
    echo ""
    echo "=========================================="
    if [ $failed -eq 0 ]; then
        log_info "All test suites passed!"
    else
        log_error "$failed test suite(s) failed"
    fi
    echo "=========================================="

    # Cleanup
    cleanup

    exit $failed
}

main
