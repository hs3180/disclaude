#!/bin/bash
#
# Regression test for Issue #4691.
#
# Feeds canned agent replies into report_tool_verdict() (in common.sh) and
# asserts the expected outcome. The old tests PASSed whenever the reply merely
# contained a tool keyword, so a sandbox-rejected tool ("send_text" with
# `sandbox_apply: Operation not permitted`) still passed green. This test pins
# the new failure/skip/pass classification.
#
# Usage:
#   ./tests/integration/test-channel-tool-verdict.sh [--verbose]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

_fail_count=0

# Args: response_text  expected_rc (0=pass/skip, 1=fail)  label
check_verdict() {
    local text="$1" expected="$2" label="$3" actual
    RESPONSE_TEXT="$text"
    if report_tool_verdict "$label" > /dev/null 2>&1; then
        actual=0
    else
        actual=1
    fi
    if [ "$actual" = "$expected" ]; then
        log_pass "verdict $label: rc=$actual (expected $expected)"
    else
        log_fail "verdict $label: got rc=$actual expected $expected"
        _fail_count=$((_fail_count + 1))
    fi
}

# 1. Sandbox blocker (the #4691 false-green case) -> SKIP (rc 0)
check_verdict \
  "我调用了 send_text 但工具提示 sandbox_apply: Operation not permitted，消息没有发出。" \
  0 "sandbox-blocked"

# 2. Hard, non-environmental tool failure -> FAIL (rc 1)
check_verdict \
  "send_file 调用失败：RuntimeError EACCES Permission denied，文件未发送。" \
  1 "hard-permission-failure"

# 3. Explicitly refused to run -> FAIL (rc 1)
check_verdict \
  "我无法执行该工具调用，工具提示 was not executed。" \
  1 "tool-not-executed"

# 4. Positive execution confirmation -> PASS (rc 0)
check_verdict \
  "send_text 已执行成功，消息已发送，messageId: om_123。" \
  0 "tool-ack-success"

# 5. No verifiable signal -> FAIL (rc 1)
check_verdict \
  "好的，我来看看。回答完毕。" \
  1 "no-signal"

if [ "$_fail_count" -gt 0 ]; then
    log_error "$_fail_count tool-verdict assertion(s) failed"
    exit 1
fi
log_info "tool-verdict regression tests passed"
exit 0