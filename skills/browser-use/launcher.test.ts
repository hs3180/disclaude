import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-launcher-unit-')); roots.push(root);
  const managed = join(root, 'managed bin'), upstream = join(root, 'upstream');
  for (const dir of [managed, upstream]) mkdirSync(dir);
  writeFileSync(join(managed, 'browser-use'), '#!/bin/sh\nread -r line\nprintf "managed:%s:%s" "$line" "$BH_TMP_DIR"\n', { mode: 0o700 });
  writeFileSync(join(upstream, 'browser-use'), '#!/bin/sh\nprintf upstream\n', { mode: 0o700 });
  const run = (env: NodeJS.ProcessEnv) => spawnSync('/bin/sh', [resolve('skills/browser-use/scripts/run.sh')], {
    env: { PATH: upstream, ...env }, input: 'python-input\n', encoding: 'utf8',
  });
  return { managed, run };
}
describe('browser skill launcher', () => {
  it('uses the managed absolute launcher despite an upstream-only PATH and preserves stdin/guards', () => {
    const { managed, run } = fixture();
    const result = run({ DISCLAUDE_BROWSER_SOCKET: '/private/browser.sock', DISCLAUDE_BROWSER_BIN: managed, BH_TMP_DIR: '/dev/null' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('managed:python-input:/dev/null');
  });
  it.each([undefined, 'relative/bin', '/nonexistent/managed/bin'])('rejects unusable managed directory %s without upstream fallback', bin => {
    const result = fixture().run({ DISCLAUDE_BROWSER_SOCKET: '/private/browser.sock', DISCLAUDE_BROWSER_BIN: bin });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/launcher/);
  });
  it('fails closed without the service-managed coordinator', () => {
    const result = fixture().run({});
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Browser IPC is not configured/);
  });
});
