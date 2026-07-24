/**
 * Tests for pi.dev Agent Provider (skeleton) — Issue #4385 / PR #4390.
 *
 * Coverage focus:
 * - validateConfig() ESM-safe package probe (the PR #4390 fix): returns true
 *   when @earendil-works/pi-agent-core is resolvable, false (never throws)
 *   when not. The "resolvable → true" case is the regression guard — under
 *   the pre-fix bare `require.resolve` code (ReferenceError in ESM, swallowed
 *   by the try/catch) validateConfig() returned false unconditionally, so that
 *   test fails on the pre-fix implementation.
 * - getInfo() available/unavailable shaping.
 * - Lifecycle: dispose() flips disposed state, is idempotent, and forces
 *   validateConfig() to false.
 * - Stubbed query/tool/MCP methods throw the not-implemented error pointing at
 *   the follow-up issues (#4386 / #4387).
 *
 * The package-probe resolver is mocked so we can deterministically simulate
 * both "package installed" and "package absent". The companion file
 * provider.esm-probe.test.ts exercises the REAL createRequire() path un-mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PiAgentProvider } from './provider.js';
import type {
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  UserInput,
} from '../../types.js';

// --- Mock node:module so we can flip package resolvability per test ---------
// vi.mock is hoisted above imports, so the fns it closes over must be hoisted
// too (vi.hoisted). createRequire(import.meta.url) returns { resolve(spec) }.
const { mockCreateRequire, mockResolve } = vi.hoisted(() => ({
  mockCreateRequire: vi.fn((_url: string) => ({ resolve: mockResolve })),
  mockResolve: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: mockCreateRequire,
}));

// The exact not-implemented message the stubs must surface (embeds the
// follow-up issue pointers #4386 / #4387).
const NOT_IMPLEMENTED_MSG =
  'PiAgentProvider: this method is not implemented yet — agent loop tracked in #4386 (S3), tools/MCP in #4387 (S4).';

describe('PiAgentProvider (skeleton, Issue #4385)', () => {
  let provider: PiAgentProvider;

  beforeEach(() => {
    mockResolve.mockReset();
    mockCreateRequire.mockClear();
    // Default: simulate the real skeleton state — the pi package is NOT
    // installed, so the probe throws MODULE_NOT_FOUND and validateConfig()
    // returns false. Individual tests override to simulate "installed".
    mockResolve.mockImplementation(() => {
      throw Object.assign(
        new Error("Cannot find module '@earendil-works/pi-agent-core'"),
        { code: 'MODULE_NOT_FOUND' },
      );
    });
    provider = new PiAgentProvider();
  });

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  describe('properties', () => {
    it("exposes name 'pi'", () => {
      expect(provider.name).toBe('pi');
    });

    it("exposes the skeleton version '0.0.0-skeleton'", () => {
      expect(provider.version).toBe('0.0.0-skeleton');
    });
  });

  // --------------------------------------------------------------------------
  // validateConfig — the PR #4390 ESM-safe package probe
  // --------------------------------------------------------------------------

  describe('validateConfig (ESM-safe package probe, PR #4390)', () => {
    it('returns true when @earendil-works/pi-agent-core is resolvable', () => {
      // REGRESSION GUARD: under the pre-fix bare `require.resolve` code, this
      // returned false unconditionally (the ReferenceError from `require` being
      // undefined in ESM was swallowed by the try/catch). With createRequire()
      // the probe genuinely succeeds and returns true.
      mockResolve.mockReturnValue(
        '/fake/node_modules/@earendil-works/pi-agent-core/dist/index.js',
      );

      expect(provider.validateConfig()).toBe(true);
    });

    it('returns false when the package is absent (MODULE_NOT_FOUND swallowed)', () => {
      // Default mock throws MODULE_NOT_FOUND.
      expect(provider.validateConfig()).toBe(false);
    });

    it('never throws — swallows arbitrary resolver errors as false', () => {
      mockResolve.mockImplementation(() => {
        throw new Error('unexpected resolver boom');
      });

      // Contract (mirrors ClaudeSDKProvider): return false, never throw.
      expect(() => provider.validateConfig()).not.toThrow();
      expect(provider.validateConfig()).toBe(false);
    });

    it('routes the probe through createRequire() (not bare require)', () => {
      // Bare `require` is undefined in ESM; the fix routes through
      // createRequire(import.meta.url) instead. Reverting to bare require would
      // make this assertion fail because createRequire would never be invoked.
      provider.validateConfig();

      expect(mockCreateRequire).toHaveBeenCalledTimes(1);
      // The argument is the provider's import.meta.url (a file:// URL string).
      expect(mockCreateRequire).toHaveBeenCalledWith(expect.any(String));
    });

    it('probes exactly the @earendil-works/pi-agent-core specifier', () => {
      provider.validateConfig();

      expect(mockResolve).toHaveBeenCalledTimes(1);
      expect(mockResolve).toHaveBeenCalledWith('@earendil-works/pi-agent-core');
    });

    it('returns false after dispose() even when the package is resolvable', () => {
      mockResolve.mockReturnValue('/fake/path');
      expect(provider.validateConfig()).toBe(true);

      provider.dispose();

      // disposed short-circuits before the probe runs.
      mockResolve.mockClear();
      mockCreateRequire.mockClear();
      expect(provider.validateConfig()).toBe(false);
      expect(mockCreateRequire).not.toHaveBeenCalled();
      expect(mockResolve).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // getInfo
  // --------------------------------------------------------------------------

  describe('getInfo', () => {
    it('reports available when the package is resolvable', () => {
      mockResolve.mockReturnValue('/fake/path');

      const info = provider.getInfo();

      expect(info).toMatchObject({
        name: 'pi',
        version: '0.0.0-skeleton',
        available: true,
      });
      expect(info.unavailableReason).toBeUndefined();
    });

    it('reports unavailable with a reason when the package is absent', () => {
      const info = provider.getInfo();

      expect(info).toMatchObject({
        name: 'pi',
        version: '0.0.0-skeleton',
        available: false,
      });
      expect(info.unavailableReason).toBe(
        'pi-agent-core package not installed or not configured',
      );
    });

    it('reflects the disposed state as unavailable', () => {
      provider.dispose();

      const info = provider.getInfo();

      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe(
        'pi-agent-core package not installed or not configured',
      );
    });
  });

  // --------------------------------------------------------------------------
  // dispose
  // --------------------------------------------------------------------------

  describe('dispose', () => {
    it('is idempotent', () => {
      expect(() => {
        provider.dispose();
        provider.dispose();
      }).not.toThrow();
    });

    it('flips validateConfig() to false', () => {
      mockResolve.mockReturnValue('/fake/path');
      expect(provider.validateConfig()).toBe(true);

      provider.dispose();

      expect(provider.validateConfig()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Stubbed methods — must surface actionable not-implemented errors
  // --------------------------------------------------------------------------

  describe('stubbed methods (agent loop #4386 / tools+MCP #4387)', () => {
    it('queryStream throws not-implemented pointing at #4386 / #4387', () => {
      async function* input(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'hi' };
      }
      const options = { settingSources: ['user'] } as AgentQueryOptions;

      expect(() => provider.queryStream(input(), options)).toThrow(
        NOT_IMPLEMENTED_MSG,
      );
    });

    it('createInlineTool throws not-implemented pointing at #4386 / #4387', () => {
      expect(() =>
        provider.createInlineTool({} as InlineToolDefinition),
      ).toThrow(NOT_IMPLEMENTED_MSG);
    });

    it('createMcpServer throws not-implemented pointing at #4386 / #4387', () => {
      expect(() => provider.createMcpServer({} as McpServerConfig)).toThrow(
        NOT_IMPLEMENTED_MSG,
      );
    });
  });
});
