import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./run-all-tests.sh', import.meta.url));
const common = fileURLToPath(new URL('./common.sh', import.meta.url));
function bash(script: string) {
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8', timeout: 10_000,
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
    const result = bash(`${harness}\nrun_suite() { _SUITE_COUNT=$((_SUITE_COUNT + 1)); return 1; }\nmain`);
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
  for (const name of ['test-build-check', 'test-channel-tool-verdict',
    'test-common-provider-errors', 'test-common-retry', 'test-drain-barrier',
    'test-exact-number', 'test-lifecycle-stats', 'test-no-pileup',
    'test-pool-idle', 'test-runner-args']) {
    it(name, () => {
      const result = spawnSync('bash', [fileURLToPath(new URL(`./${name}.sh`, import.meta.url))], {
        encoding: 'utf8', timeout: 10_000,
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).not.toContain('FAIL:');
    });
  }
});
