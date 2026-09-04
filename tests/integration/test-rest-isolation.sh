#!/bin/bash
#
# Regression test for Issue #4729.
#
# Async REST protocol tests that must verify "background-submit" semantics
# spawn real Agents; running them against the shared AI server pollutes its
# pool with sessions a subsequent suite must drain (Issue #4725). The fix gives
# such tests a throwaway isolated HTTP server (start_isolated_server /
# stop_isolated_server) whose Agent sessions can never touch the shared pool.
# This test proves the isolation lifecycle: start an isolated server on a fresh
# port, confirm it's up and self-contained, then tear it down and confirm the
# port is released with no lingering process.
#
# Usage:
#   ./tests/integration/test-rest-isolation.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# Pick a free-ish ephemeral port.
ISOLATED_PORT="${ISOLATED_PORT:-3391}"

# 1. start isolated server, confirm listening
ISOLATED_PID="$(start_isolated_server "$ISOLATED_PORT")" || {
    log_fail "start_isolated_server failed to bring up port $ISOLATED_PORT"
    exit 1
}
if is_port_in_use "$ISOLATED_PORT"; then
    log_pass "isolated server is listening on $ISOLATED_PORT (pid $ISOLATED_PID)"
else
    log_fail "isolated server not listening on $ISOLATED_PORT"
    _fail_count=$((_fail_count + 1))
fi

# 2. confirm it answers a health-shaped request (self-contained, no Primary Node)
health=$(curl -s --max-time 5 "http://${HOST}:${ISOLATED_PORT}/api/health" 2>/dev/null || true)
if echo "$health" | grep -q '"status":"ok"'; then
    log_pass "isolated server answered /api/health (self-contained: $health)"
else
    log_fail "isolated server did not answer /api/health (got: $health)"
    _fail_count=$((_fail_count + 1))
fi

# 3. teardown + port release + no lingering process
if stop_isolated_server "$ISOLATED_PID" "$ISOLATED_PORT"; then
    log_pass "isolated server stopped and port $ISOLATED_PORT released"
else
    log_fail "isolated server did not release port $ISOLATED_PORT cleanly"
    _fail_count=$((_fail_count + 1))
fi
if is_port_in_use "$ISOLATED_PORT"; then
    log_fail "port $ISOLATED_PORT still in use after teardown"
    _fail_count=$((_fail_count + 1))
else
    log_pass "port $ISOLATED_PORT released after teardown"
fi

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count rest-isolation assertion(s) failed"
    exit 1
fi
log_info "rest-isolation regression tests passed"
exit 0