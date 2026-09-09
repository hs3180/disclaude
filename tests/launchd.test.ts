// Regression guard for the launchd plist's REST API wiring (Issue #4576).
//
// Since #4280 Phase 3 the MCP tools' only transport is the PrimaryNode HTTP
// API server (`--api-port`); the generated launchd plist used to pass bare
// `start`, so nothing listened on 19200 and every channel-mcp send tool
// (send_card / send_text / send_file / send_interactive) failed with
// 「IPC 服务不可用」in launchd production deployments. The fix makes
// `buildProgramArguments` append `--api-port <port>` (default 19200, override
// via DISCLAUDE_LAUNCHD_API_PORT) and `--api-token` when
// DISCLAUDE_LAUNCHD_API_TOKEN is set.
//
// This file pins that contract. A future edit that drops the flags — or
// changes the port resolution bounds (must mirror the CLI parser in
// packages/primary-node/src/cli.ts) — fails CI loudly.
//
// Scope notes (why adding this file is safe — mirrors the precedent set by
// skills/issue-solver/scan.test.ts / #4376):
//  - `npm run lint` only targets packages/*/src, so this file is NOT linted.
//  - root tsconfig has an empty `files` list + package references only, so
//    scripts/ is NOT type-checked; importing a .mjs without type decls is fine.
//  - vitest.config.ts `include` covers `packages/**/*.test.ts` and
//    `skills/**/*.test.ts` — scripts/ is NOT covered, so this file lives
//    under tests/ (which IS covered) and imports the script by path.
//  - coverage `include` covers only src/ and packages/ ts files, so this
//    test is NOT measured and cannot drag the 70% coverage thresholds.
//  - launchd.mjs is ESM with an isMainEntry guard (added with this change,
//    same pattern as scan.mjs), so importing it here does NOT dispatch any
//    command (no launchctl, no writes to ~/Library/LaunchAgents).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Pure helpers exported from launchd.mjs; .mjs has no type declarations and
// scripts/ is not type-checked.
// @ts-expect-error — .mjs module without type declarations
import {
  buildChromiumArguments,
  buildProgramArguments,
  resolveChromiumAddress,
  resolveChromiumBinary,
  resolveChromiumHeadless,
  resolveChromiumPort,
  resolveChromiumProfileDir,
  resolveApiPort,
  resolveAppLog,
  resolveRestIpcBaseUrl,
  xmlEscape,
} from '../scripts/launchd.mjs';

const NODE = '/usr/local/bin/node';
const CAFFEINATE = '/usr/bin/caffeinate';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  'DISCLAUDE_LAUNCHD_API_PORT',
  'DISCLAUDE_LAUNCHD_API_TOKEN',
  'DISCLAUDE_REST_IPC_BASE_URL',
  'CHROMIUM_CDP_PORT',
  'CHROMIUM_CDP_ADDRESS',
  'CHROMIUM_CDP_PROFILE_DIR',
  'CHROMIUM_CDP_HEADED',
  'CHROMIUM_CDP_BINARY',
] as const;

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (key in savedEnv) {
      process.env[key] = savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
});

function snapshotEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

describe('resolveApiPort (#4576)', () => {
  it('defaults to an OS-assigned port when no env override is set', () => {
    snapshotEnv();
    expect(resolveApiPort()).toBe(0);
  });

  it('accepts a valid override in 1-65535', () => {
    snapshotEnv();
    process.env.DISCLAUDE_LAUNCHD_API_PORT = '9300';
    expect(resolveApiPort()).toBe(9300);
  });

  it('rejects out-of-range values and falls back to the default', () => {
    snapshotEnv();
    for (const bad of ['99999', '-1']) {
      process.env.DISCLAUDE_LAUNCHD_API_PORT = bad;
      expect(resolveApiPort()).toBe(0);
    }
  });

  it('rejects non-numeric values and falls back to the default', () => {
    snapshotEnv();
    // NB: parseInt('92 00') === 92 — same parseInt-prefix semantics as the
    // CLI parser (packages/primary-node/src/cli.ts); only NaN cases here.
    for (const bad of ['abc', '']) {
      process.env.DISCLAUDE_LAUNCHD_API_PORT = bad;
      expect(resolveApiPort()).toBe(0);
    }
  });
});

describe('buildProgramArguments REST API wiring (#4576)', () => {
  it('appends --api-port 0 by default for isolated managed instances', () => {
    snapshotEnv();
    const args = buildProgramArguments(NODE, null);
    // Without caffeinate: [node, cli, 'start', '--api-port', '19200']
    expect(args).toEqual([NODE, expect.any(String), 'start', '--api-port', '0']);
  });

  it('keeps the caffeinate wrapper and still appends --api-port', () => {
    snapshotEnv();
    const args = buildProgramArguments(NODE, CAFFEINATE);
    expect(args.slice(0, 2)).toEqual([CAFFEINATE, '-s']);
    expect(args.slice(-3)).toEqual(['start', '--api-port', '0']);
  });

  it('honours DISCLAUDE_LAUNCHD_API_PORT in the generated args', () => {
    snapshotEnv();
    process.env.DISCLAUDE_LAUNCHD_API_PORT = '9300';
    const args = buildProgramArguments(NODE, null);
    expect(args.slice(-2)).toEqual(['--api-port', '9300']);
  });

  it('appends --api-token only when DISCLAUDE_LAUNCHD_API_TOKEN is set', () => {
    snapshotEnv();
    expect(buildProgramArguments(NODE, null)).not.toContain('--api-token');

    process.env.DISCLAUDE_LAUNCHD_API_TOKEN = 'secret-token';
    const args = buildProgramArguments(NODE, null);
    // args = [node, cli, 'start', '--api-port', '19200', '--api-token', token]
    expect(args.slice(-4)).toEqual(['--api-port', '0', '--api-token', 'secret-token']);
  });
});

describe('resolveRestIpcBaseUrl (port-override propagation, #4578 review nit 1)', () => {
  it('does not publish an unusable port-zero URL in the plist', () => {
    snapshotEnv();
    expect(resolveRestIpcBaseUrl(0)).toBeNull();
  });

  it('mirrors a non-default port so MCP tools probe the override', () => {
    snapshotEnv();
    expect(resolveRestIpcBaseUrl(9300)).toBe('http://127.0.0.1:9300');
  });

  it('never clobbers an explicit DISCLAUDE_REST_IPC_BASE_URL', () => {
    snapshotEnv();
    process.env.DISCLAUDE_REST_IPC_BASE_URL = 'http://elsewhere:9999';
    expect(resolveRestIpcBaseUrl(9300)).toBeNull();
  });
});

describe('xmlEscape (plist safety, #4578 review nit 2)', () => {
  it('escapes XML-significant characters', () => {
    expect(xmlEscape('a&b<c>d')).toBe('a&amp;b&lt;c&gt;d');
  });

  it('passes safe values (paths, numbers, URLs) through unchanged', () => {
    expect(xmlEscape('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(xmlEscape('19200')).toBe('19200');
    expect(xmlEscape('http://localhost:19200')).toBe('http://localhost:19200');
  });

  it('renders a token with markup chars into parseable plist content', () => {
    // The exact hazard: --api-token is the first free-text value interpolated
    // into the plist XML; without escaping this yields an unparseable plist.
    expect(xmlEscape('tok&en<x>')).toBe('tok&amp;en&lt;x&gt;');
  });
});

describe('resolveAppLog (log path under rotation, #4777 / #4814)', () => {
  // `logs` and `status` tail a fixed path. With LOG_ROTATE=true pino-roll
  // never writes the bare disclaude-combined.log — it writes numbered files
  // and points a `current.log` symlink at the live one. Without the fallback
  // both commands tail a nonexistent file and print nothing, which reads as
  // "the service logged nothing" rather than "you are looking at the wrong
  // path". filebeat.yml is the other consumer of this contract; see the
  // rotation tests in packages/core/src/utils/logger.test.ts.
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  function tmpLogDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'launchd-applog-'));
    dirs.push(d);
    return d;
  }

  it('prefers the bare path when it exists (non-rotating mode)', () => {
    const dir = tmpLogDir();
    writeFileSync(join(dir, 'disclaude-combined.log'), 'bare\n');
    expect(resolveAppLog(dir)).toBe(join(dir, 'disclaude-combined.log'));
  });

  it('falls back to current.log when only rotated files exist', () => {
    const dir = tmpLogDir();
    writeFileSync(join(dir, 'disclaude-combined.1.log'), 'rotated\n');
    symlinkSync('disclaude-combined.1.log', join(dir, 'current.log'));

    // Without the fallback this returned the bare path, which is absent.
    expect(resolveAppLog(dir)).toBe(join(dir, 'current.log'));
    expect(readFileSync(resolveAppLog(dir), 'utf8')).toBe('rotated\n');
  });

  it('prefers the bare path over current.log when both exist', () => {
    const dir = tmpLogDir();
    writeFileSync(join(dir, 'disclaude-combined.log'), 'bare\n');
    writeFileSync(join(dir, 'disclaude-combined.1.log'), 'rotated\n');
    symlinkSync('disclaude-combined.1.log', join(dir, 'current.log'));
    expect(resolveAppLog(dir)).toBe(join(dir, 'disclaude-combined.log'));
  });

  it('returns the bare path when neither exists, so tail reports that name', () => {
    const dir = tmpLogDir();
    expect(resolveAppLog(dir)).toBe(join(dir, 'disclaude-combined.log'));
  });
});

describe('chromium-cdp service config (Issue #4807)', () => {
  it('resolveChromiumPort defaults to 9222', () => {
    snapshotEnv();
    expect(resolveChromiumPort()).toBe(9222);
  });

  it('resolveChromiumPort honours a valid CHROMIUM_CDP_PORT', () => {
    snapshotEnv();
    process.env.CHROMIUM_CDP_PORT = '9333';
    expect(resolveChromiumPort()).toBe(9333);
  });

  it('resolveChromiumPort rejects out-of-range values (falls back)', () => {
    snapshotEnv();
    for (const bad of ['0', '65536', 'abc']) {
      process.env.CHROMIUM_CDP_PORT = bad;
      expect(resolveChromiumPort()).toBe(9222);
    }
  });

  it('resolveChromiumAddress defaults to IPv4 127.0.0.1 (drift fix)', () => {
    snapshotEnv();
    expect(resolveChromiumAddress()).toBe('127.0.0.1');
  });

  it('resolveChromiumAddress honours CHROMIUM_CDP_ADDRESS', () => {
    snapshotEnv();
    process.env.CHROMIUM_CDP_ADDRESS = '0.0.0.0';
    expect(resolveChromiumAddress()).toBe('0.0.0.0');
  });

  it('resolveChromiumProfileDir defaults to a persistent path', () => {
    snapshotEnv();
    expect(resolveChromiumProfileDir()).toContain(
      'Library/Application Support/disclaude/chromium-cdp'
    );
    expect(resolveChromiumProfileDir()).not.toContain('/tmp');
  });

  it('resolveChromiumProfileDir honours CHROMIUM_CDP_PROFILE_DIR (.env source)', () => {
    snapshotEnv();
    process.env.CHROMIUM_CDP_PROFILE_DIR = '/custom/profile';
    expect(resolveChromiumProfileDir()).toBe('/custom/profile');
  });

  it('resolveChromiumHeadless defaults to headless (true)', () => {
    snapshotEnv();
    expect(resolveChromiumHeadless()).toBe(true);
  });

  it('resolveChromiumHeadless is false when CHROMIUM_CDP_HEADED=1', () => {
    snapshotEnv();
    process.env.CHROMIUM_CDP_HEADED = '1';
    expect(resolveChromiumHeadless()).toBe(false);
  });

  it('resolveChromiumBinary returns CHROMIUM_CDP_BINARY when it exists', () => {
    snapshotEnv();
    const dir = mkdtempSync(join(tmpdir(), 'launchd-chromium-'));
    const bin = join(dir, 'chrome');
    writeFileSync(bin, '#!/bin/sh\n');
    process.env.CHROMIUM_CDP_BINARY = bin;
    expect(resolveChromiumBinary()).toBe(bin);
  });

  it('buildChromiumArguments uses persistent profile + stable IPv4 endpoint', () => {
    snapshotEnv();
    const args = buildChromiumArguments();
    expect(args).toContain('--remote-debugging-port=9222');
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(
      args.some((a) => a.startsWith('--user-data-dir=') && a.includes('disclaude/chromium-cdp'))
    ).toBe(true);
    expect(args).toContain('--headless=new');
  });

  it('buildChromiumArguments honours port/profile overrides and headed mode', () => {
    snapshotEnv();
    process.env.CHROMIUM_CDP_PORT = '9444';
    process.env.CHROMIUM_CDP_PROFILE_DIR = '/x/profile';
    process.env.CHROMIUM_CDP_HEADED = '1';
    const args = buildChromiumArguments();
    expect(args).toContain('--remote-debugging-port=9444');
    expect(args).toContain('--user-data-dir=/x/profile');
    // headed mode must NOT pass --headless=new
    expect(args).not.toContain('--headless=new');
  });
});
