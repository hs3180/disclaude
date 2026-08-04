/**
 * Tests for the disclaude AgentQueryOptions → pi run-options adapter
 * (Issue #4386 S3, part 2).
 *
 * Uses synthetic `AgentQueryOptions` values; no real pi runtime is required —
 * the adapter is a pure function. The deferred-items contract (model-string
 * passthrough, preset handling, env) is asserted alongside the positive
 * mappings; see the docblock in options-adapter.ts for the full deferral list.
 */
import { describe, it, expect } from 'vitest';
import { adaptPiOptions, type PiAdaptedOptions } from './options-adapter.js';
import type { AgentQueryOptions } from '../../types.js';

/** AgentQueryOptions requires `settingSources` (the only required field). */
function opts(over: Partial<AgentQueryOptions> = {}): AgentQueryOptions {
  return { settingSources: ['user'], ...over };
}

describe('adaptPiOptions (Issue #4386 part 2 / #4384)', () => {
  // -------------------------------------------------------------------------
  // systemPrompt
  // -------------------------------------------------------------------------

  it('maps a plain-string systemPrompt verbatim', () => {
    const res = adaptPiOptions(opts({ systemPrompt: 'You are a pi agent.' }));
    expect(res.systemPrompt).toBe('You are a pi agent.');
  });

  it('returns undefined systemPrompt when absent (provider supplies pi default)', () => {
    const res = adaptPiOptions(opts());
    expect(res.systemPrompt).toBeUndefined();
  });

  it('carries only the `append` tail of a claude_code systemPrompt preset', () => {
    const res = adaptPiOptions(
      opts({
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'Be terse.',
        },
      })
    );
    expect(res.systemPrompt).toBe('Be terse.');
  });

  it('returns undefined systemPrompt for a claude_code preset with no append', () => {
    const res = adaptPiOptions(opts({ systemPrompt: { type: 'preset', preset: 'claude_code' } }));
    expect(res.systemPrompt).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // activeToolNames
  // -------------------------------------------------------------------------

  it('uses allowedTools as the active tool-name base', () => {
    const res = adaptPiOptions(opts({ allowedTools: ['read', 'bash'] }));
    expect(res.activeToolNames).toEqual(['read', 'bash']);
  });

  it('falls back to a string-array `tools` when allowedTools is absent', () => {
    const res = adaptPiOptions(opts({ tools: ['read', 'edit'] }));
    expect(res.activeToolNames).toEqual(['read', 'edit']);
  });

  it('prefers allowedTools over a string-array tools when both are present', () => {
    const res = adaptPiOptions(opts({ allowedTools: ['read'], tools: ['read', 'edit'] }));
    expect(res.activeToolNames).toEqual(['read']);
  });

  it('subtracts disallowedTools from the resolved base', () => {
    const res = adaptPiOptions(
      opts({
        allowedTools: ['read', 'bash', 'edit'],
        disallowedTools: ['bash'],
      })
    );
    expect(res.activeToolNames).toEqual(['read', 'edit']);
  });

  it('ignores an empty disallowedTools (no filtering)', () => {
    const res = adaptPiOptions(opts({ allowedTools: ['read', 'bash'], disallowedTools: [] }));
    expect(res.activeToolNames).toEqual(['read', 'bash']);
  });

  it('returns undefined activeToolNames for a claude_code ToolsPreset (not portable to pi)', () => {
    const res = adaptPiOptions(opts({ tools: { type: 'preset', preset: 'claude_code' } }));
    expect(res.activeToolNames).toBeUndefined();
  });

  it('returns undefined activeToolNames when no tool option is present', () => {
    const res = adaptPiOptions(opts());
    expect(res.activeToolNames).toBeUndefined();
  });

  it('does not mutate the input arrays', () => {
    const allowed = ['read', 'bash'];
    const disallowed = ['bash'];
    adaptPiOptions(opts({ allowedTools: allowed, disallowedTools: disallowed }));
    expect(allowed).toEqual(['read', 'bash']);
    expect(disallowed).toEqual(['bash']);
  });

  // -------------------------------------------------------------------------
  // model (string passthrough; Model<any> resolution deferred to provider.ts)
  // -------------------------------------------------------------------------

  it('passes options.model through as a string (Model resolution is deferred)', () => {
    const res = adaptPiOptions(opts({ model: 'gpt-5' }));
    expect(res.model).toBe('gpt-5');
  });

  it('returns undefined model when absent', () => {
    const res = adaptPiOptions(opts());
    expect(res.model).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // env passthrough
  // -------------------------------------------------------------------------

  it('passes options.env through unchanged', () => {
    const env = { PI_API_KEY: 'sk-...', VERBOSE: undefined };
    const res = adaptPiOptions(opts({ env }));
    expect(res.env).toEqual({ PI_API_KEY: 'sk-...', VERBOSE: undefined });
  });

  // -------------------------------------------------------------------------
  // Claude-only fields are NOT carried (deferred / no pi equivalent)
  // -------------------------------------------------------------------------

  it('does not surface Claude-only fields (cwd/settingSources/stderr/teammateMode)', () => {
    const res = adaptPiOptions(
      opts({
        cwd: '/tmp',
        stderr: () => {},
        teammateMode: 'in-process',
        includePartialMessages: true,
        permissionMode: 'bypassPermissions',
        mcpServers: { x: { type: 'stdio', command: 'x' } as never },
      })
    );
    const carried: Array<keyof PiAdaptedOptions> = [
      'systemPrompt',
      'activeToolNames',
      'model',
      'env',
    ];
    expect(Object.keys(res).sort()).toEqual([...carried].sort());
    // none of the Claude-only inputs produced a field:
    expect(res.systemPrompt).toBeUndefined();
    expect(res.activeToolNames).toBeUndefined();
    expect(res.model).toBeUndefined();
    expect(res.env).toBeUndefined();
  });
});
