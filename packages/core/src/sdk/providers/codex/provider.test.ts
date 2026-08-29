/**
 * Tests for Codex CLI Agent Provider (skeleton) — Issue #4629 / S1 of #4627.
 *
 * Coverage focus:
 * - validateConfig() fail-fast environment checks: binary-on-PATH scan and
 *   OAuth auth.json presence (CODEX_HOME-aware). Both probes are exercised
 *   against REAL temp fixtures (fake `codex` executable + auth.json) via the
 *   injected env — no fs mocking, no real codex CLI needed.
 * - getInfo() surfaces actionable unavailableReason (install + login hints).
 * - queryStream stub throws the not-implemented error pointing at #4630.
 * - createInlineTool / createMcpServer throw not-supported (#4627 open q).
 * - Lifecycle: dispose() flips state, is idempotent, forces checks false.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexAgentProvider } from './provider.js';

/** Temp fixtures: a bin dir with a fake executable `codex`, and a CODEX_HOME. */
interface Fixtures {
  binDir: string;
  codexHome: string;
  cleanup: () => void;
}

/**
 * Real-fs fixtures: the fake `codex` is a chmod-ed shell script so the X_OK
 * probe genuinely succeeds — testing the actual accessSync mechanism.
 */
function makeFixtures(opts: { withBinary: boolean; withAuth: boolean }): Fixtures {
  const root = mkdtempSync(join(tmpdir(), 'codex-provider-test-'));
  const binDir = join(root, 'bin');
  const codexHome = join(root, 'codex-home');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });

  if (opts.withBinary) {
    const bin = join(binDir, 'codex');
    writeFileSync(bin, '#!/bin/sh\necho codex 0.0.0\n', { mode: 0o755 });
    chmodSync(bin, 0o755);
  }
  if (opts.withAuth) {
    writeFileSync(join(codexHome, 'auth.json'), '{"tokens":{"access_token":"x"}}');
  }

  return {
    binDir,
    codexHome,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const NOT_IMPLEMENTED_MSG =
  'CodexAgentProvider: this method is not implemented yet — codex exec bridge tracked in #4630 (S2 of #4627).';
const NOT_SUPPORTED_MSG =
  'CodexAgentProvider: tools/MCP mapping is not supported yet — tracked as an open question on #4627.';

describe('CodexAgentProvider (skeleton, Issue #4629)', () => {
  let fixtures: Fixtures;

  afterEach(() => {
    fixtures?.cleanup();
  });

  const makeProvider = (fx: Fixtures) =>
    new CodexAgentProvider({ env: { PATH: fx.binDir, CODEX_HOME: fx.codexHome } });

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  it("exposes name 'codex' and the skeleton version", () => {
    fixtures = makeFixtures({ withBinary: false, withAuth: false });
    const provider = makeProvider(fixtures);
    expect(provider.name).toBe('codex');
    expect(provider.version).toBe('0.0.0-skeleton');
  });

  // --------------------------------------------------------------------------
  // validateConfig — S1 fail-fast environment checks
  // --------------------------------------------------------------------------

  describe('validateConfig (binary + auth probes)', () => {
    it('returns true when the binary is on PATH and auth.json exists', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      expect(makeProvider(fixtures).validateConfig()).toBe(true);
    });

    it('returns false when the codex binary is missing from PATH', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: true });
      expect(makeProvider(fixtures).validateConfig()).toBe(false);
    });

    it('returns false when a same-named file exists but is NOT executable', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: true });
      // X_OK probe must reject non-executable files, not just absent ones.
      const bin = join(fixtures.binDir, 'codex');
      writeFileSync(bin, 'not executable', { mode: 0o644 });
      expect(makeProvider(fixtures).validateConfig()).toBe(false);
    });

    it('returns false when auth.json is absent (OAuth not completed)', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      expect(makeProvider(fixtures).validateConfig()).toBe(false);
    });

    it('returns false (never throws) with an empty PATH', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      expect(
        new CodexAgentProvider({ env: { PATH: '', CODEX_HOME: fixtures.codexHome } }).validateConfig(),
      ).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getInfo — actionable unavailableReason
  // --------------------------------------------------------------------------

  describe('getInfo (actionable messages)', () => {
    it('is available with no reason when binary + auth are present', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const info = makeProvider(fixtures).getInfo();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('reports BOTH the install hint and the login hint when nothing is set up', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      const info = makeProvider(fixtures).getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/npm install -g @openai\/codex/);
      expect(info.unavailableReason).toMatch(/codex login/);
    });

    it('reports only the login hint when the binary exists but auth is missing', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: false });
      const info = makeProvider(fixtures).getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/codex login/);
      expect(info.unavailableReason).not.toMatch(/npm install/);
    });
  });

  // --------------------------------------------------------------------------
  // Stubs — S2 (#4630) and the #4627 tools/MCP open question
  // --------------------------------------------------------------------------

  describe('stubs', () => {
    it('queryStream throws the not-implemented error pointing at #4630', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      expect(() => provider.queryStream(undefined as never, undefined as never)).toThrow(
        NOT_IMPLEMENTED_MSG,
      );
    });

    it('createInlineTool throws not-supported pointing at #4627', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      expect(() =>
        makeProvider(fixtures).createInlineTool({} as never),
      ).toThrow(NOT_SUPPORTED_MSG);
    });

    it('createMcpServer throws not-supported pointing at #4627', () => {
      fixtures = makeFixtures({ withBinary: false, withAuth: false });
      expect(() =>
        makeProvider(fixtures).createMcpServer({} as never),
      ).toThrow(NOT_SUPPORTED_MSG);
    });
  });

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  describe('lifecycle', () => {
    it('dispose() forces validateConfig() false and getInfo() unavailable', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      provider.dispose();
      expect(provider.validateConfig()).toBe(false);
      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toMatch(/disposed/i);
    });

    it('dispose() is idempotent', () => {
      fixtures = makeFixtures({ withBinary: true, withAuth: true });
      const provider = makeProvider(fixtures);
      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();
    });
  });
});
