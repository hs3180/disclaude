#!/usr/bin/env bash
# =============================================================================
# browser-use CLI smoke matrix — repeatable assertion script (Issue #4602, option c)
# =============================================================================
#
# Encodes the #4496 Scope-6 driver-side matrix (docs/cdp-endpoint.md) as a
# one-command, repeatable run. This is the CLI-level half of #4602: it locks
# the deployment-regression safety net (image rebuilds, playwright container
# upgrades, skill changes) while the agent-level injection channel (#4602
# Scope-1 options a/b — HTTP API push or direct ChatAgent instantiation)
# remains a separate decision.
#
# Manual checklist this script replaces (run inside the primary container or
# any host with the browser-use CLI + a reachable CDP endpoint):
#   [x] 1. CDP front reachable         — GET /json/version answers
#   [x] 2. BU_CDP_URL attach            — new_tab + js() title round-trip
#   [x] 2b. no self-spawned Chrome      — chrome process count unchanged (best
#           effort: only checked when pgrep exists; only meaningful on a host
#           that runs no Chrome of its own, e.g. the primary container)
#   [x] 3. js() structured round-trip   — JSON.stringify(...) parsed back
#   [x] 4. page_info / list_tabs        — session + tab introspection answer
#   [x] 5. screenshot artifact          — PNG (magic bytes) in workspace, non-empty
#   [x] 6. dead endpoint fails hard     — no silent self-launch fallback (#4496 Scope-3)
#
# Environment:
#   SMOKE_CDP_URL    CDP endpoint to attach to (required — e.g.
#                    http://disclaude-playwright:9222 inside the compose
#                    network, http://localhost:9222 from the host)
#   SMOKE_OUT_DIR    screenshot artifact dir (default: ./browser-use-smoke
#                    under the current directory)
#
# Usage:
#   SMOKE_CDP_URL=http://localhost:9222 ./scripts/browser-use-smoke.sh
#
# Prerequisites: browser-use >= 0.13.7, curl, timeout, and a running CDP
# endpoint (docker compose --profile playwright up -d brings one up).
#
# ⚠️ Daemon-pin trap (docs/cdp-endpoint.md, 2026-08-25 note): the long-lived
# browser-harness daemon reads BU_CDP_URL once at first start. Case 6 must run
# `browser-use --reload` before flipping to a dead endpoint — otherwise it
# passes vacuously against the still-healthy session — and again after, to
# drop the dead state for any subsequent runs.
#
# =============================================================================

set -uo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SMOKE_CDP_URL="${SMOKE_CDP_URL:-}"
SMOKE_OUT_DIR="${SMOKE_OUT_DIR:-$PWD/browser-use-smoke}"
# A port that is near-certainly closed on loopback (tcpmux, rarely deployed).
DEAD_CDP_URL="http://127.0.0.1:9"

PASS=0
FAIL=0
FAILED_CASES=()

log_info()    { echo -e "${GREEN}[SMOKE][INFO]${NC} $*"; }
log_pass()    { echo -e "${GREEN}[SMOKE][PASS]${NC} $*"; PASS=$((PASS + 1)); }
log_fail()    { echo -e "${RED}[SMOKE][FAIL]${NC} $*"; FAIL=$((FAIL + 1)); FAILED_CASES+=("$1"); }
log_warn()    { echo -e "${YELLOW}[SMOKE][WARN]${NC} $*"; }

# assert_contains <case> <needle> <haystack> — grep -F, machine markers only.
assert_contains() {
    local case="$1" needle="$2" haystack="$3"
    if grep -qF -- "$needle" <<<"$haystack"; then
        log_pass "$case"
    else
        log_fail "$case"
        echo "    expected output to contain: $needle"
        echo "    got: ${haystack:0:400}"
    fi
}

# run_bu <env-url> <python...> — pipe Python to browser-use under BU_CDP_URL,
# 90s ceiling (attach retries alone take up to 30s; #4496 case 5 evidence).
run_bu() {
    local url="$1"; shift
    printf '%s\n' "$*" | timeout 90 env BU_CDP_URL="$url" browser-use 2>&1
}

chrome_process_count() {
    # Best effort: pgrep is absent on some minimal hosts → report "unknown".
    if command -v pgrep >/dev/null 2>&1; then
        pgrep -i -f 'chrom(e|ium)' 2>/dev/null | wc -l | tr -d ' '
    else
        echo "unknown"
    fi
}

# ── Case 0: preflight ───────────────────────────────────────────────────────
if [ -z "$SMOKE_CDP_URL" ]; then
    echo "Error: SMOKE_CDP_URL is required (e.g. SMOKE_CDP_URL=http://localhost:9220)" >&2
    echo "Run with --help for usage information." >&2
    exit 2
fi
if ! command -v browser-use >/dev/null 2>&1; then
    echo "Error: browser-use CLI not found on PATH." >&2
    exit 2
fi
log_info "endpoint: $SMOKE_CDP_URL · artifacts: $SMOKE_OUT_DIR"

version_line=$(browser-use --version 2>&1 || true)
log_info "browser-use version: ${version_line:-unknown}"

# ── Case 1: CDP front reachable ─────────────────────────────────────────────
if curl -sf --max-time 10 "$SMOKE_CDP_URL/json/version" >/dev/null 2>&1; then
    log_pass "case 1: GET /json/version reachable through the front"
else
    log_fail "case 1: GET /json/version unreachable at $SMOKE_CDP_URL — is the endpoint up?"
fi

# ── Case 2: attach + js() title round-trip (data: URL — no network needed) ─
CHROME_BEFORE=$(chrome_process_count)
out=$(run_bu "$SMOKE_CDP_URL" 'new_tab("data:text/html,<title>bu-smoke</title><h1>hello-cdp</h1>")
print("TITLE=" + str(js("document.title")))') || true
if [ -n "$out" ]; then
    assert_contains "case 2: BU_CDP_URL attach — new_tab + js() title round-trip" "TITLE=bu-smoke" "$out"
else
    log_fail "case 2: BU_CDP_URL attach — browser-use produced no output (exit $?)"
fi

# ── Case 2b: no self-spawned Chrome ─────────────────────────────────────────
CHROME_AFTER=$(chrome_process_count)
if [ "$CHROME_BEFORE" = "unknown" ] || [ "$CHROME_AFTER" = "unknown" ]; then
    log_warn "case 2b skipped — pgrep unavailable; self-spawn not asserted here"
elif [ "$CHROME_BEFORE" = "$CHROME_AFTER" ]; then
    log_pass "case 2b: no self-spawned Chrome (process count $CHROME_BEFORE unchanged)"
else
    log_fail "case 2b: chrome process count changed $CHROME_BEFORE → $CHROME_AFTER — attach may have self-launched a browser"
fi

# ── Case 3: js() structured round-trip ──────────────────────────────────────
out=$(run_bu "$SMOKE_CDP_URL" 'print(js("JSON.stringify({t: document.title, n: document.querySelectorAll(String.fromCharCode(104,49)).length})"))') || true
# Marker check on the serialized payload (title from case 2's tab, one <h1>).
if grep -qF '"t":"bu-smoke"' <<<"$out" && grep -qF '"n":1' <<<"$out"; then
    log_pass "case 3: js() structured JSON round-trip"
else
    log_fail "case 3: js() structured JSON round-trip"
    echo "    got: ${out:0:400}"
fi

# ── Case 4: page_info / list_tabs ───────────────────────────────────────────
out=$(run_bu "$SMOKE_CDP_URL" 'import json
info = page_info()
tabs = list_tabs()
print(json.dumps({"has_title": bool(info.get("title")), "tab_count": len(tabs) if isinstance(tabs, list) else -1}))') || true
if grep -qE '"has_title": ?true' <<<"$out" && grep -qE '"tab_count": ?[0-9]+' <<<"$out"; then
    log_pass "case 4: page_info() + list_tabs() answer with session state"
else
    log_fail "case 4: page_info() + list_tabs() answer with session state"
    echo "    got: ${out:0:400}"
fi

# ── Case 5: screenshot artifact in workspace, non-empty PNG ─────────────────
# mkdir first — capture_screenshot does NOT create parents (#4600).
mkdir -p "$SMOKE_OUT_DIR"
shot="$SMOKE_OUT_DIR/smoke-shot.png"
rm -f "$shot"
out=$(BU_CDP_URL="$SMOKE_CDP_URL" timeout 90 browser-use 2>&1 <<PY
import pathlib
dst = "$shot"
pathlib.Path(dst).parent.mkdir(parents=True, exist_ok=True)
print("SAVED=" + str(capture_screenshot(path=dst)))
PY
) || true
if [ -s "$shot" ] && [ "$(head -c 4 "$shot" | od -An -tx1 | tr -d ' \n')" = "89504e47" ]; then
    log_pass "case 5: screenshot artifact is a non-empty PNG at $shot ($(wc -c <"$shot" | tr -d ' ') bytes)"
else
    log_fail "case 5: screenshot artifact missing/empty/not a PNG at $shot"
    echo "    browser-use said: ${out:0:300}"
fi

# ── Case 6: dead endpoint fails hard (no silent self-launch fallback) ───────
# Reload first — the daemon pins its attach target from first start; without
# this the case passes vacuously against the healthy session.
timeout 60 browser-use --reload >/dev/null 2>&1 || true
out=$(run_bu "$DEAD_CDP_URL" 'print("SHOULD_NOT_PRINT")') ; rc=$?
if [ "$rc" -ne 0 ] && ! grep -qF "SHOULD_NOT_PRINT" <<<"$out"; then
    log_pass "case 6: dead BU_CDP_URL fails hard (exit $rc), no fallback session"
else
    log_fail "case 6: dead BU_CDP_URL did not fail hard (exit $rc)"
    echo "    got: ${out:0:300}"
fi
# Drop the dead attach state so the next run starts clean.
timeout 60 browser-use --reload >/dev/null 2>&1 || true

# ── Summary ─────────────────────────────────────────────────────────────────
echo
log_info "result: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    printf 'failed: %s\n' "${FAILED_CASES[*]}"
    exit 1
fi
exit 0
