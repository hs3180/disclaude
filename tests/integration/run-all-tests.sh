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
#   --timeout SECONDS   Request timeout (default: per-suite defaults, 30-120s)
#   --port PORT         REST API port (auto-detected from config, fallback: 3099)
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
# REST_PORT is auto-detected from config file by common.sh (Issue #3840)
TIMEOUT="${TIMEOUT:-60}"
MAX_RETRIES="${MAX_RETRIES:-2}"
INTER_SUITE_DELAY="${INTER_SUITE_DELAY:-5}"
RETRY_INITIAL_DELAY="${RETRY_INITIAL_DELAY:-5}"
RETRY_BACKOFF="${RETRY_BACKOFF:-2}"

# Track whether user explicitly set --timeout (to avoid overriding per-suite defaults)
_USER_TIMEOUT=""

# Issue #4552: set when a suite failure is identified as account-level quota
# exhaustion (GLM code 1308 / usage cap). Once set, remaining suites run a
# single attempt each — the quota resets hours later, so a full retry chain
# per suite just burns wall clock (#4552's "28-minute slow round").
QUOTA_EXHAUSTED=false
# Set when the configured Codex backend returns a provider failure during the
# warm-up request. AI suites are then skipped as environmental rather than
# repeated failures; protocol-only suites still run (Issue #4671).
CODEX_ENV_BLOCKED=false

# Issue #4552: current suite's captured output (set by run_test_script;
# removed on every exit path — the normal ones inline, and this trap for
# Ctrl-C / set -e aborts — so mktemp files don't linger in $TMPDIR).
_SUITE_OUTPUT_FILE=""

_suite_output_cleanup() {
    [ -n "$_SUITE_OUTPUT_FILE" ] && rm -f "$_SUITE_OUTPUT_FILE"
}

source "$SCRIPT_DIR/common.sh"
# Parse runner-owned options before handing the remaining arguments to the
# common parser. Otherwise parse_common_args rejects --retries/--delay before
# this runner gets a chance to consume them (Issue #4656).
FILTER_ARGS=()
COMMON_ARGS=()
while [[ $# -gt 0 ]]; do
    case $1 in
        --retries)
            if [[ -n "${2:-}" && "$2" != -* ]]; then MAX_RETRIES="$2"; shift 2;
            else COMMON_ARGS+=("$1"); shift; fi ;;
        --delay)
            if [[ -n "${2:-}" && "$2" != -* ]]; then INTER_SUITE_DELAY="$2"; shift 2;
            else COMMON_ARGS+=("$1"); shift; fi ;;
        --timeout)
            _USER_TIMEOUT="${2:-}"
            COMMON_ARGS+=("$1" "${2:-}")
            shift 2 ;;
        --tag|--name) FILTER_ARGS+=("$1" "${2:-}"); shift 2 ;;
        *) COMMON_ARGS+=("$1"); shift ;;
    esac
done
parse_common_args "${COMMON_ARGS[@]}"
register_cleanup

# --timeout belongs to the common parser and was passed through above.

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
    echo "  5. Channel CLI Tools Tests (4 tests)"
    echo "     - Health check, send_text, send_file, tool result format"
    echo ""
    echo "  6. Multimodal Tests (5 tests)"
    echo "     - Health check, single image, multi-image, mixed message, screenshot"
    echo ""
    echo "  7. Codex Compatibility E2E"
    echo "     - Real CLI configuration, session resume, sandbox, telemetry"
    echo ""
    echo "Configuration:"
    echo "  - REST Port: $REST_PORT"
    echo "  - Timeout: ${_USER_TIMEOUT:-per-suite defaults (30-120s)}"
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
    local args=()

    # Issue #4552: after quota exhaustion was detected, each remaining suite
    # gets exactly one attempt (a cheap probe for a pass-through window) —
    # not a full retry chain against a quota that resets hours later.
    local max_retries="$MAX_RETRIES"
    if [ "$QUOTA_EXHAUSTED" = true ]; then
        max_retries=0
        log_info "$name: single attempt (quota exhausted earlier this run, Issue #4552)"
    fi

    args+=("--port" "$REST_PORT")
    # Only pass --timeout if user explicitly set it; otherwise let each sub-script
    # use its own default (e.g., mcp-tools-test.sh uses 120s, rest-channel-test.sh uses 30s).
    # This prevents run-all-tests.sh's default 60s from overriding per-suite timeouts.
    # Issue #2989: Previously, --timeout 60 was always passed, causing MCP tools tests
    # to fail with HTTP 000 when tool execution exceeded 60s.
    if [ -n "$_USER_TIMEOUT" ]; then
        args+=("--timeout" "$_USER_TIMEOUT")
    fi
    if [ "$VERBOSE" = true ]; then
        args+=("--verbose")
    fi
    # Filters are consumed by the runner's suite selection below. Do not pass
    # them to child scripts: their common parser intentionally accepts only
    # request/runtime options (Issue #4672).

    local attempt=1
    local max_attempts=$((max_retries + 1))
    # Issue #4552: capture each attempt's output so failure evidence (HTTP
    # status lines, server-log excerpts) survives for quota detection below.
    # Tracked in _SUITE_OUTPUT_FILE for the abort-trap cleanup above.
    local output_file
    output_file="$(mktemp "${TMPDIR:-/tmp}/suite-output.XXXXXX")"
    _SUITE_OUTPUT_FILE="$output_file"

    while [ $attempt -le $max_attempts ]; do
        echo ""
        echo "=========================================="
        echo "  Running: $name (attempt ${attempt}/${max_attempts})"
        echo "=========================================="

        if bash "$script" "${args[@]}" 2>&1 | tee "$output_file" \
            && [ "${PIPESTATUS[0]}" -eq 0 ]; then
            if [ $attempt -gt 1 ]; then
                log_warn "$name passed on attempt ${attempt}/${max_attempts}"
                RETRIED_SUCCESSES=$((RETRIED_SUCCESSES + 1))
            fi
            rm -f "$output_file"
            _SUITE_OUTPUT_FILE=""
            return 0
        else
            # Issue #4552: account-level quota exhaustion (GLM code 1308,
            # 「已达到 5 小时的使用上限」) resets hours later — retrying this
            # suite (or letting later suites retry) cannot succeed and burns
            # the run's wall clock (#4552's 3-wave multimodal failure and
            # "28-minute slow round"). Fail the suite fast and mark the whole
            # run so remaining suites make a single attempt each (an
            # occasional pass-through window was observed in #4552 — one
            # cheap probe is worth it; blind 3x chains are not).
            if detect_quota_exhaustion "$output_file" "$script" "$output_file"; then
                log_error "$name failed: account-level quota exhausted (rate-limit code 1308 / usage cap) — retries cannot succeed until the quota window resets; skipping remaining retries for this suite (Issue #4552)"
                QUOTA_EXHAUSTED=true
                rm -f "$output_file"
                _SUITE_OUTPUT_FILE=""
                return 1
            fi
            if [ $attempt -lt $max_attempts ]; then
                local delay=$((RETRY_INITIAL_DELAY * RETRY_BACKOFF ** (attempt - 1)))
                log_warn "$name failed (attempt ${attempt}/${max_attempts}), retrying in ${delay}s (exponential backoff)..."

                # Issue #3530: Restart server between retries if unhealthy.
                # When the server crashes or becomes unstable (e.g., exit listener
                # accumulation from Claude Agent SDK's ProcessTransport), subsequent
                # retries against the same server will also fail with HTTP 000.
                # Restarting the server gives each retry a clean state.
                local needs_restart=false
                if ! is_server_running; then
                    log_warn "Server is not responding, restarting before retry..."
                    needs_restart=true
                else
                    # Also check for exit listener accumulation (Issue #3378).
                    # High exit listener count indicates ProcessTransport leak which
                    # can cause server instability.
                    local health_result
                    health_result=$(make_request "GET" "/api/health" 2>/dev/null) || true
                    local health_body
                    health_body=$(echo "$health_result" | cut -d'|' -f2-)
                    local exit_count
                    exit_count=$(echo "$health_body" | grep -o '"exit":[0-9]*' | grep -o '[0-9]*')
                    if [ -n "$exit_count" ] && [ "$exit_count" -gt "${EXIT_LISTENER_THRESHOLD:-10}" ] 2>/dev/null; then
                        log_warn "Server has high exit listener count ($exit_count), restarting before retry..."
                        needs_restart=true
                    fi
                fi

                if [ "$needs_restart" = true ]; then
                    stop_server 2>/dev/null || true
                    wait_for_port_release "$REST_PORT" 10 || true
                    if start_server; then
                        log_info "Server restarted successfully for retry ${attempt}"
                    else
                        log_error "Failed to restart server for retry ${attempt}"
                    fi
                fi

                sleep "$delay"
            fi
        fi

        attempt=$((attempt + 1))
    done

    rm -f "$output_file"
    _SUITE_OUTPUT_FILE=""
    log_error "$name failed after ${max_attempts} attempt(s)"
    TOTAL_RETRIES=$((TOTAL_RETRIES + max_retries))
    return 1
}

# Run a test suite with inter-suite delay
# Delay is skipped before the first suite and after retries
_SUITE_COUNT=0

# Issue #3378: Track exit listener count for leak detection across test run.
_EXIT_LISTENER_BASELINE=""

# Issue #3378: Check server health including process exit listener count.
# Logs a warning if exit listeners exceed threshold, helping diagnose
# ProcessTransport leaks from Claude Agent SDK.
# If baseline is not yet set, records the current count as baseline.
check_server_health_detailed() {
    local result
    result=$(make_request "GET" "/api/health" 2>/dev/null) || return

    local status
    status=$(echo "$result" | cut -d'|' -f1)
    local body
    body=$(echo "$result" | cut -d'|' -f2-)

    if [ "$status" = "200" ]; then
        local exit_count
        exit_count=$(echo "$body" | grep -o '"exit":[0-9]*' | grep -o '[0-9]*')
        if [ -n "$exit_count" ]; then
            # Record baseline on first call
            if [ -z "$_EXIT_LISTENER_BASELINE" ]; then
                _EXIT_LISTENER_BASELINE="$exit_count"
                log_info "Exit listener baseline: $exit_count"
            fi
            if [ "$exit_count" -gt "${EXIT_LISTENER_THRESHOLD:-10}" ] 2>/dev/null; then
                log_warn "⚠️ Server health check: exit listener count=$exit_count (threshold: ${EXIT_LISTENER_THRESHOLD:-10}) — possible ProcessTransport leak"
            else
                log_debug "Server health check: exit listeners=$exit_count, status=ok"
            fi
        fi
    else
        log_warn "Server health check returned HTTP $status"
    fi
}

# Issue #3378: Warm up the agent before the first AI-dependent test.
# Sends a lightweight sync request to ensure the agent is fully initialized,
# addressing cold-start behavior where the first AI request might return
# inconsistent responses (e.g., raw tool call format instead of text).
# Issue #3777: Added retry with exponential backoff and fail-fast behavior.
# When the API is unreachable (HTTP 000 on all retries), the test suite
# fails immediately instead of letting every test time out individually.
# Issue #4595: a failed warm-up attempt now consults the #4552 quota-
# exhaustion detector before retrying. #4595 burned the whole 4-attempt
# chain (10+20+40s sleeps) against a GLM code-1308 5-hour usage cap — the
# signature sat in the SDK debug log the entire time, but the warm-up path
# never looked, then aborted with the misleading "API appears unreachable".
# A quota-exhausted warm-up now fails fast on attempt 1 with the
# environmental diagnosis. Only reached on a FAILED attempt — the success
# path is bit-identical to before.
# Returns: 0 on success, 1 on failure (fatal — test suite aborts)
warmup_agent() {
    local max_retries="${WARMUP_MAX_RETRIES:-3}"
    local initial_delay="${WARMUP_INITIAL_DELAY:-10}"
    local backoff="${WARMUP_BACKOFF:-2}"

    log_info "Warming up agent (cold start prevention, max $((max_retries + 1)) attempts)..."

    local attempt=0
    while [ $attempt -le $max_retries ]; do
        local warmup_chat_id="warmup-$$-$(date +%s)-$attempt"
        local result
        result=$(make_sync_request "ping" "$warmup_chat_id" 2>/dev/null) || true

        parse_response "$result"

        if [ "$RESPONSE_STATUS" = "200" ]; then
            if [ -n "$CONFIG_PATH" ] && grep -qE '^[[:space:]]*agentBackend:.*codex' "$CONFIG_PATH" 2>/dev/null \
                && response_contains_provider_failure "$RESPONSE_BODY"; then
                CODEX_ENV_BLOCKED=true
                log_warn "Codex warm-up returned an embedded provider failure; marking Codex-dependent suites as SKIP (environmental, Issue #4671)"
                log_debug "Warm-up response: $RESPONSE_BODY"
                check_server_health_detailed
                return 0
            fi
            if [ $attempt -gt 0 ]; then
                log_info "Agent warm-up succeeded on attempt $((attempt + 1))"
            fi
            log_info "Agent warm-up successful (HTTP 200)"
            # Record baseline exit listener count after warm-up
            check_server_health_detailed
            return 0
        fi

        # Issue #4595: failed attempt — before sleeping/retrying (and before
        # the generic unreachable diagnosis), check whether the failure is
        # account-level quota exhaustion. The quota resets hours later
        # (#4552), so the remaining warm-up attempts AND every later suite
        # are pre-doomed; retrying only burns wall clock. Mirror run_suite:
        # set QUOTA_EXHAUSTED so any later suite single-attempts.
        # Tier 1 has no warm-up output file yet (""), so detection rides on
        # the server log / SDK debug log tiers — exactly where #4595's
        # evidence lived.
        if detect_quota_exhaustion "" "" ""; then
            log_error "Agent warm-up failed: account-level quota exhausted (rate-limit code 1308 / usage cap, Issue #4595)"
            log_error "This is environmental, not a code failure — the quota window resets hours later; retries cannot succeed."
            log_error "Re-run the full suite after the quota resets (see the reset time in the SDK log below)."
            show_server_logs
            QUOTA_EXHAUSTED=true
            return 1
        fi

        # Attempt failed
        if [ $attempt -lt $max_retries ]; then
            local delay=$((initial_delay * backoff ** attempt))
            if [ "$RESPONSE_STATUS" = "000" ]; then
                log_warn "Agent warm-up: no response (HTTP 000) — attempt $((attempt + 1))/$((max_retries + 1)), retrying in ${delay}s..."
            else
                log_warn "Agent warm-up returned HTTP $RESPONSE_STATUS — attempt $((attempt + 1))/$((max_retries + 1)), retrying in ${delay}s..."
            fi
            sleep "$delay"
            # Restart server between retries if it's not healthy
            if ! is_server_running; then
                log_warn "Server not responding during warm-up, restarting..."
                stop_server 2>/dev/null || true
                wait_for_port_release "$REST_PORT" 10 || true
                start_server || {
                    log_error "Failed to restart server during warm-up"
                    return 1
                }
            fi
        fi

        attempt=$((attempt + 1))
    done

    # All retries exhausted
    log_error "Agent warm-up failed after $((max_retries + 1)) attempts (HTTP $RESPONSE_STATUS)"
    log_error "This usually means the AI API endpoint is unreachable or misconfigured."
    log_error "Possible causes:"
    log_error "  - API endpoint is down or rate-limiting"
    log_error "  - Network/TLS connectivity issues"
    log_error "  - API key is invalid or expired"
    log_error "  - Server-side SDK error (check ${SERVER_LOG})"
    show_server_logs
    return 1
}

run_suite() {
    local script="$1"
    local name="$2"

    # Add delay before suite (skip for the very first one)
    if [ $_SUITE_COUNT -gt 0 ] && [ "$INTER_SUITE_DELAY" -gt 0 ] 2>/dev/null; then
        log_info "Waiting ${INTER_SUITE_DELAY}s before next suite (rate limit avoidance)..."
        sleep "$INTER_SUITE_DELAY"
    fi
    _SUITE_COUNT=$((_SUITE_COUNT + 1))

    # Issue #3378: Check server health between suites for listener leak monitoring
    check_server_health_detailed

    local suite_result=0
    run_test_script "$script" "$name" || suite_result=$?

    # Issue #3378: After each suite, check if exit listener count is elevated.
    # If so, restart the server to prevent leaked listeners from causing
    # cascading failures in subsequent test suites.
    restart_server_if_unhealthy

    # TODO: After merge with #3448's baseline tracking, reset _EXIT_LISTENER_BASELINE
    # here when server was restarted, so growth report remains accurate.

    return $suite_result
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
    echo "  - Timeout: ${_USER_TIMEOUT:-per-suite defaults (30-120s)}"
    echo "  - Max Retries: ${MAX_RETRIES}"
    echo "  - Inter-suite Delay: ${INTER_SUITE_DELAY}s"
    echo ""

    log_info "Starting test server..."
    start_server || exit 1

    # Issue #3378: Warm up agent before first AI test to prevent cold-start issues
    # Issue #3777: Fail fast if API is unreachable instead of letting tests time out
    # Issue #4595: when warmup_agent flagged quota exhaustion, the abort line
    # must NOT say "API appears unreachable" — that misdiagnosis is what the
    # #4595 report had to manually root-cause against the SDK debug log.
    warmup_agent || {
        if [ "$QUOTA_EXHAUSTED" = true ]; then
            log_error "Agent warm-up failed — account-level quota exhausted (environmental, Issue #4595). Aborting tests; re-run after the quota resets."
        else
            log_error "Agent warm-up failed — API appears unreachable. Aborting tests."
        fi
        cleanup
        exit 1
    }

    local failed=0
    local RETRIED_SUCCESSES=0
    local TOTAL_RETRIES=0
    # Issue #4584: remember WHICH suites failed so the summary names them —
    # a bare "1 test suite(s) failed" forces the operator to dig through
    # (often truncated) background-run output to find the suite.
    local FAILED_SUITE_NAMES=()
    local SKIPPED_SUITE_NAMES=()

    local script name
    for spec in \
        "rest-channel-test.sh|REST Channel Tests|fast" \
        "use-case-1-basic-reply.sh|Use Case 1 - Basic Reply|ai" \
        "use-case-2-task-execution.sh|Use Case 2 - Task Execution|ai" \
        "use-case-3-multi-turn.sh|Use Case 3 - Multi-turn Conversation|ai" \
        "mcp-tools-test.sh|Channel CLI Tools Tests|ai" \
        "multimodal-test.sh|Multimodal Tests|ai" \
        "codex-compatibility-test.sh|Codex Compatibility E2E|ai"; do
        script="${spec%%|*}"
        spec_remainder="${spec#*|}"
        name="${spec_remainder%%|*}"
        suite_tag="${spec_remainder##*|}"
        if [ "${#FILTER_ARGS[@]}" -gt 0 ]; then
            filter_kind="${FILTER_ARGS[0]}"
            filter_value="${FILTER_ARGS[1]}"
            if [ "$filter_kind" = "--name" ] && [[ "$name" != *"$filter_value"* ]]; then
                continue
            fi
            if [ "$filter_kind" = "--tag" ] && [ "$suite_tag" != "$filter_value" ]; then
                continue
            fi
        fi
        if [ "$CODEX_ENV_BLOCKED" = true ] && [ "$suite_tag" = "ai" ]; then
            log_warn "$name: SKIP (Codex environment unavailable; see warm-up diagnostics, Issue #4671)"
            SKIPPED_SUITE_NAMES+=("$name")
            continue
        fi
        if ! run_suite "$SCRIPT_DIR/$script" "$name"; then
            failed=$((failed + 1))
            FAILED_SUITE_NAMES+=("$name")
        fi
    done

    # Feishu IPC transport suite removed with the Unix-socket transport itself
    # (#4168 Phase 3, PR #4583): its 7 test files exercised the deleted
    # UnixSocketIpcServer↔Client round-trip. REST IPC coverage lives in the
    # unit suites (rest-ipc-client.test.ts, http-api-server tests).

    echo ""
    echo "=========================================="
    if [ $failed -eq 0 ]; then
        log_info "All test suites passed!"
    else
        log_error "$failed test suite(s) failed"
        # Issue #4584: name the failing suites right after the count, so
        # tail-truncated output (#4584's CI report lost the suite lines)
        # still identifies them.
        log_error "Failed suite(s): ${FAILED_SUITE_NAMES[*]}"
    fi
    if [ "${#SKIPPED_SUITE_NAMES[@]}" -gt 0 ]; then
        log_warn "Skipped suite(s): ${SKIPPED_SUITE_NAMES[*]}"
    fi
    if [ $RETRIED_SUCCESSES -gt 0 ]; then
        log_warn "${RETRIED_SUCCESSES} suite(s) passed after retry"
    fi
    # Issue #4552: surface the root cause when failures were quota-driven, so
    # a red run isn't misread as a code regression (the triggering commit in
    # #4552 was docs-only).
    if [ "$QUOTA_EXHAUSTED" = true ]; then
        log_warn "Account-level quota exhaustion detected (rate-limit code 1308 / usage cap). Failures above are environmental, not code regressions — re-run after the quota window resets."
    fi

    # Issue #3378: Report exit listener growth for leak detection
    if [ -n "$_EXIT_LISTENER_BASELINE" ]; then
        local final_result
        final_result=$(make_request "GET" "/api/health" 2>/dev/null) || true
        local final_body
        final_body=$(echo "$final_result" | cut -d'|' -f2-)
        local final_exit_count
        final_exit_count=$(echo "$final_body" | grep -o '"exit":[0-9]*' | grep -o '[0-9]*')
        if [ -n "$final_exit_count" ]; then
            local growth=$((final_exit_count - _EXIT_LISTENER_BASELINE))
            echo ""
            echo "Exit listener diagnostics (Issue #3378):"
            echo "  Baseline: $_EXIT_LISTENER_BASELINE"
            echo "  Final:    $final_exit_count"
            echo "  Growth:   $growth"
            if [ "$growth" -gt 3 ] 2>/dev/null; then
                log_warn "Exit listener growth=$growth exceeds threshold (3) — possible ProcessTransport leak"
            else
                log_info "Exit listener growth within normal range ($growth)"
            fi
        fi
    fi

    echo "=========================================="

    cleanup
    exit $failed
}

main
