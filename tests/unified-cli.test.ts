import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

describe('installed unified CLI argument forwarding', () => {
  it('preserves start for the service parser and keeps channel routing unchanged outside the repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'disclaude-cli-routing-'));
    try {
      mkdirSync(join(root, 'bin'));
      mkdirSync(join(root, 'outside'));
      writeFileSync(join(root, 'package.json'), '{"type":"module"}');
      copyFileSync(fileURLToPath(new URL('../bin/disclaude.js', import.meta.url)), join(root, 'bin/disclaude.js'));
      for (const name of ['service', 'channel-cli']) {
        const target = join(root, 'node_modules/@disclaude', name, 'dist');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, '../package.json'), '{"type":"module"}');
        writeFileSync(join(target, 'cli.js'), 'console.log(JSON.stringify({ok:true,args:process.argv.slice(2)}));');
      }
      for (const [input, forwarded] of [
        [['start', '--config', '/tmp/path with spaces.yaml'], ['start', '--config', '/tmp/path with spaces.yaml']],
        [['channel', 'send_text', '--chat', 'test'], ['send_text', '--chat', 'test']],
      ]) {
        const out = execFileSync(process.execPath, [join(root, 'bin/disclaude.js'), ...input], {
          cwd: join(root, 'outside'), encoding: 'utf8', timeout: 10_000,
        });
        expect(JSON.parse(out).args).toEqual(forwarded);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
