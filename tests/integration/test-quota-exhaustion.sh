#!/bin/bash
#
# Source-level unit test for the quota-exhaustion detection added for
# Issue #4552 (GLM account-level 429 code 1308「已达到 5 小时的使用上限」).
#
# Why a bash script (not vitest): the code under test is the bash helpers
# is_quota_exhausted_failure / detect_quota_exhaustion in common.sh, so the
# regression test must also be bash (same convention as test-common-retry.sh).
# It sources common.sh and exercises the REAL helpers against fixture text
# drawn from #4552's actual log lines.
#
# Run: bash tests/integration/test-quota-exhaustion.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export TIMEOUT=30
unset SERVER_LOG

source "$SCRIPT_DIR/common.sh" >/dev/null 2>&1

pass=0; fail=0
check() {
  if [ "$1" = "$2" ]; then echo "PASS: $3 ($1)"; pass=$((pass + 1));
  else echo "FAIL: $3 (got $1 want $2)"; fail=$((fail + 1)); fi
}
check_rc() {
  # check_rc <actual_rc> <want:0|1> <name> — helpers return 0/1
  if [ "$1" = "$2" ]; then echo "PASS: $3"; pass=$((pass + 1));
  else echo "FAIL: $3 (got rc=$1 want $2)"; fail=$((fail + 1)); fi
}

TMPDIR_FIX=$(mktemp -d)
trap 'rm -rf "$TMPDIR_FIX"' EXIT

# =============================================================================
# is_quota_exhausted_failure
# =============================================================================

# --- Real #4552 signature lines (from the SDK debug log) ---

is_quota_exhausted_failure '{"type":"error","error":{"type":"rate_limit_error","code":1308,"message":"已达到 5 小时的使用上限。限额将在 18:36:36 重置"}}'
check_rc $? 0 "GLM code 1308 JSON error detected"

is_quota_exhausted_failure 'API rate_limit after retries: {type:error,error:{type:rate_limit_error,code:1308,...}}'
check_rc $? 0 "code 1308 in flattened log line detected"

is_quota_exhausted_failure '429 ... 已达到 5 小时的使用上限。限额将在 18:20:21 重置'
check_rc $? 0 "使用上限 human message detected (no 1308 present)"

is_quota_exhausted_failure 'Request failed: quota exceeded for this billing period'
check_rc $? 0 "quota exceeded (EN wording) detected"

is_quota_exhausted_failure 'API error: usage limit reached, resets at 18:20 UTC'
check_rc $? 0 "usage limit reached detected"

# --- Negative cases: transient / per-minute limits must NOT match ---

is_quota_exhausted_failure '访问量过大，请稍后重试'
check_rc $? 1 "per-minute 访问量过大 NOT flagged (retry can help)"

is_quota_exhausted_failure 'HTTP 429 Too Many Requests: rate limit, retry after 30s'
check_rc $? 1 "plain per-minute 429 NOT flagged"

is_quota_exhaustion_false_positive_check() {
  is_quota_exhausted_failure 'chat request used port 13081 and waited 1308ms'
}
is_quota_exhaustion_false_positive_check
check_rc $? 1 "bare number 1308 inside port/ms values NOT flagged (code-anchored regex)"

# --- Negative cases: word suffixes / longer codes must NOT match ---
# (review round 2: the regex needs a left boundary so "encode"/"barcode"/
# "unicode"/"pincode" + 1308 don't trip it, and a right boundary so
# "code 13081" / "code:13086" don't either.)
for wording in 'encode 1308' 'barcode 1308' 'unicode: 1308' 'pincode 1308' 'keycode=1308'; do
  is_quota_exhausted_failure "failed to $wording in fixture output"
  check_rc $? 1 "word-suffix '$wording' NOT flagged (left-bounded regex)"
done

is_quota_exhausted_failure 'error code 13081: no such node'
check_rc $? 1 "code 13081 (longer number) NOT flagged (right-bounded regex)"

# --- Positive: boundary forms still match ---
is_quota_exhausted_failure 'at start: code:1308 reset at 18:36'
check_rc $? 0 "line-leading 'code:1308' detected"

is_quota_exhausted_failure '(code=1308) from provider'
check_rc $? 0 "paren-wrapped 'code=1308' detected (left boundary is punctuation)"

is_quota_exhausted_failure 'rate limit error: request frequency too high'
check_rc $? 1 "request frequency NOT flagged (transient)"

is_quota_exhausted_failure ''
check_rc $? 1 "empty text NOT flagged"

is_quota_exhausted_failure 'HTTP 500 internal server error'
check_rc $? 1 "unrelated 500 NOT flagged"

# =============================================================================
# detect_quota_exhaustion — evidence tiering
# =============================================================================

# --- Tier 1: suite output file ---
T1="$TMPDIR_FIX/suite-out.log"
printf '%s\n' \
  "[FAIL] Chat request failed with HTTP 000" \
  '[ERROR] API error (attempt 11/11): 429 ... code:1308 ... 已达到 5 小时的使用上限' \
  > "$T1"
detect_quota_exhaustion "$T1" ""
check_rc $? 0 "tier 1: suite output with 1308 detected"

printf '%s\n' "[FAIL] Chat request failed with HTTP 500" > "$T1"
detect_quota_exhaustion "$T1" ""
check_rc $? 1 "tier 1: plain failure NOT detected"

# --- Tier 2: per-suite server log (derived from script basename) ---
# Resolved against PROJECT_ROOT when set (mirrors start_server's cd), else
# the caller's cwd — each variant gets its own scratch dir.
SCRATCH="$TMPDIR_FIX/scratch"
mkdir -p "$SCRATCH"
: > "$SCRATCH/multimodal-test.sh"
printf '%s\n' \
  '[info]: server ready' \
  'stderr: {"error":{"type":"rate_limit_error","code":1308,"message":"已达到 5 小时的使用上限"}}' \
  > "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && unset PROJECT_ROOT && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 0 "tier 2: per-suite server log with 1308 detected (cwd-resolved)"

PR_ROOT="$TMPDIR_FIX/pr-root"
mkdir -p "$PR_ROOT"
printf '%s\n' \
  '[info]: server ready' \
  'stderr: {"error":{"type":"rate_limit_error","code":1308,"message":"已达到 5 小时的使用上限"}}' \
  > "$PR_ROOT/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && PROJECT_ROOT="$PR_ROOT" detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 0 "tier 2: per-suite server log with 1308 detected (PROJECT_ROOT-resolved)"

printf '%s\n' '[info]: server ready' > "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && unset PROJECT_ROOT && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 1 "tier 2: clean server log NOT detected"

# Portable mtime back-dating helper (#4573): `touch -d '2 hours ago'` is
# GNU-only — BSD touch (macOS /usr/bin/touch) rejects relative descriptors
# ("out of range or illegal time specification"), which aborted the whole
# suite there. Compose an absolute local timestamp instead: BSD date uses
# `-v-2H`, GNU date uses `-d '2 hours ago'`; `touch -t [[CC]YY]MMDDhhmm[.ss]`
# is POSIX and accepts it on both.
touch_mtime_2h_ago() {
  local stamp
  stamp="$(date -v-2H +%Y%m%d%H%M 2>/dev/null \
    || date -d '2 hours ago' +%Y%m%d%H%M 2>/dev/null \
    || date -u -v-2H +%Y%m%d%H%M 2>/dev/null \
    || date -u -d '2 hours ago' +%Y%m%d%H%M)"
  # Even in UTC fallback the stamp is always "2h ago" of some reference
  # clock, so it is safely older than any file created in this run.
  touch -t "$stamp" "$1"
}

# --- Tier 2 freshness gate: a per-suite log OLDER than the reference file
# (the suite's just-written output) is a stale leftover from an old
# standalone run and must NOT be trusted (review round 2, P2-1).
printf '%s\n' \
  'stderr: {"error":{"type":"rate_limit_error","code":1308,"message":"已达到 5 小时的使用上限"}}' \
  > "$SCRATCH/disclaude-test-server-multimodal-test.log"
touch_mtime_2h_ago "$SCRATCH/disclaude-test-server-multimodal-test.log"
SUITE_OUT="$TMPDIR_FIX/suite-out-stale.log"
printf '%s\n' '[FAIL] Chat request failed with HTTP 000' > "$SUITE_OUT"
( cd "$SCRATCH" && unset PROJECT_ROOT && detect_quota_exhaustion "$SUITE_OUT" "$SCRATCH/multimodal-test.sh" "$SUITE_OUT" )
check_rc $? 1 "tier 2: stale per-suite log (older than output) NOT trusted"

# Same log, but newer than the reference → trusted again
touch "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && unset PROJECT_ROOT && detect_quota_exhaustion "$SUITE_OUT" "$SCRATCH/multimodal-test.sh" "$SUITE_OUT" )
check_rc $? 0 "tier 2: fresh per-suite log (newer than output) trusted"

# No reference given → freshness gate disabled (backward compatible)
( cd "$SCRATCH" && unset PROJECT_ROOT && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 0 "tier 2: no reference file → gate disabled, log still trusted"

# --- Tier 3: SDK debug log pointed to by the server log banner ---
# (reset the per-suite log: the freshness cases above left it old-then-new;
# tier 3 runs without a reference so the gate is off)
rm -f "$SCRATCH/disclaude-test-server-multimodal-test.log"
SDKLOG="$TMPDIR_FIX/sdk-fake.txt"
printf '%s\n' \
  '2026-08-21T09:01:18.142Z [ERROR] API error (attempt 1/11): 429' \
  '2026-08-21T09:08:45.056Z [ERROR] API error (attempt 11/11): 429' \
  '2026-08-21T09:08:45.070Z [ERROR] API rate_limit after retries: {type:error,error:{type:rate_limit_error,code:1308}}' \
  > "$SDKLOG"
printf 'SDK debug logs: %s\n' "$SDKLOG" > "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 0 "tier 3: SDK debug log with 1308 detected via banner pointer"

# Tier 3 negative: banner points at a log without the quota signature
printf '%s\n' \
  '2026-08-21T09:01:18.142Z [ERROR] API error (attempt 1/11): 429 Too Many Requests' \
  > "$SDKLOG"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 1 "tier 3: SDK log with only transient 429 NOT detected"

# =============================================================================
# #4595: warm-up phase must consult the quota detector
# =============================================================================
# #4595's run burned the whole warm-up retry chain (10+20+40s) against a GLM
# code-1308 5-hour usage cap and aborted with "API appears unreachable" —
# the 1308 signature sat in the SDK debug log the entire time, but
# warmup_agent() never looked (only run_suite did, via #4552). Source-level
# test, same convention as the #4584 harness below: extract the REAL
# warmup_agent body from run-all-tests.sh, stub its collaborators, and
# drive it against #4595's exact scenario — ping fails, SDK debug log
# carries 1308.
H4595="$TMPDIR_FIX/warmup-harness"
# Extract the function verbatim: from its comment-block end (`warmup_agent() {`)
# through its closing brace (the first `^}` after the start marker).
awk '/^warmup_agent\(\) \{/{f=1} f{print} f && /^}/{exit}' \
  "$SCRIPT_DIR/run-all-tests.sh" > "$H4595"
# Sanity: extraction actually got the function (guards against a rename in
# run-all-tests.sh silently turning this test into a no-op pass).
grep -q 'detect_quota_exhaustion' "$H4595" || { echo "FAIL: extracted warmup_agent lost the #4595 quota check (extraction stale?)"; fail=$((fail + 1)); }

# Scenario fixture — #4595's actual evidence shape: warm-up ping gets no
# response; the server log points at an SDK debug log carrying the 1308
# account-cap signature.
S4595="$TMPDIR_FIX/warmup-scratch"
mkdir -p "$S4595"
SDK4595="$S4595/sdk-debug.txt"
printf '%s\n' \
  '2026-08-25T07:40:27Z [ERROR] API error (attempt 1/11): 429 {"error":{"type":"rate_limit_error","code":1308,"message":"[1308][已达到 5 小时的使用上限。您的限额将在 2026-08-25 17:50:06 重置。]"}}' \
  > "$SDK4595"
printf 'SDK debug logs: %s\n' "$SDK4595" > "$S4595/server.log"

# Harness prelude: source common.sh for the log_*/parse_response helpers and
# REAL detect_quota_exhaustion; stub the warm-up's collaborators. sleep is
# stubbed to COUNT instead of delay — the quota path must return before any
# retry sleep, so SLEPT>0 would mean the fail-fast didn't fire.
W4595_PRE="$TMPDIR_FIX/warmup-pre"
{
  echo '#!/bin/bash'
  echo 'SCRIPT_DIR="'"$SCRIPT_DIR"'"'
  echo 'source "$SCRIPT_DIR/common.sh" >/dev/null 2>&1'
  echo 'SERVER_LOG="'"$S4595/server.log"'"'
  echo 'RESPONSE_STATUS=""'
  echo 'QUOTA_EXHAUSTED=false'
  echo 'SLEPT=0; sleep() { SLEPT=$((SLEPT + $1)); }'
  echo 'make_sync_request() { echo "curl: (7) Failed to connect"; return 1; }'
  echo 'parse_response() { RESPONSE_STATUS="000"; }'
  echo 'check_server_health_detailed() { :; }'
  echo 'is_server_running() { return 0; }'
  echo 'show_server_logs() { tail -5 "$SERVER_LOG"; }'
  cat "$H4595"
  echo 'warmup_agent'
} > "$W4595_PRE"

# Quota-exhausted warm-up: fails fast on attempt 1 — no sleeps, sets the
# flag, prints the environmental diagnosis (not "unreachable").
W4595_OUT="$( cd "$S4595" && bash "$W4595_PRE" < /dev/null 2>&1; echo "rc=$?" )"
W4595_RC="${W4595_OUT##*rc=}"
W4595_PLAIN="$(printf '%s' "$W4595_OUT" | sed 's/\x1b\[[0-9;]*m//g')"

check_rc "$W4595_RC" 1 "#4595: quota-exhausted warm-up fails (rc=1)"
printf '%s' "$W4595_PLAIN" | grep -qF 'account-level quota exhausted'
check_rc $? 0 "#4595: diagnosis names quota exhaustion"
# Flag/sleep assertions: rerun the same prelude with a different epilogue
# that invokes the function quietly and echoes the stub counters after it
# returns. (The first harness run's `bash` and the script's own trap share
# nothing, but the SDK fixture is re-written first: the control scenario
# below overwrites it later in this file.)
printf '%s\n' \
  '2026-08-25T07:40:27Z [ERROR] API error (attempt 1/11): 429 {"error":{"type":"rate_limit_error","code":1308,"message":"[1308][已达到 5 小时的使用上限。您的限额将在 2026-08-25 17:50:06 重置。]"}}' \
  > "$SDK4595"
W4595_EPILOGUE="$TMPDIR_FIX/warmup-epilogue"
{
  # Reuse the prelude minus its trailing `warmup_agent` call line.
  sed '$d' "$W4595_PRE"
  echo 'warmup_agent >/dev/null 2>&1; echo "slept=$SLEPT quota=$QUOTA_EXHAUSTED"'
} > "$W4595_EPILOGUE"
W4595_META="$( cd "$S4595" && bash "$W4595_EPILOGUE" < /dev/null 2>&1 | tail -1 )"
printf '%s' "$W4595_META" | grep -qF 'slept=0'
check_rc $? 0 "#4595: no retry sleeps before the quota fail-fast"
printf '%s' "$W4595_META" | grep -qF 'quota=true'
check_rc $? 0 "#4595: QUOTA_EXHAUSTED flag set (later suites single-attempt)"
printf '%s' "$W4595_PLAIN" | grep -q 'retrying in'
check_rc $? 1 "#4595: no futile retry-warn lines on the quota path"

# Counter-scenario: SDK log WITHOUT the quota signature (plain transient
# 429 / unreachable) — the warm-up must keep its ORIGINAL retry-then-generic
# -diagnosis behavior, i.e. the quota check must not swallow it.
printf '%s\n' \
  '2026-08-25T07:40:27Z [ERROR] API error (attempt 1/11): 429 Too Many Requests (per-minute)' \
  > "$SDK4595"
W4595_OUT2="$( cd "$S4595" && bash "$W4595_PRE" < /dev/null 2>&1; echo "rc=$?" )"
W4595_RC2="${W4595_OUT2##*rc=}"
W4595_PLAIN2="$(printf '%s' "$W4595_OUT2" | sed 's/\x1b\[[0-9;]*m//g')"
check_rc "$W4595_RC2" 1 "#4595 (control): non-quota unreachable warm-up still fails"
printf '%s' "$W4595_PLAIN2" | grep -qF 'account-level quota exhausted'
check_rc $? 1 "#4595 (control): no quota diagnosis without the 1308 signature"
printf '%s' "$W4595_PLAIN2" | grep -qF 'This usually means the AI API endpoint is unreachable'
check_rc $? 0 "#4595 (control): original unreachable diagnosis preserved"

# =============================================================================
# #4584: run-all-tests.sh summary must NAME the failed suites
# =============================================================================
# The runner's summary previously printed only "$failed test suite(s) failed";
# when a background run's output was tail-truncated (#4584's CI report lost
# the per-suite banner lines), the failing suite could not be identified
# without re-running. The summary now also prints "Failed suite(s): <names>".
# Source-level test: extract the runner's suite iteration + summary block
# into a scratch harness (run_suite stubbed), and drive it against #4584's
# exact scenario — one suite fails, quota detection correctly flags the
# failure as environmental in the same summary.

H4584="$TMPDIR_FIX/harness"
# Extract from the counters down to (and including) the "Failed suite(s):"
# summary line (awk stops at FIRST match — sed's addr,addr range would run
# to the next re-match), dedent, and append the closing `fi` for the
# else-branch the extraction cut open. (Use $a with a real newline — GNU
# sed treats `'$a\fi'` as append-text "i", dropping the f.)
# The `local` declarations are blanked (not stripped): stripping turns
# `local script name` into `script name`, which executes util-linux
# `script(1)` — a typescript session that hangs forever when stdin is a
# pipe (exactly what CI's execFileSync child gets; the first CI run of
# this test timed out to that). The harness prelude re-initializes the
# variables the blanked `local` lines used to declare.
awk '/^    local failed=0$/{f=1} f{print} /log_error "Failed suite/{exit}' \
  "$SCRIPT_DIR/run-all-tests.sh" \
  | sed -e 's/^    //' -e 's/^local .*/:/' -e '$a\
fi' \
  > "$H4584"

# Harness prelude: source common.sh (log_* helpers), then the stub run_suite
# — exact #4584 scenario: Multimodal FAILS (non-zero), all other suites pass.
# (`run_suite` contract mirrors the runner's: non-zero = suite failed.)
# Stdin is redirected from /dev/null: belt-and-braces against any future
# extraction fragment that touches stdin under a piped-stdio parent.
H4584_PRE="$TMPDIR_FIX/harness-pre"
{
  echo '#!/bin/bash'
  echo 'SCRIPT_DIR="'"$SCRIPT_DIR"'"'
  echo 'source "$SCRIPT_DIR/common.sh" >/dev/null 2>&1'
  echo 'failed=0 RETRIED_SUCCESSES=0 TOTAL_RETRIES=0'
  echo 'FAILED_SUITE_NAMES=()'
  echo 'script= name='
  echo 'run_suite() { [ "$2" != "Multimodal Tests" ]; }'
  cat "$H4584"
} > "$H4584_PRE"
H4584_OUT="$( cd "$SCRATCH" && bash "$H4584_PRE" < /dev/null 2>&1 )"
# Strip ANSI color codes (log_error wraps the prefix in \033[0;31m…\033[0m)
# so the assertions below match the text, not the escape bytes.
H4584_PLAIN="$(printf '%s' "$H4584_OUT" | sed 's/\x1b\[[0-9;]*m//g')"

printf '%s' "$H4584_PLAIN" | grep -qE '\[ERROR\][[:space:]]+1 test suite\(s\) failed'
check_rc $? 0 "#4584: summary still prints the failed count"

printf '%s' "$H4584_PLAIN" | grep -qF 'Failed suite(s): Multimodal Tests'
check_rc $? 0 "#4584: summary names the failed suite (exact #4584 scenario)"

printf '%s' "$H4584_PLAIN" | grep -qF 'REST Channel Tests'
check_rc $? 1 "#4584: passing suite NOT listed in the failure summary"

# All-pass variant: the names line must not appear.
sed 's|^run_suite() { \[ "\$2" != "Multimodal Tests" \]; }$|run_suite() { return 0; }|' \
  "$H4584_PRE" > "$H4584.ok"
H4584_OK_OUT="$( cd "$SCRATCH" && bash "$H4584.ok" < /dev/null 2>&1 )"
printf '%s' "$H4584_OK_OUT" | sed 's/\x1b\[[0-9;]*m//g' | grep -q 'All test suites passed'
check_rc $? 0 "#4584: all-pass summary unchanged"
printf '%s' "$H4584_OK_OUT" | grep -qF 'Failed suite(s):'
check_rc $? 1 "#4584: no Failed-suite line when everything passed"

# --- Nothing anywhere → 1 ---
rm -f "$SCRATCH/disclaude-test-server-multimodal-test.log" "$SDKLOG"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 1 "no evidence files → NOT detected"

echo "---"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
