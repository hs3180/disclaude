import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('isolated launchd process dispatch', () => {
  it('passes a spaced plist path as one argument and preserves the selected version entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchd path with spaces '));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const trace = join(dir, 'trace');
      writeFileSync(
        join(bin, 'launchctl'),
        '#!/bin/sh\nprintf "%s\\n" "$#" "$1" "$2" >> "$LAUNCHD_TEST_TRACE"\n',
        { mode: 0o755 }
      );
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAUNCHD_TEST_TRACE: trace,
        DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: 'com.disclaude.test.paths',
        DISCLAUDE_LAUNCHD_STATE_DIR: dir,
        DISCLAUDE_LAUNCHD_CONFIG_PATH: join(dir, 'config.yaml'),
        DISCLAUDE_LAUNCHD_ENTRY: join(dir, 'old version', 'cli.js'),
      };
      for (const command of ['install', 'uninstall']) {
        const run = spawnSync(
          process.execPath,
          [resolve('scripts/launchd.mjs'), 'isolated', command],
          { env, encoding: 'utf8' }
        );
        expect(run.status, run.stderr).toBe(0);
        if (command === 'install') {
          expect(
            readFileSync(join(dir, 'LaunchAgents/com.disclaude.test.paths.plist'), 'utf8')
          ).toContain(join(dir, 'old version', 'cli.js'));
        }
      }
      const plist = join(dir, 'LaunchAgents/com.disclaude.test.paths.plist');
      expect(readFileSync(trace, 'utf8')).toBe(`2\nload\n${plist}\n2\nunload\n${plist}\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
