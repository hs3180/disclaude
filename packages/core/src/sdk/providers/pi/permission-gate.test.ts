/**
 * Tests for the pi permission gate — Issue #4389 (S6, part 1).
 *
 * The correctness criterion from the issue's acceptance: "a tool call that
 * should be denied **is** denied" — the disallowed call must NOT reach the
 * tool handler. These tests cover the gate primitives (denylist, composition,
 * allow-all default) and the enforcement seam in `adaptInlineTool` /
 `PiAgentProvider` wiring, all without pi-agent-core installed (pure modules).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import type { InlineToolDefinition } from '../../types.js';
import { adaptInlineTool } from './inline-tool-adapter.js';
import {
  ALLOW_ALL_GATE,
  composeGates,
  createDenylistGate,
  type PiPermissionGate,
} from './permission-gate.js';
import { PiAgentProvider } from './provider.js';

/** Minimal well-formed InlineToolDefinition (mirrors inline-tool-adapter.test.ts). */
function makeTool(handler?: InlineToolDefinition['handler']): InlineToolDefinition {
  return {
    name: 'search',
    description: 'Search the web',
    parameters: z.object({ q: z.string() }),
    handler: handler ?? (({ q }: { q: string }) => Promise.resolve(`results for ${q}`)),
  } as unknown as InlineToolDefinition;
}

// ---------------------------------------------------------------------------
// Gate primitives
// ---------------------------------------------------------------------------

describe('createDenylistGate (Issue #4389)', () => {
  it('allows a tool not on the denylist', () => {
    const gate = createDenylistGate(['dangerous_tool']);
    expect(gate.decide({ toolName: 'search', args: { q: 'pi.dev' } })).toEqual({
      allowed: true,
    });
  });

  it('denies a tool on the denylist, with a reason naming the tool', () => {
    const gate = createDenylistGate(['dangerous_tool']);
    const decision = gate.decide({ toolName: 'dangerous_tool', args: {} });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('dangerous_tool');
      expect(decision.reason).toContain('disallowedTools');
    }
  });

  it('matches exactly — a denylisted name is not a prefix/substring match', () => {
    const gate = createDenylistGate(['search']);
    // "search_web" contains "search" but must be allowed (exact-match, same
    // semantics as the options-adapter's `new Set(disallowed)` subtraction).
    expect(gate.decide({ toolName: 'search_web', args: {} })).toEqual({ allowed: true });
  });

  it('empty denylist allows everything', () => {
    const gate = createDenylistGate([]);
    expect(gate.decide({ toolName: 'anything', args: {} })).toEqual({ allowed: true });
  });

  it('exposes the raw args to the decision (arg-level policies can inspect them)', () => {
    // The request carries the raw args — a future arg-level gate (C1/C2/C3)
    // relies on this field being present and unvalidated.
    const seen: unknown[] = [];
    const spyGate: PiPermissionGate = {
      decide: (request) => {
        seen.push(request.args);
        return { allowed: true };
      },
    };
    spyGate.decide({ toolName: 'bash', args: { command: 'rm -rf /tmp/x' } });
    expect(seen).toEqual([{ command: 'rm -rf /tmp/x' }]);
  });
});

describe('composeGates (Issue #4389)', () => {
  it('allows only when every gate allows', () => {
    const gate = composeGates(
      createDenylistGate(['a']),
      createDenylistGate(['b']),
    );
    expect(gate.decide({ toolName: 'c', args: {} })).toEqual({ allowed: true });
  });

  it('first deny wins and its reason is preserved', () => {
    const gate = composeGates(
      createDenylistGate(['a']),
      createDenylistGate(['b']),
    );
    const decision = gate.decide({ toolName: 'a', args: {} });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.reason).toContain('"a"');
    }
  });

  it('later gates are not consulted after a deny', () => {
    const later = vi.fn(() => ({ allowed: true }) as const);
    const gate = composeGates(createDenylistGate(['a']), {
      decide: later,
    } as unknown as PiPermissionGate);
    gate.decide({ toolName: 'a', args: {} });
    expect(later).not.toHaveBeenCalled();
  });
});

describe('ALLOW_ALL_GATE (Issue #4389)', () => {
  it('allows everything (pre-#4389 default behavior preserved)', () => {
    expect(ALLOW_ALL_GATE.decide({ toolName: 'anything', args: {} })).toEqual({
      allowed: true,
    });
  });
});

// ---------------------------------------------------------------------------
// Enforcement seam — adaptInlineTool routes execute through the gate
// ---------------------------------------------------------------------------

describe('adaptInlineTool permission enforcement (Issue #4389)', () => {
  it('DENY: a disallowed tool call does NOT execute the handler', async () => {
    // The acceptance criterion: "a tool call that should be denied is denied"
    // — the handler must never run.
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = adaptInlineTool(makeTool(handler), createDenylistGate(['search']));
    await expect(
      tool.execute('call_1', { q: 'pi.dev' }, undefined, undefined, undefined)
    ).rejects.toThrow(/permission denied.*search/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('ALLOW: an allowed tool call runs the handler normally', async () => {
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`results for ${q}`));
    const tool = adaptInlineTool(makeTool(handler), createDenylistGate(['other_tool']));
    const res = await tool.execute('call_1', { q: 'pi.dev' }, undefined, undefined, undefined);
    expect(handler).toHaveBeenCalledWith({ q: 'pi.dev' });
    expect(res.content).toEqual([{ type: 'text', text: 'results for pi.dev' }]);
  });

  it('defaults to allow-all when no gate is passed (back-compat)', async () => {
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`ok ${q}`));
    const tool = adaptInlineTool(makeTool(handler));
    const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);
    expect(res.details).toBe('ok x');
  });

  it('deny fires before Zod validation (gate is the first check after abort)', async () => {
    // Even invalid params on a denied tool surface the permission error, not
    // a validation error — the decision is about the TOOL, not the args.
    const handler = vi.fn(() => Promise.resolve('never'));
    const tool = adaptInlineTool(makeTool(handler), createDenylistGate(['search']));
    await expect(
      tool.execute('call_1', { wrong: 1 }, undefined, undefined, undefined)
    ).rejects.toThrow(/permission denied/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('deny still honors an already-aborted signal first (abort wins)', async () => {
    const handler = vi.fn(() => Promise.resolve('never'));
    const tool = adaptInlineTool(makeTool(handler), createDenylistGate(['search']));
    const controller = new AbortController();
    controller.abort();
    await expect(
      tool.execute('call_1', { q: 'x' }, controller.signal, undefined, undefined)
    ).rejects.toThrow(/aborted/i);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Provider wiring — queryStream installs the per-query denylist gate
// ---------------------------------------------------------------------------

describe('PiAgentProvider permissionGate wiring (Issue #4389)', () => {
  let provider: PiAgentProvider;

  beforeEach(() => {
    provider = new PiAgentProvider();
  });

  it('defaults to allow-all (unadapted behavior unchanged)', async () => {
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`ok ${q}`));
    const tool = provider.createInlineTool(makeTool(handler)) as ReturnType<
      typeof adaptInlineTool
    >;
    const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);
    expect(res.details).toBe('ok x');
  });

  it('createInlineTool rides the provider-level gate once installed', async () => {
    provider.permissionGate = createDenylistGate(['search']);
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = provider.createInlineTool(makeTool(handler)) as ReturnType<
      typeof adaptInlineTool
    >;
    await expect(
      tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined)
    ).rejects.toThrow(/permission denied.*search/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('queryStream installs a denylist gate from options.disallowedTools', () => {
    provider.streamFn = () => undefined;
    provider.queryStream(
      (async function* () {
        /* never consumed — queryStream returns synchronously */
      })(),
      {
        settingSources: [],
        disallowedTools: ['bash', 'web_search'],
      },
    );
    // The provider-level gate now denies exactly those tools...
    const deny = provider.permissionGate.decide({ toolName: 'bash', args: {} });
    expect(deny.allowed).toBe(false);
    // ...and allows others.
    expect(
      provider.permissionGate.decide({ toolName: 'search', args: {} }),
    ).toEqual({ allowed: true });
  });

  it('queryStream resets to allow-all when disallowedTools is absent/empty', () => {
    provider.streamFn = () => undefined;
    provider.permissionGate = createDenylistGate(['stale_tool']);
    provider.queryStream((async function* () {})(), {
      settingSources: [],
      disallowedTools: [],
    });
    expect(
      provider.permissionGate.decide({ toolName: 'stale_tool', args: {} }),
    ).toEqual({ allowed: true });
  });

  // The PRODUCTION ordering is adapt-BEFORE-install: channelSdkTools is
  // adapted at module load (channel-mcp.ts), and buildMcpServers() adapts
  // during processMessage — both BEFORE queryStream installs the query's
  // denylist. The gate must be resolved at execute time, never captured at
  // adapt time (review R1 on #4538: a value capture froze such tools on
  // ALLOW_ALL_GATE and the deny never fired).
  it('tools adapted BEFORE queryStream pick up the denylist it installs', async () => {
    provider.streamFn = () => undefined;
    const handler = vi.fn(() => Promise.resolve('should not reach'));
    const tool = provider.createInlineTool(makeTool(handler)) as ReturnType<
      typeof adaptInlineTool
    >;

    provider.queryStream(
      (async function* () {
        /* never consumed — queryStream returns synchronously */
      })(),
      { settingSources: [], disallowedTools: ['search'] },
    );

    await expect(
      tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined)
    ).rejects.toThrow(/permission denied.*search/);
    expect(handler).not.toHaveBeenCalled();
  });

  it('tools adapted before a gate REPLACE also follow the new gate (no frozen capture)', async () => {
    provider.streamFn = () => undefined;
    const handler = vi.fn(({ q }: { q: string }) => Promise.resolve(`ok ${q}`));
    const tool = provider.createInlineTool(makeTool(handler)) as ReturnType<
      typeof adaptInlineTool
    >;

    provider.permissionGate = createDenylistGate(['search']);
    // A later query without disallowedTools resets to allow-all — the
    // previously-adapted tool must follow the reset, not the stale deny.
    provider.queryStream((async function* () {})(), {
      settingSources: [],
      disallowedTools: [],
    });

    const res = await tool.execute('call_1', { q: 'x' }, undefined, undefined, undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ q: 'x' });
    expect(res.details).toBe('ok x');
  });

  // Documents the single-active-query assumption (review R2 on #4538): the
  // provider is a process-wide cached instance (factory.ts providerCache) and
  // queryStream REPLACES the gate — a second interleaved query with different
  // disallowedTools overwrites the first's denylist. This is accepted for now
  // (the ClaudeSDKProvider contract is one long-lived query per chat, and pi
  // queryStream injects no tools yet — no production execution path); proper
  // per-query scoping belongs to the beforeToolCall-hook layer (#4542), which
  // installs the gate on the per-query Agent constructor. If that layer
  // lands, DELETE this test together with the instance-field seam.
  it('WARNING-SEMANTICS: a later queryStream overwrites an earlier query\'s gate (single-active-query assumption)', () => {
    provider.streamFn = () => undefined;
    provider.queryStream((async function* () {})(), {
      settingSources: [],
      disallowedTools: ['bash'],
    });
    expect(provider.permissionGate.decide({ toolName: 'bash', args: {} }).allowed).toBe(
      false,
    );
    // Second query with no disallowedTools resets the shared field...
    provider.queryStream((async function* () {})(), {
      settingSources: [],
      disallowedTools: [],
    });
    // ...so the first query's deny no longer holds. Known limitation, see
    // the comment above and #4542 for the per-query fix.
    expect(provider.permissionGate.decide({ toolName: 'bash', args: {} })).toEqual({
      allowed: true,
    });
  });
});
