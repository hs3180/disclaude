import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function runScenario(deadCode: number, reloadFails = false, healthyCode = 0) {
  const dir = mkdtempSync(join(tmpdir(), 'smoke test '));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const executable = (name: string, code: string) => writeFileSync(join(bin, name), '#!/bin/bash\n' + code, { mode: 0o755 });
    executable('curl', 'exit 0\n');
    executable('pgrep', 'echo 100\n');
    executable('timeout', 'shift; exec "$@"\n');
    executable('python-probe', 'echo DAEMON_STOPPED\n');
    executable('browser-use', `
if [ "\${1:-}" = --version ]; then echo mock; exit 0; fi
printf '%s %s\\n' "$BU_NAME" "$BH_RUNTIME_DIR" >> "$TRACE"
if [ "\${1:-}" = --reload ]; then exit ${reloadFails ? 1 : 0}; fi
code=$(cat)
if [ "$BU_CDP_URL" = http://127.0.0.1:9 ]; then echo DEAD_CALLED >> "$TRACE"; exit ${deadCode}; fi
case "$code" in
 *Target.createTarget*) echo target-id > "$SMOKE_TARGET_FILE"; echo OWNED_TARGET_OK; exit ${healthyCode} ;;
 *STRUCTURED_OK*) echo STRUCTURED_OK ;;
 *has_title*) echo '{"has_title":true,"tab_count":1}' ;;
 *capture_screenshot*) printf '\\211PNG\\r\\n\\032\\n' > "$SMOKE_SHOT" ;;
 *TARGET_CLEANED*) rm -f "$SMOKE_TARGET_FILE"; echo TARGET_CLEANED ;;
esac
`);
    const trace = join(dir, 'trace');
    const result = spawnSync('bash', [resolve('scripts/browser-use-smoke.sh')], { encoding: 'utf8', env: {
      ...process.env, PATH: `${bin}:${process.env.PATH}`, SMOKE_PYTHON: join(bin, 'python-probe'),
      SMOKE_CDP_URL: 'http://test:9222', SMOKE_OUT_DIR: join(dir, 'artifacts " with quotes'),
      BU_NAME: 'daily-user', BH_RUNTIME_DIR: '/do-not-use', TRACE: trace,
    } });
    return { ...result, trace: readFileSync(trace, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('CDP smoke validity', () => {
  it('accepts a prompt endpoint failure and isolates inherited daemon settings', () => {
    const result = runScenario(1);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.trace).toContain('DEAD_CALLED');
    expect(result.trace).not.toMatch(/daily-user|do-not-use/);
    const names = result.trace.split('\n').filter(line => line.startsWith('smoke_')).map(line => line.split(' ')[0]);
    expect(new Set(names).size).toBe(1);
  });
  it.each([0, 124, 125, 126, 127, 137, 143])('does not count exit %i as a verified dead-endpoint failure', code => {
    const result = runScenario(code);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('case 6: no verified prompt failure');
  });
  it('skips the dead endpoint when reload fails', () => {
    const result = runScenario(1, true);
    expect(result.status).toBe(1);
    expect(result.trace).not.toContain('DEAD_CALLED');
    expect(result.stdout).toContain('cold-start precondition failed');
  });
  it('fails even when a failed healthy command prints the expected marker', () => {
    const result = runScenario(1, false, 1);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('case 2: attach failed');
  });
});

describe('portable smoke timeout', () => {
  it('preserves exit status and marks a killed command as timeout', () => {
    const helper = resolve('scripts/browser-use-smoke-timeout.py');
    const normal = spawnSync('python3', [helper, '2', 'bash', '-c', 'exit 7']);
    expect(normal.status).toBe(7);
    const timed = spawnSync('python3', [helper, '0.05', 'bash', '-c', 'sleep 5']);
    expect(timed.status).toBe(124);
  });
});
