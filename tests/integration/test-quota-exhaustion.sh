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
# Run from a scratch cwd so the derived log name resolves to our fixture.
SCRATCH="$TMPDIR_FIX/scratch"
mkdir -p "$SCRATCH"
: > "$SCRATCH/multimodal-test.sh"
printf '%s\n' \
  '[info]: server ready' \
  'stderr: {"error":{"type":"rate_limit_error","code":1308,"message":"已达到 5 小时的使用上限"}}' \
  > "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 0 "tier 2: per-suite server log with 1308 detected"

printf '%s\n' '[info]: server ready' > "$SCRATCH/disclaude-test-server-multimodal-test.log"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 1 "tier 2: clean server log NOT detected"

# --- Tier 3: SDK debug log pointed to by the server log banner ---
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

# --- Nothing anywhere → 1 ---
rm -f "$SCRATCH/disclaude-test-server-multimodal-test.log" "$SDKLOG"
( cd "$SCRATCH" && detect_quota_exhaustion "" "$SCRATCH/multimodal-test.sh" )
check_rc $? 1 "no evidence files → NOT detected"

echo "---"
echo "RESULT: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
