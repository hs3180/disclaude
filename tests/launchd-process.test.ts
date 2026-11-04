import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// #5619 (T-038): install/uninstall moved from the legacy file-path form
// (`launchctl load/unload <plist>`) to the modern domain-target API
// (`bootstrap gui/<uid> <plist>` / `bootout gui/<uid>/<label>`, with `print`
// probing state). This rehearsal keeps the original intent — a spaced plist
// path must still travel as ONE argument, and the selected version entry must
// survive — while asserting the new command sequence.
describe('isolated launchd process dispatch', () => {
  it('passes a spaced plist path as one bootstrap argument and preserves the selected version entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchd path with spaces '));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const trace = join(dir, 'trace');
      // Trace arg count then every argument on its own line, so a spaced path
      // collapsing into several argv entries would be caught.
      writeFileSync(
        join(bin, 'launchctl'),
        '#!/bin/sh\nprintf "%s\\n" "$#" "$@" >> "$LAUNCHD_TEST_TRACE"\n',
        { mode: 0o755 }
      );
      const label = 'com.disclaude.test.paths';
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAUNCHD_TEST_TRACE: trace,
        DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: label,
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
      const uid = process.getuid();
      expect(readFileSync(trace, 'utf8')).toBe(
        [
          // install: `launchctl bootstrap gui/<uid> <plist>` — spaced path is $3, one argument.
          '3', 'bootstrap', `gui/${uid}`, plist,
          // uninstall: `print` probes the domain target first, then `bootout` removes it.
          '2', 'print', `gui/${uid}/${label}`,
          '2', 'bootout', `gui/${uid}/${label}`,
          '',
        ].join('\n')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
