// Issue #5619 / T-038: launchd application-service install must be atomic,
// validated, and driven through the modern launchctl domain-target API.
//
// Covers, offline on Linux CI:
//  ① installPlistAtomically — temp file + rename; lint failure or a thrown
//     "interruption" leaves the previous plist intact and no *.tmp residue.
//  ② plist validation — lintPlistFile/validatePlistStructure as the declared
//     stand-in for `plutil -lint` (plutil is macOS-only; real plutil -lint is
//     verified on macOS, never in CI — see scripts/launchd.mjs lintPlistFile).
//  ③ buildLaunchctlInvocation — exact bootstrap/bootout/print argv.
//  ④⑤ an end-to-end isolated rehearsal under a com.disclaude.test.* label
//     with a fake launchctl on PATH: nothing can touch a production service.
//
// Import/spawn safety mirrors tests/launchd-service-dry-run.test.ts: the
// script is ESM with an isMainEntry guard, so importing it dispatches nothing.

import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync, chmodSync, statSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — .mjs module without type declarations (scripts/ is not type-checked)
import {
  buildServicePlist,
  validatePlistStructure,
  lintPlistFile,
  installPlistAtomically,
  buildLaunchctlInvocation,
  resolveChromiumActivationPlan,
} from '../scripts/launchd.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const LAUNCHD_SCRIPT = join(ROOT, 'scripts', 'launchd.mjs');
const UID = process.getuid();

const PLIST_OPTIONS = {
  label: 'com.disclaude.test.t038',
  programArgs: ['/usr/bin/caffeinate', '-s', '/opt/disclaude/bin/disclaude.js', 'start', '--api-port', '19200'],
  workingDirectory: '/opt/disclaude',
  stdoutLog: '/tmp/logs/out.log',
  stderrLog: '/tmp/logs/err.log',
  logDir: '/tmp/logs',
  home: '/Users/test',
  pathEnv: '/usr/bin:/bin',
  restChannelApiBaseUrl: 'http://127.0.0.1:19200',
  extraEnv: { MY_TOOL_HOME: '/opt/my-tool' },
};

function validPlist(): string {
  // @ts-expect-error — untyped .mjs export
  return buildServicePlist(PLIST_OPTIONS);
}

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assertNoTmpResidue(dir: string) {
  const residue = readdirSync(dir).filter((name) => name.includes('.tmp'));
  expect(residue, `temporary residue left behind: ${residue.join(', ')}`).toEqual([]);
}

// ---------------------------------------------------------------------------
// ② plist validation (plutil -lint equivalent for non-darwin CI)
// ---------------------------------------------------------------------------

describe('plist structural validation (#5619 T-038)', () => {
  it('accepts the plist the generator produces', () => {
    expect(validatePlistStructure(validPlist())).toBeNull();
  });

  it('rejects empty or declaration-less documents', () => {
    expect(validatePlistStructure('')).toBe('plist is empty');
    expect(validatePlistStructure('<plist version="1.0"><dict></dict></plist>')).toContain('XML declaration');
  });

  it('rejects a truncated (half-written) plist', () => {
    const truncated = validPlist().slice(0, -30);
    const error = validatePlistStructure(truncated);
    expect(error).toBeTruthy();
    expect(error).toMatch(/unclosed tag|mismatched|never closed/);
  });

  it('rejects unbalanced tags', () => {
    const unbalanced = validPlist().replace('</plist>', '</array></plist>');
    expect(validatePlistStructure(unbalanced)).toContain('mismatched closing tag');
  });

  it('rejects a plist missing launchd-required keys', () => {
    const noKeepAlive = validPlist().replace('  <key>KeepAlive</key>\n  <true/>\n', '');
    expect(validatePlistStructure(noKeepAlive)).toContain('KeepAlive');
  });

  it('lintPlistFile validates a file on non-darwin (Linux CI) via the structural check', () => {
    const dir = tmpDir('launchd-lint-');
    try {
      const good = join(dir, 'good.plist');
      writeFileSync(good, validPlist());
      expect(lintPlistFile(good, { PLATFORM_OVERRIDE: 'linux' })).toBeNull();
      const bad = join(dir, 'bad.plist');
      writeFileSync(bad, validPlist().slice(0, -25));
      expect(lintPlistFile(bad, { PLATFORM_OVERRIDE: 'linux' })).toBeTruthy();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ① atomic install: temp file + rename, interruption leaves no partial state
// ---------------------------------------------------------------------------

describe('installPlistAtomically (#5619 T-038)', () => {
  it('writes the complete plist, mode 0644, and leaves no temporary residue', () => {
    const dir = tmpDir('launchd-atomic-');
    try {
      const target = join(dir, 'com.disclaude.test.t038.plist');
      const result = installPlistAtomically(target, validPlist(), { lint: () => null });
      expect(result.linted).toBe(true);
      expect(readFileSync(target, 'utf-8')).toBe(validPlist());
      expect(statSync(target).mode & 0o777).toBe(0o644);
      assertNoTmpResidue(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent: re-running replaces the plist wholesale', () => {
    const dir = tmpDir('launchd-atomic-');
    try {
      const target = join(dir, 'com.disclaude.test.t038.plist');
      installPlistAtomically(target, 'first', {});
      installPlistAtomically(target, validPlist(), {});
      expect(readFileSync(target, 'utf-8')).toBe(validPlist());
      assertNoTmpResidue(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a failed lint aborts the install and keeps the previous plist untouched', () => {
    const dir = tmpDir('launchd-atomic-');
    try {
      const target = join(dir, 'com.disclaude.test.t038.plist');
      installPlistAtomically(target, 'previous-plist', {});
      expect(() => installPlistAtomically(target, validPlist(), { lint: () => 'plutil -lint rejected the file' }))
        .toThrow('plutil -lint rejected the file');
      expect(readFileSync(target, 'utf-8')).toBe('previous-plist');
      assertNoTmpResidue(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interruption between write and rename leaves no half-written plist', () => {
    const dir = tmpDir('launchd-atomic-');
    try {
      const target = join(dir, 'com.disclaude.test.t038.plist');
      installPlistAtomically(target, 'previous-plist', {});
      // Simulate the process dying mid-install: the lint step throws.
      expect(() =>
        installPlistAtomically(target, validPlist(), { lint: () => { throw new Error('SIGKILLed mid-install'); } })
      ).toThrow('SIGKILLed mid-install');
      expect(readFileSync(target, 'utf-8')).toBe('previous-plist');
      assertNoTmpResidue(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// ③ modern launchctl domain-target commands
// ---------------------------------------------------------------------------

describe('buildLaunchctlInvocation (#5619 T-038)', () => {
  it('builds bootstrap/bootout/print argv against the gui/<uid> domain', () => {
    const opts = { uid: 501, plistPath: '/Users/op/Library/LaunchAgents/com.disclaude.service.plist', label: 'com.disclaude.service' };
    expect(buildLaunchctlInvocation('bootstrap', opts))
      .toEqual(['bootstrap', 'gui/501', '/Users/op/Library/LaunchAgents/com.disclaude.service.plist']);
    expect(buildLaunchctlInvocation('bootout', opts)).toEqual(['bootout', 'gui/501/com.disclaude.service']);
    expect(buildLaunchctlInvocation('print', opts)).toEqual(['print', 'gui/501/com.disclaude.service']);
  });

  it('keeps the legacy load/unload forms and rejects unknown actions', () => {
    expect(buildLaunchctlInvocation('load', { uid: 501, plistPath: '/tmp/x.plist' })).toEqual(['load', '/tmp/x.plist']);
    expect(buildLaunchctlInvocation('unload', { uid: 501, plistPath: '/tmp/x.plist' })).toEqual(['unload', '/tmp/x.plist']);
    // @ts-expect-error — deliberately invalid action
    expect(() => buildLaunchctlInvocation('kickstart')).toThrow('Unknown launchctl action');
  });
});

// ---------------------------------------------------------------------------
// T-038 rework 3 (#5619 audit): Chromium plist generation must lint like the
// service side, and repeated install/start must not demand "restart first".
// ---------------------------------------------------------------------------

describe('resolveChromiumActivationPlan (T-038 rework 3)', () => {
  it('activates when not loaded', () => {
    expect(resolveChromiumActivationPlan({ loaded: false, restart: false, installedPlist: null, candidatePlist: '<plist/>' }))
      .toBe('activate');
    expect(resolveChromiumActivationPlan({ loaded: false, restart: true, installedPlist: '<plist/>', candidatePlist: '<plist/>' }))
      .toBe('activate');
  });

  it('repeated install/start with the current definition is an idempotent no-op', () => {
    expect(resolveChromiumActivationPlan({ loaded: true, restart: false, installedPlist: 'P', candidatePlist: 'P' }))
      .toBe('already-current');
  });

  it('a loaded service with a changed definition reloads (explicit equivalent of restart)', () => {
    expect(resolveChromiumActivationPlan({ loaded: true, restart: false, installedPlist: 'old', candidatePlist: 'new' }))
      .toBe('reload');
  });

  it('explicit restart always reloads, and a missing definition cannot prove a no-op', () => {
    expect(resolveChromiumActivationPlan({ loaded: true, restart: true, installedPlist: 'P', candidatePlist: 'P' }))
      .toBe('reload');
    expect(resolveChromiumActivationPlan({ loaded: true, restart: false, installedPlist: null, candidatePlist: 'P' }))
      .toBe('reload');
  });
});

describe('chromium-isolated generate lints the plist before the atomic rename (T-038 rework 3)', () => {
  function chromiumLintState(rejectPlist: boolean) {
    const stateDir = tmpDir('launchd-cr-lint-');
    const binDir = join(stateDir, 'bin');
    mkdirSync(binDir);
    const label = `com.disclaude.test.chromium-lint-${Date.now()}`;
    const configPath = join(stateDir, 'chromium-cdp.json');
    // Fake plutil: -lint is the only subcommand generate issues. PLATFORM_OVERRIDE
    // reroutes lintPlistFile onto it on Linux; its verdict decides the install.
    const plutil = join(binDir, 'plutil');
    writeFileSync(plutil, rejectPlist
      ? '#!/bin/sh\necho "plutil: test rejection" >&2\nexit 1\n'
      : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const chrome = join(binDir, 'chrome');
    writeFileSync(chrome, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    // Pre-existing definition + saved selection: the audit contract is that a
    // lint failure leaves BOTH untouched.
    const launchAgents = join(stateDir, 'LaunchAgents');
    mkdirSync(launchAgents, { recursive: true });
    const plistPath = join(launchAgents, `${label}.plist`);
    writeFileSync(plistPath, 'previous-chromium-plist\n');
    const previousConfig = JSON.stringify({
      version: 1,
      environment: { CHROMIUM_CDP_BINARY: chrome, CHROMIUM_CDP_PORT: '9333', CHROMIUM_CDP_ADDRESS: '127.0.0.1' },
    }, null, 2) + '\n';
    writeFileSync(configPath, previousConfig);
    return {
      stateDir, binDir, label, configPath, plistPath, previousConfig, chrome,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        HOME: join(stateDir, 'home'),
        PLATFORM_OVERRIDE: 'darwin',
        DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: label,
        DISCLAUDE_LAUNCHD_STATE_DIR: stateDir,
        DISCLAUDE_LAUNCHD_CONFIG_PATH: join(stateDir, 'service.yaml'),
        DISCLAUDE_CHROMIUM_CONFIG: configPath,
        CHROMIUM_CDP_BINARY: chrome,
        CHROMIUM_CDP_PROFILE_DIR: join(stateDir, 'profile'),
        CHROMIUM_CDP_PORT: '9333',
        CHROMIUM_CDP_ADDRESS: '127.0.0.1',
      },
    };
  }

  it('a rejected plutil -lint keeps the old plist and the old saved selection', () => {
    const state = chromiumLintState(true);
    try {
      const run = spawnSync(process.execPath, [LAUNCHD_SCRIPT, 'chromium-isolated', 'generate'], {
        cwd: ROOT, env: state.env, encoding: 'utf-8',
      });
      expect(run.status, run.stdout + run.stderr).toBe(1);
      expect(run.stderr).toContain('plutil -lint rejected');
      expect(readFileSync(state.plistPath, 'utf-8')).toBe('previous-chromium-plist\n');
      expect(readFileSync(state.configPath, 'utf-8')).toBe(state.previousConfig);
      assertNoTmpResidue(join(state.stateDir, 'LaunchAgents'));
    } finally {
      rmSync(state.stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('an accepted lint installs the new definition atomically and records the selection', () => {
    const state = chromiumLintState(false);
    try {
      const run = spawnSync(process.execPath, [LAUNCHD_SCRIPT, 'chromium-isolated', 'generate'], {
        cwd: ROOT, env: state.env, encoding: 'utf-8',
      });
      expect(run.status, run.stdout + run.stderr).toBe(0);
      expect(run.stdout).toContain('Plist generated atomically');
      expect(run.stdout).toContain('Validated: plutil -lint');
      const plist = readFileSync(state.plistPath, 'utf-8');
      expect(plist).not.toBe('previous-chromium-plist\n');
      expect(validatePlistStructure(plist)).toBeNull();
      expect(JSON.parse(readFileSync(state.configPath, 'utf-8')).environment.CHROMIUM_CDP_PORT).toBe('9333');
      assertNoTmpResidue(join(state.stateDir, 'LaunchAgents'));
    } finally {
      rmSync(state.stateDir, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// ④⑤ isolated end-to-end rehearsal: com.disclaude.test.* label + fake launchctl
// ---------------------------------------------------------------------------

describe('isolated service lifecycle with a fake launchctl (#5619 T-038)', () => {
  async function runIsolated(
    command: string,
    state: { stateDir: string; binDir: string; label: string; logPath: string; configPath: string }
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const child = spawn(process.execPath, [LAUNCHD_SCRIPT, 'isolated', command], {
      cwd: ROOT,
      env: {
        PATH: `${state.binDir}:${process.env.PATH ?? ''}`,
        HOME: join(state.stateDir, 'home'),
        DISCLAUDE_LAUNCHD_ISOLATED: '1',
        DISCLAUDE_LAUNCHD_LABEL: state.label,
        DISCLAUDE_LAUNCHD_STATE_DIR: state.stateDir,
        DISCLAUDE_LAUNCHD_CONFIG_PATH: state.configPath,
        FAKE_LAUNCHCTL_LOG: state.logPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const [code] = await once(child, 'close');
    return { code, stdout, stderr };
  }

  function isolatedState(): { stateDir: string; binDir: string; label: string; logPath: string; configPath: string } {
    const stateDir = tmpDir('launchd-t038-');
    const binDir = join(stateDir, 'bin');
    mkdirSync(binDir);
    const label = `com.disclaude.test.t038-${Date.now()}`;
    const logPath = join(stateDir, 'launchctl.log');
    const configPath = join(stateDir, 'config.yaml');
    writeFileSync(configPath, ['launchd:', '  entry: /opt/disclaude/bin/disclaude.js', '  apiPort: 8400', ''].join('\n'));
    // Fake launchctl: record its argv and always succeed, so the script's
    // command assembly — never a real launchd — is what gets exercised.
    const fake = join(binDir, 'launchctl');
    writeFileSync(fake, '#!/bin/sh\necho "$*" >> "$FAKE_LAUNCHCTL_LOG"\nexit 0\n');
    chmodSync(fake, 0o755);
    return { stateDir, binDir, label, logPath, configPath };
  }

  it('install writes an atomically validated plist and bootstraps the test label', async () => {
    const state = isolatedState();
    try {
      const { code, stdout, stderr } = await runIsolated('install', state);
      expect(stderr).toBe('');
      expect(code, stdout).toBe(0);
      const plistPath = join(state.stateDir, 'LaunchAgents', `${state.label}.plist`);
      expect(existsSync(plistPath)).toBe(true);
      expect(stdout).toContain('Plist generated atomically');
      expect(stdout).toContain('Validated:');
      // Temp+rename, not a partial write: no *.tmp next to the plist.
      assertNoTmpResidue(join(state.stateDir, 'LaunchAgents'));
      // The generated plist must itself pass the structural validator.
      expect(validatePlistStructure(readFileSync(plistPath, 'utf-8'))).toBeNull();
      // bootstrap against the gui domain, addressed by the isolated test label.
      const calls = readFileSync(state.logPath, 'utf-8').trim().split('\n');
      expect(calls.at(-1)).toBe(`bootstrap gui/${UID} ${plistPath}`);
    } finally {
      rmSync(state.stateDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('status inspects the service via launchctl print, then stop/uninstall boot it out', async () => {
    const state = isolatedState();
    try {
      const installed = await runIsolated('install', state);
      expect(installed.code, installed.stderr).toBe(0);

      const status = await runIsolated('status', state);
      expect(status.code, status.stderr).toBe(0);
      expect(readFileSync(state.logPath, 'utf-8')).toContain(`print gui/${UID}/${state.label}`);

      const stop = await runIsolated('stop', state);
      expect(stop.code, stop.stderr).toBe(0);
      expect(readFileSync(state.logPath, 'utf-8')).toContain(`bootout gui/${UID}/${state.label}`);
      // stop keeps the plist (uninstall removes it).
      expect(existsSync(join(state.stateDir, 'LaunchAgents', `${state.label}.plist`))).toBe(true);

      const uninstall = await runIsolated('uninstall', state);
      expect(uninstall.code, uninstall.stderr).toBe(0);
      expect(existsSync(join(state.stateDir, 'LaunchAgents', `${state.label}.plist`))).toBe(false);
      assertNoTmpResidue(join(state.stateDir, 'LaunchAgents'));
    } finally {
      rmSync(state.stateDir, { recursive: true, force: true });
    }
  }, 60_000);
});
