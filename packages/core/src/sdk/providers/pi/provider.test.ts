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
 * - queryStream (implemented in #4386 part 3) throws the no-streamFn guard
 *   error when no stream function is injected (full behavior in
 *   provider.querystream.test.ts).
 * - createInlineTool (#4387) is implemented; createMcpServer inline path
 *   (#4417 part 1) is implemented and stdio throws "not supported".
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
  // Query — implemented in #4386 part 3; the streaming behavior itself is
  // covered in provider.querystream.test.ts (mocked pi-agent-core module).
  // Here: the configuration guard visible from the skeleton suite.
  // --------------------------------------------------------------------------

  describe('queryStream guards (agent loop #4386 part 3)', () => {
    it('queryStream without a streamFn throws pointing at the wiring slice', () => {
      async function* input(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'hi' };
      }
      const options = { settingSources: ['user'] } as AgentQueryOptions;

      expect(() => provider.queryStream(input(), options)).toThrow(
        /no stream function configured/,
      );
    });

    // Issue #4387 (part 1): createInlineTool is now implemented — it adapts a
    // disclaude InlineToolDefinition into a pi AgentHarnessTool shape (execute
    // wrapper + Zod validation; schema translation deferred to part 2).
    it('createInlineTool returns a pi tool shape (name + label + execute) instead of throwing', () => {
      const tool = provider.createInlineTool({
        name: 'echo',
        description: 'echoes the input',
        parameters: { parse: (p: unknown) => p } as never, // minimal Zod-like stub
        handler: (p: unknown) => Promise.resolve(p),
      } as InlineToolDefinition) as { name: string; label: string; execute: Function };

      expect(tool.name).toBe('echo');
      expect(tool.label).toBe('echo');
      expect(typeof tool.execute).toBe('function');
    });

    // Issue #4417 (part 1): createMcpServer inline path is now implemented —
    // it wraps disclaude tools via createInlineTool into a handle the pi
    // queryStream path (#4386) will inject via setTools. stdio throws (decision
    // recorded), matching ClaudeSDKProvider. External stdio servers (S4b) and
    // live injection (#4386) are deferred to later parts.
    describe('createMcpServer (#4417 part 1)', () => {
      const makeTool = (name: string) =>
        ({
          name,
          description: `${name} tool`,
          parameters: { parse: (p: unknown) => p } as never, // minimal Zod-like stub
          handler: (p: unknown) => Promise.resolve(p),
        } as InlineToolDefinition);

      it('builds an inline handle mapping tools via createInlineTool', () => {
        const result = provider.createMcpServer({
          type: 'inline',
          name: 'test-server',
          version: '1.0.0',
          tools: [makeTool('tool1'), makeTool('tool2')],
        }) as {
          name: string;
          version: string;
          tools: { name: string; label: string; execute: Function }[];
        };

        expect(result.name).toBe('test-server');
        expect(result.version).toBe('1.0.0');
        expect(result.tools).toHaveLength(2);
        expect(result.tools.map((t) => t.name)).toEqual(['tool1', 'tool2']);
        // each wrapped tool is a pi AgentHarnessTool shape
        for (const t of result.tools) {
          expect(t.label).toBeDefined();
          expect(typeof t.execute).toBe('function');
        }
      });

      it('builds an inline handle with no tools (empty array)', () => {
        const result = provider.createMcpServer({
          type: 'inline',
          name: 'empty-server',
          version: '1.0.0',
        }) as { name: string; version: string; tools: unknown[] };

        expect(result.name).toBe('empty-server');
        expect(result.version).toBe('1.0.0');
        expect(result.tools).toEqual([]);
      });

      it('throws for stdio config (decision recorded, matches ClaudeSDKProvider)', () => {
        expect(() =>
          provider.createMcpServer({
            type: 'stdio',
            name: 'stdio-server',
            command: 'npx',
            args: ['-y', 'some-mcp-server'],
          }),
        ).toThrow(
          'stdio MCP servers are not supported by PiAgentProvider.createMcpServer',
        );
      });
    });
  });
});
