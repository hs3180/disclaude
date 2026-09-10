import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-all-tests.sh', import.meta.url));
const common = fileURLToPath(new URL('./common.sh', import.meta.url));
function bash(script: string) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
    env: { ...process.env, TEST_RUNNER: runner, TEST_COMMON: common },
  });
}
const harness = `
source "$TEST_RUNNER"
check_prerequisites() { return 0; }
start_server() { return 0; }
cleanup() { :; }
warmup_agent() { return 0; }
run_suite() { _SUITE_COUNT=$((_SUITE_COUNT + 1)); return 0; }
_EXIT_LISTENER_BASELINE=""
`;

describe('release integration runner verdicts', () => {
  it('succeeds when all selected suites execute successfully', () => {
    const result = bash(`${harness}\nmain`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain('All selected test suites passed!');
  });
  it('fails when backend unavailability skips AI acceptance', () => {
    const result = bash(`${harness}\nCODEX_ENV_BLOCKED=true\nmain`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Integration acceptance incomplete');
    expect(result.stdout).not.toContain('All selected test suites passed!');
  });
  it('fails when a filter selects no suites', () => {
    const result = bash(`${harness}\nFILTER_ARGS=(--name nonexistent-suite)\nmain`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Integration acceptance incomplete');
  });
  it('preserves failures from executed suites', () => {
    const result = bash(
      `${harness}\nrun_suite() { _SUITE_COUNT=$((_SUITE_COUNT + 1)); return 1; }\nmain`
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('Failed suite(s):');
  });
});

describe('integration server ownership', () => {
  for (const healthy of [true, false]) {
    it(`refuses an unrelated ${healthy ? 'healthy' : 'unhealthy'} service without signaling it`, () => {
      const result = bash(`
source "$TEST_COMMON"
is_server_running() { ${healthy ? 'true' : 'false'}; }
is_port_in_use() { true; }
kill() { echo UNEXPECTED_KILL; }
SERVER_PID=""
start_server
`);
      expect(result.status).toBe(1);
      expect(result.stdout).not.toContain('UNEXPECTED_KILL');
      expect(result.stdout).not.toContain('reusing existing server');
    });
  }
  it('keeps ownership when reusing its own live test server', () => {
    const result = bash(`
source "$TEST_COMMON"
is_server_running() { true; }
SERVER_PID=$$
start_server || exit 1
[ "$SERVER_PID" = "$$" ]
`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

// Keep every standalone source-level shell regression in the normal CI suite.
describe('integration shell regressions', () => {
  for (const name of [
    'test-build-check',
    'test-channel-tool-verdict',
    'test-common-provider-errors',
    'test-common-retry',
    'test-drain-barrier',
    'test-exact-number',
    'test-lifecycle-stats',
    'test-no-pileup',
    'test-pool-idle',
    'test-runner-args',
  ]) {
    it(name, () => {
      const result = spawnSync('bash', [fileURLToPath(new URL(`./${name}.sh`, import.meta.url))], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).not.toContain('FAIL:');
    });
  }
});

describe('per-suite acceptance summary', () => {
  it('rejects skipped checks and empty execution', () => {
    for (const setup of ['TESTS_PASSED=1; log_skip "sandbox blocked"', 'TESTS_PASSED=0']) {
      const result = bash(`source "$TEST_COMMON"; ${setup}; print_summary`);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('Incomplete acceptance');
    }
  });
  it('accepts a completed suite without skips', () => {
    const result = bash('source "$TEST_COMMON"; TESTS_PASSED=1; print_summary');
    expect(result.status).toBe(0);
  });
});

describe('channel tool integration fixtures', () => {
  it('uses a valid CLI session and puts the file inside the configured workspace', () => {
    const result = bash(`
fixture=$(mktemp -d)
export DISCLAUDE_WORKSPACE_DIR="$fixture"
export DISCLAUDE_TEST_DELIVERY_CHAT_ID=cli-test-channel-fixture
source "$(dirname "$TEST_COMMON")/channel-cli-test.sh"
trap 'rm -rf "$fixture"' EXIT
assert_sync_chat_ok() {
  case "$2" in cli-test-channel-*) ;; *) return 1 ;; esac
  [ -f "$TEST_FILE_PATH" ] || return 1
  [ "$TEST_FILE_PATH" = "$fixture/channel-cli-test-file.txt" ]
}
report_tool_verdict() { return 0; }
test_send_file_tool || exit 1
[ ! -f "$TEST_FILE_PATH" ]
`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

describe('standalone suite server ownership', () => {
  it('refuses a live server without an explicit runner-owned share', () => {
    const result = bash(`source "$TEST_COMMON"
is_server_running() { true; }
run_tests() { echo SHOULD_NOT_RUN; }
main_test_suite "ownership"
`);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('SHOULD_NOT_RUN');
  });
  it('can share the live server explicitly passed by its runner', () => {
    const result = bash(`source "$TEST_COMMON"
is_server_running() { true; }
INTEGRATION_SHARED_SERVER_PID=$$
INTEGRATION_SHARED_SERVER_URL="$API_URL"
run_tests() { TESTS_PASSED=1; }
main_test_suite "ownership"
`);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

it('uses a unique valid async probe chat and the configured drain deadline', () => {
  const result = bash(`
source "$(dirname "$TEST_COMMON")/rest-channel-test.sh"
TIMEOUT=123
unset REST_DRAIN_TIMEOUT
make_request() { printf '%s\\n' "$3" >&2; }
parse_response() { RESPONSE_STATUS=200; RESPONSE_BODY='{"success":true,"messageId":"receipt"}'; }
wait_for_agent_pool_idle() { [ "$1" = 123 ]; }
test_chat_async_receipt
`);
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/"chatId": "cli-rest-async-\d+"/);
  expect(result.stderr).not.toContain('$$');
});


describe('integration JSON response parsing', () => {
  it('preserves escaped quotes, newlines and the final answer after tool output', () => {
    const result = bash(String.raw`
source "$TEST_COMMON"
RESPONSE_BODY='{"response":"tool says \"ok\"\n425","success":true}'
extract_json_field response
printf '\n'
extract_json_bool success
`);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe('tool says "ok"\n425\ntrue');
  });
});
