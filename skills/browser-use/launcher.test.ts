import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'browser-launcher-unit-')); roots.push(root);
  const managed = join(root, 'bin'), upstream = join(root, 'upstream');
  for (const dir of [managed, upstream]) mkdirSync(dir);
  writeFileSync(join(managed, 'browser-use'), '#!/bin/sh\nread -r line\nprintf "managed:%s:%s" "$line" "$BH_TMP_DIR"\n', { mode: 0o700 });
  writeFileSync(join(upstream, 'browser-use'), '#!/bin/sh\nprintf upstream\n', { mode: 0o700 });
  const run = (env: NodeJS.ProcessEnv) => spawnSync('/bin/sh', [resolve('skills/browser-use/scripts/run.sh')], {
    env: { PATH: upstream, ...env }, input: 'python-input\n', encoding: 'utf8',
  });
  return { root, managed, upstream, socket: join(root, 'runtime.json'), run };
}
describe('browser skill launcher', () => {
  it('uses the managed absolute launcher despite an upstream-only PATH and preserves stdin/guards', () => {
    const { socket, run } = fixture();
    const result = run({ DISCLAUDE_BROWSER_RUNTIME: socket, BH_TMP_DIR: '/dev/null' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('managed:python-input:/dev/null');
  });
  it('rejects a non-absolute manifest and a missing manifest-relative launcher without upstream fallback', () => {
    const { root, run } = fixture();
    for (const socket of ['relative/runtime.json', join(root, 'nested/runtime.json')]) {
      const result = run({ DISCLAUDE_BROWSER_RUNTIME: socket });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr).toMatch(/runtime|launcher/i);
    }
  });
  it('fails closed without the service-managed launcher', () => {
    const result = fixture().run({});
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/Browser runtime is unavailable/);
  });
  it('prints same-source diagnosis and a recovery hint when the launcher is unavailable (#5601)', () => {
    const { root, upstream, run } = fixture();
    const fake = join(root, 'fake-bin');
    mkdirSync(fake);
    // Same source as `disclaude browser status --json`: whatever the CLI
    // prints is relayed on stderr, followed by one recovery line.
    writeFileSync(join(fake, 'disclaude'), '#!/bin/sh\necho \'{"available":false,"state":"unavailable","endpointSource":"none"}\'\n', { mode: 0o700 });
    const result = run({ PATH: `${fake}:${upstream}`, DISCLAUDE_BROWSER_RUNTIME: join(root, 'missing', 'runtime.json') });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('"available":false');
    expect(result.stderr).toMatch(/[Rr]ecovery:.+disclaude browser status --json/);
    expect(result.stderr).toMatch(/launcher is missing/);
  });
});
