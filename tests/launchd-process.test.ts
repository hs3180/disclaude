import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

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

// T-038 rework 3 (#5619 audit comment 6649207648): repeated install/start with
// the service already loaded must be an idempotent success (or an explicit
// reload) — never a "restart first" error; concurrent changes queue on a
// bounded activation lock; uninstall cleans service-owned state verifiably.
// Shared stateful fake launchd: `bootstrap` fails (exit 5) while the job is
// loaded, `bootout` unloads, `print` reports state/pid only when loaded — the
// real launchctl contract the recovery paths rely on.
function makeStatefulServiceState() {
  const dir = mkdtempSync(join(tmpdir(), 'launchd idempotent '));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const trace = join(dir, 'trace');
  const loaded = join(dir, 'loaded.flag');
  writeFileSync(
    join(bin, 'launchctl'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$#" "$@" >> "$LAUNCHD_TEST_TRACE"',
      'case "$1" in',
      '  bootstrap) if [ -f "$SERVICE_TEST_LOADED" ]; then exit 5; fi; touch "$SERVICE_TEST_LOADED"; exit 0;;',
      '  bootout) rm -f "$SERVICE_TEST_LOADED"; exit 0;;',
      '  print) if [ -f "$SERVICE_TEST_LOADED" ]; then printf "state = running\\npid = 4242\\n"; exit 0; fi; exit 1;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  const label = 'com.disclaude.test.idempotent';
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'LaunchAgents'), { recursive: true });
  const configPath = join(stateDir, 'config.yaml');
  writeFileSync(configPath, 'launchd:\n  apiPort: 8400\n');
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LAUNCHD_TEST_TRACE: trace,
    SERVICE_TEST_LOADED: loaded,
    DISCLAUDE_LAUNCHD_ISOLATED: '1',
    DISCLAUDE_LAUNCHD_LABEL: label,
    DISCLAUDE_LAUNCHD_STATE_DIR: stateDir,
    DISCLAUDE_LAUNCHD_CONFIG_PATH: configPath,
    DISCLAUDE_LAUNCHD_ENTRY: join(dir, 'entry.js'),
  } as Record<string, string>;
  delete env.DISCLAUDE_LAUNCHD_API_PORT;
  const run = (command: string, overrides: Record<string, string> = {}) =>
    spawnSync(process.execPath, [resolve('scripts/launchd.mjs'), 'isolated', command], {
      env: { ...env, ...overrides },
      encoding: 'utf-8',
    });
  return { dir, trace, loaded, label, stateDir, configPath, run };
}

describe('isolated service idempotent install and verified uninstall (T-038 rework 3)', () => {
  it('repeated install is a no-op with the current plist and an explicit reload when it changed', () => {
    const state = makeStatefulServiceState();
    try {
      const uid = process.getuid();
      const plist = join(state.stateDir, 'LaunchAgents', `${state.label}.plist`);

      const first = state.run('install');
      expect(first.status, first.stderr).toBe(0);
      expect(readFileSync(state.trace, 'utf-8')).toBe(['3', 'bootstrap', `gui/${uid}`, plist, ''].join('\n'));

      // Second install, same config: the regenerated plist is byte-identical
      // and the service is loaded — success WITHOUT bootout/bootstrap churn.
      const second = state.run('install');
      expect(second.status, second.stderr).toBe(0);
      expect(second.stdout).toContain('nothing to do (idempotent install/start)');
      expect(readFileSync(state.trace, 'utf-8')).toBe(
        ['3', 'bootstrap', `gui/${uid}`, plist, '2', 'print', `gui/${uid}/${state.label}`, ''].join('\n')
      );

      // Third install with a changed port: explicit reload — bootstrap fails
      // (already loaded), print confirms, bootout + bootstrap apply the new plist.
      const third = state.run('install', { DISCLAUDE_LAUNCHD_API_PORT: '8401' });
      expect(third.status, third.stderr).toBe(0);
      expect(third.stdout).toContain('Service already bootstrapped; reloading with the new plist.');
      expect(readFileSync(state.trace, 'utf-8')).toBe(
        [
          '3', 'bootstrap', `gui/${uid}`, plist,
          '2', 'print', `gui/${uid}/${state.label}`,
          '3', 'bootstrap', `gui/${uid}`, plist,
          '2', 'print', `gui/${uid}/${state.label}`,
          '2', 'bootout', `gui/${uid}/${state.label}`,
          '3', 'bootstrap', `gui/${uid}`, plist,
          '',
        ].join('\n')
      );
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('stop stays a no-op when not loaded; uninstall removes owned state and keeps user data', () => {
    const state = makeStatefulServiceState();
    try {
      expect(state.run('install').status).toBe(0);
      expect(state.run('stop').status).toBe(0);
      const stopAgain = state.run('stop');
      expect(stopAgain.status, stopAgain.stderr).toBe(0);
      expect(stopAgain.stdout).toContain('Service is not loaded (nothing to boot out).');
      // Exactly one bootout ran (the first stop); the not-loaded stop added none.
      expect(readFileSync(state.trace, 'utf-8').split('bootout').length - 1).toBe(1);

      const logDir = join(state.stateDir, 'logs');
      mkdirSync(logDir, { recursive: true });
      const serviceLogs = [
        'disclaude-combined.log', 'disclaude-combined.1.log', 'disclaude-combined.7.log',
        'launchd-stdout.log', 'launchd-stderr.log', 'current.log',
      ];
      for (const name of serviceLogs) writeFileSync(join(logDir, name), 'log\n');
      writeFileSync(join(logDir, 'chromium-cdp-stdout.log'), 'chromium sidecar log\n');
      writeFileSync(join(logDir, 'unrelated.txt'), 'foreign\n');

      const uninstall = state.run('uninstall');
      expect(uninstall.status, uninstall.stderr).toBe(0);
      expect(existsSync(join(state.stateDir, 'LaunchAgents', `${state.label}.plist`))).toBe(false);
      for (const name of serviceLogs) expect(existsSync(join(logDir, name))).toBe(false);
      // Chromium sidecar logs, foreign files, the shared directory and the
      // operator's config are not service-owned — they stay.
      expect(existsSync(join(logDir, 'chromium-cdp-stdout.log'))).toBe(true);
      expect(existsSync(join(logDir, 'unrelated.txt'))).toBe(true);
      expect(existsSync(logDir)).toBe(true);
      expect(existsSync(state.configPath)).toBe(true);
      expect(uninstall.stdout).toContain('Operator config');
      expect((uninstall.stdout.match(/Log removed:/g) ?? []).length).toBe(6);

      // Once the directory holds nothing else, a second (not-loaded) uninstall
      // takes the now-empty log directory too.
      rmSync(join(logDir, 'chromium-cdp-stdout.log'));
      rmSync(join(logDir, 'unrelated.txt'));
      const uninstallAgain = state.run('uninstall');
      expect(uninstallAgain.status, uninstallAgain.stderr).toBe(0);
      expect(uninstallAgain.stdout).toContain('Plist already absent');
      expect(existsSync(logDir)).toBe(false);
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('activation lock: bounded queue/retry with timeout diagnostics (T-038 rework 3)', () => {
  it('fails fast with holder diagnostics when the lock is stale (holder crashed)', () => {
    const state = makeStatefulServiceState();
    try {
      const reaped = spawnSync(process.execPath, ['-e', '']);
      const lockPath = join(state.stateDir, 'LaunchAgents', `${state.label}.plist.activation.lock`);
      writeFileSync(lockPath, `${reaped.pid}\n`);
      const run = state.run('install');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('stale lock');
      expect(run.stderr).toContain(`PID ${reaped.pid}`);
      expect(run.stderr).toContain('No service was changed');
      // Failed before any launchctl call, and never removes another holder's lock.
      expect(existsSync(state.trace)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('queues behind a live holder and proceeds once it releases', () => {
    const state = makeStatefulServiceState();
    const holderScript = join(state.dir, 'holder.sh');
    writeFileSync(holderScript, '#!/bin/sh\necho $$ > "$1"\nsleep 1.5\nrm -f "$1"\n', { mode: 0o755 });
    const lockPath = join(state.stateDir, 'LaunchAgents', `${state.label}.plist.activation.lock`);
    const holder = spawn('sh', [holderScript, lockPath], { stdio: 'ignore' });
    try {
      const deadline = Date.now() + 5000;
      while (!existsSync(lockPath) && Date.now() < deadline) {
        // Bounded busy-wait for the holder to publish its lock.
        spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 25)']);
      }
      expect(existsSync(lockPath)).toBe(true);
      const run = state.run('install', { DISCLAUDE_LAUNCHD_LOCK_TIMEOUT_MS: '10000' });
      expect(run.status, run.stderr).toBe(0);
      expect(readFileSync(state.trace, 'utf-8')).toContain('bootstrap');
      // The queued command removed its own lock on the way out.
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      holder.kill();
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports holder, budget and waited time when the queue budget is exhausted', () => {
    const state = makeStatefulServiceState();
    try {
      const lockPath = join(state.stateDir, 'LaunchAgents', `${state.label}.plist.activation.lock`);
      // This test process is alive and holds the lock without releasing it.
      writeFileSync(lockPath, `${process.pid}\n`);
      const run = state.run('install', { DISCLAUDE_LAUNCHD_LOCK_TIMEOUT_MS: '700' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('Timed out');
      expect(run.stderr).toContain(`held by PID ${process.pid}`);
      expect(run.stderr).toContain('budget 700ms');
      expect(run.stderr).toContain('No service was changed');
      expect(existsSync(state.trace)).toBe(false);
      rmSync(lockPath, { force: true });
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);
});

// Chromium sidecar uninstall (T-038 rework 3): service-owned state (plist,
// saved selection, logs) goes verifiably; the profile is user data — retained
// by default with an explicit --purge-profile opt-in, both states pinned here.
function makeChromiumUninstallState() {
  const dir = mkdtempSync(join(tmpdir(), 'launchd chromium rework3 '));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const trace = join(dir, 'trace');
  // Not loaded: `print` fails, so stop/uninstall stay no-ops on the launchctl side.
  writeFileSync(
    join(bin, 'launchctl'),
    ['#!/bin/sh', 'printf "%s\\n" "$#" "$@" >> "$LAUNCHD_TEST_TRACE"', 'if [ "$1" = "print" ]; then exit 1; fi', 'exit 0', ''].join('\n'),
    { mode: 0o755 }
  );
  const label = 'com.disclaude.test.chromium-rework3';
  const stateDir = join(dir, 'state');
  mkdirSync(join(stateDir, 'LaunchAgents'), { recursive: true });
  const configPath = join(stateDir, 'chromium-cdp.json');
  const profileDir = join(stateDir, 'profile');
  const plistPath = join(stateDir, 'LaunchAgents', `${label}.plist`);
  writeFileSync(plistPath, 'chromium-definition\n');
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        version: 1,
        environment: {
          CHROMIUM_CDP_BINARY: '/usr/bin/true',
          CHROMIUM_CDP_PROFILE_DIR: profileDir,
          CHROMIUM_CDP_PORT: '9333',
          CHROMIUM_CDP_ADDRESS: '127.0.0.1',
          CHROMIUM_CDP_HEADED: '0',
          CHROMIUM_CDP_AUTOSTART: '1',
        },
      },
      null,
      2
    ) + '\n'
  );
  const marker = join(profileDir, 'logins-profile-data');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(marker, 'user login state\n');
  const logDir = join(stateDir, 'logs');
  mkdirSync(logDir, { recursive: true });
  writeFileSync(join(logDir, 'chromium-cdp-stdout.log'), 'out\n');
  writeFileSync(join(logDir, 'chromium-cdp-stderr.log'), 'err\n');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    LAUNCHD_TEST_TRACE: trace,
    DISCLAUDE_LAUNCHD_ISOLATED: '1',
    DISCLAUDE_LAUNCHD_LABEL: label,
    DISCLAUDE_LAUNCHD_STATE_DIR: stateDir,
    DISCLAUDE_LAUNCHD_CONFIG_PATH: join(stateDir, 'service.yaml'),
    DISCLAUDE_CHROMIUM_CONFIG: configPath,
    CHROMIUM_CDP_PROFILE_DIR: profileDir,
    CHROMIUM_CDP_PORT: '9333',
  };
  const run = (command: string, args: string[] = []) =>
    spawnSync(process.execPath, [resolve('scripts/launchd.mjs'), 'chromium-isolated', command, ...args], {
      env,
      encoding: 'utf-8',
    });
  return { dir, stateDir, label, plistPath, configPath, profileDir, marker, logDir, trace, run };
}

describe('isolated chromium uninstall cleans owned state and handles the profile explicitly (T-038 rework 3)', () => {
  it('default: removes plist, saved selection and logs; retains the profile (user data)', () => {
    const state = makeChromiumUninstallState();
    try {
      const run = state.run('uninstall');
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(state.plistPath)).toBe(false);
      expect(existsSync(state.configPath)).toBe(false);
      expect(existsSync(join(state.logDir, 'chromium-cdp-stdout.log'))).toBe(false);
      expect(existsSync(join(state.logDir, 'chromium-cdp-stderr.log'))).toBe(false);
      // The profile is NEVER deleted silently — marker content survives.
      expect(readFileSync(state.marker, 'utf-8')).toBe('user login state\n');
      expect(run.stdout).toContain(`Chromium profile (user data) retained: ${state.profileDir}`);
      expect(run.stdout).toContain('--purge-profile');
      expect(run.stdout).toContain('Saved Chromium selection removed');
      // Not loaded → no bootout, idempotent unload.
      expect(readFileSync(state.trace, 'utf-8').split('\n').filter((l) => l === 'print').length).toBeGreaterThan(0);
      expect(readFileSync(state.trace, 'utf-8')).not.toContain('bootout');
      expect(run.stdout).toContain('Chromium CDP service uninstalled.');
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('explicit --purge-profile removes the profile after unload and verifies it', () => {
    const state = makeChromiumUninstallState();
    try {
      const run = state.run('uninstall', ['--purge-profile']);
      expect(run.status, run.stderr).toBe(0);
      expect(existsSync(state.plistPath)).toBe(false);
      expect(existsSync(state.configPath)).toBe(false);
      expect(existsSync(state.profileDir)).toBe(false);
      expect(run.stdout).toContain(`Chromium profile removed (--purge-profile): ${state.profileDir}`);
      expect(run.stdout).not.toContain('retained');
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);

  it('queues on the sidecar plist lock and names it when the holder is stale', () => {
    const state = makeChromiumUninstallState();
    try {
      const reaped = spawnSync(process.execPath, ['-e', '']);
      const lockPath = join(state.stateDir, 'LaunchAgents', `${state.label}.plist.activation.lock`);
      writeFileSync(lockPath, `${reaped.pid}\n`);
      const run = state.run('uninstall');
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('stale lock');
      expect(run.stderr).toContain(lockPath);
      // Nothing was uninstalled while the lock was stale.
      expect(existsSync(state.plistPath)).toBe(true);
    } finally {
      rmSync(state.dir, { recursive: true, force: true });
    }
  }, 30_000);
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
