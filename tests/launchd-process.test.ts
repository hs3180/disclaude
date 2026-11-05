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

// #5664 review (T-038 rework 2): the Chromium sidecar lifecycle moves off the
// legacy file-path form too. stop/uninstall probe with `print` and unload via
// `bootout gui/<uid>/<label>` (idempotent when not loaded); status reads
// state/pid from print output instead of `launchctl list <label>`.
describe('isolated chromium launchd process dispatch', () => {
  it('reports print pid, stops via bootout, and treats not-loaded as a no-op', () => {
    const dir = mkdtempSync(join(tmpdir(), 'launchd chromium isolated '));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      const trace = join(dir, 'trace');
      const loaded = join(dir, 'loaded.flag');
      writeFileSync(loaded, '');
      // Stateful fake: `print` succeeds only while the job is "loaded";
      // `bootout` flips that state so later probes see not-loaded.
      writeFileSync(
        join(bin, 'launchctl'),
        [
          '#!/bin/sh',
          'printf "%s\\n" "$#" "$@" >> "$LAUNCHD_TEST_TRACE"',
          'if [ "$1" = "bootout" ]; then rm -f "$CHROMIUM_TEST_LOADED"; fi',
          'if [ "$1" = "print" ]; then',
          '  if [ -f "$CHROMIUM_TEST_LOADED" ]; then printf "state = running\\npid = 4242\\n"; exit 0; fi',
          '  exit 1',
          'fi',
          'exit 0',
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      const label = 'com.disclaude.test.chromium';
      const stateDir = join(dir, 'state');
      mkdirSync(join(stateDir, 'LaunchAgents'), { recursive: true });
      const env = {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LAUNCHD_TEST_TRACE: trace,
        CHROMIUM_TEST_LOADED: loaded,
        DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: label,
        DISCLAUDE_LAUNCHD_STATE_DIR: stateDir,
        DISCLAUDE_LAUNCHD_CONFIG_PATH: join(stateDir, 'config.yaml'),
        DISCLAUDE_CHROMIUM_CONFIG: join(stateDir, 'chromium-cdp.json'),
        CHROMIUM_CDP_PROFILE_DIR: join(stateDir, 'profile'),
        CHROMIUM_CDP_PORT: '9333',
      };
      const runCommand = (command: string) =>
        spawnSync(process.execPath, [resolve('scripts/launchd.mjs'), 'chromium-isolated', command], {
          env,
          encoding: 'utf8',
        });

      // Loaded with no plist on disk: status still reports the print pid
      // (exit 1 is the documented "loaded but not CDP-ready" signal).
      const status = runCommand('status');
      expect(status.status, status.stderr).toBe(1);
      expect(status.stdout).toContain('"pid":4242');
      expect(status.stdout).toContain('"loaded":true');

      const stop = runCommand('stop');
      expect(stop.status, stop.stderr).toBe(0);
      expect(stop.stdout).toContain(`Service unloaded (${label})`);

      // Not loaded any more: uninstall probes, boots out nothing, stays idempotent.
      const uninstall = runCommand('uninstall');
      expect(uninstall.status, uninstall.stderr).toBe(0);

      const uid = process.getuid();
      expect(readFileSync(trace, 'utf8')).toBe(
        [
          // status: `print` replaces `list <label>`; its output feeds pid.
          '2', 'print', `gui/${uid}/${label}`,
          // stop: print finds the job loaded → bootout removes it by target.
          '2', 'print', `gui/${uid}/${label}`,
          '2', 'bootout', `gui/${uid}/${label}`,
          // uninstall: print says not loaded → no bootout, nothing to remove.
          '2', 'print', `gui/${uid}/${label}`,
          '',
        ].join('\n')
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
