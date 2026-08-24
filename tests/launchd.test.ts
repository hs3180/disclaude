// Regression guard for the launchd plist's REST API wiring (Issue #4576).
//
// Since #4280 Phase 3 the MCP tools' only transport is the PrimaryNode HTTP
// API server (`--api-port`); the generated launchd plist used to pass bare
// `start`, so nothing listened on 9200 and every channel-mcp send tool
// (send_card / send_text / send_file / send_interactive) failed with
// 「IPC 服务不可用」in launchd production deployments. The fix makes
// `buildProgramArguments` append `--api-port <port>` (default 9200, override
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
// Pure helpers exported from launchd.mjs; .mjs has no type declarations and
// scripts/ is not type-checked.
// @ts-expect-error — .mjs module without type declarations
import { buildProgramArguments, resolveApiPort, resolveRestIpcBaseUrl, xmlEscape } from '../scripts/launchd.mjs';

const NODE = '/usr/local/bin/node';
const CAFFEINATE = '/usr/bin/caffeinate';

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['DISCLAUDE_LAUNCHD_API_PORT', 'DISCLAUDE_LAUNCHD_API_TOKEN', 'DISCLAUDE_REST_IPC_BASE_URL'] as const;

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
  it('defaults to 9200 when no env override is set', () => {
    snapshotEnv();
    expect(resolveApiPort()).toBe(9200);
  });

  it('accepts a valid override in 1-65535', () => {
    snapshotEnv();
    process.env.DISCLAUDE_LAUNCHD_API_PORT = '9300';
    expect(resolveApiPort()).toBe(9300);
  });

  it('rejects out-of-range values and falls back to the default', () => {
    snapshotEnv();
    for (const bad of ['0', '99999', '-1']) {
      process.env.DISCLAUDE_LAUNCHD_API_PORT = bad;
      expect(resolveApiPort()).toBe(9200);
    }
  });

  it('rejects non-numeric values and falls back to the default', () => {
    snapshotEnv();
    // NB: parseInt('92 00') === 92 — same parseInt-prefix semantics as the
    // CLI parser (packages/primary-node/src/cli.ts); only NaN cases here.
    for (const bad of ['abc', '']) {
      process.env.DISCLAUDE_LAUNCHD_API_PORT = bad;
      expect(resolveApiPort()).toBe(9200);
    }
  });
});

describe('buildProgramArguments REST API wiring (#4576)', () => {
  it('appends --api-port 9200 by default (REST-only MCP tools need it)', () => {
    snapshotEnv();
    const args = buildProgramArguments(NODE, null);
    // Without caffeinate: [node, cli, 'start', '--api-port', '9200']
    expect(args).toEqual([NODE, expect.any(String), 'start', '--api-port', '9200']);
  });

  it('keeps the caffeinate wrapper and still appends --api-port', () => {
    snapshotEnv();
    const args = buildProgramArguments(NODE, CAFFEINATE);
    expect(args.slice(0, 2)).toEqual([CAFFEINATE, '-s']);
    expect(args.slice(-3)).toEqual(['start', '--api-port', '9200']);
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
    // args = [node, cli, 'start', '--api-port', '9200', '--api-token', token]
    expect(args.slice(-4)).toEqual(['--api-port', '9200', '--api-token', 'secret-token']);
  });
});

describe('resolveRestIpcBaseUrl (port-override propagation, #4578 review nit 1)', () => {
  it('stays null at the default port — plist gains no env entry', () => {
    snapshotEnv();
    expect(resolveRestIpcBaseUrl(9200)).toBeNull();
  });

  it('mirrors a non-default port so MCP tools probe the override', () => {
    snapshotEnv();
    expect(resolveRestIpcBaseUrl(9300)).toBe('http://localhost:9300');
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
    expect(xmlEscape('9200')).toBe('9200');
    expect(xmlEscape('http://localhost:9200')).toBe('http://localhost:9200');
  });

  it('renders a token with markup chars into parseable plist content', () => {
    // The exact hazard: --api-token is the first free-text value interpolated
    // into the plist XML; without escaping this yields an unparseable plist.
    expect(xmlEscape('tok&en<x>')).toBe('tok&amp;en&lt;x&gt;');
  });
});
