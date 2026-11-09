/** Runtime profile declarations for chat creation (Issue #4913). */
import { describe, expect, it } from 'vitest';
import type { AgentPresets } from './types.js';
import { parseRuntimeProfileDeclaration, resolveRuntimeProfile } from './runtime-profiles.js';

const presets: AgentPresets = {
  'codex-main': { agentBackend: 'codex', model: 'gpt-5.2-codex', apiKey: 'k', llm: 'codex-llm' },
  'claude-main': { agentBackend: 'claude', model: 'claude-sonnet-4-6', apiKey: 'k', llm: 'claude-llm' },
  'pi-main': { agentBackend: 'pi', model: 'pi-default', apiKey: 'k', llm: 'pi-llm' },
};

describe('parseRuntimeProfileDeclaration', () => {
  it('accepts a named preset and an explicit triple', () => {
    expect(parseRuntimeProfileDeclaration({ preset: 'codex-main' })).toEqual({ preset: 'codex-main' });
    expect(parseRuntimeProfileDeclaration({ harness: 'codex', model: 'gpt-5.2-codex', thinking: 'high' }))
      .toEqual({ harness: 'codex', model: 'gpt-5.2-codex', thinking: 'high' });
  });

  it('treats absence as no declaration', () => {
    expect(parseRuntimeProfileDeclaration(undefined)).toBeUndefined();
    expect(parseRuntimeProfileDeclaration(null)).toBeUndefined();
  });

  it('rejects credential- or endpoint-looking fields instead of ignoring them', () => {
    expect(() => parseRuntimeProfileDeclaration({ preset: 'x', apiKey: 'sk-1' })).toThrow(/unsupported field\(s\): apiKey/);
    expect(() => parseRuntimeProfileDeclaration({ preset: 'x', apiBaseUrl: 'https://evil' })).toThrow(/apiBaseUrl/);
  });

  it('rejects empty values and empty objects', () => {
    expect(() => parseRuntimeProfileDeclaration({})).toThrow(/must declare/);
    expect(() => parseRuntimeProfileDeclaration({ preset: ' ' })).toThrow(/non-empty/);
  });
});

describe('resolveRuntimeProfile', () => {
  it('resolves a named preset from the enabled catalog unchanged', () => {
    const result = resolveRuntimeProfile(presets, { preset: 'claude-main' });
    expect(result).toEqual({ ok: true, presetName: 'claude-main', preset: presets['claude-main'] });
  });

  it('rejects unknown preset names with the available catalog as options', () => {
    const result = resolveRuntimeProfile(presets, { preset: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unknown agent preset: nope');
      expect(result.options).toEqual(['codex-main', 'claude-main', 'pi-main']);
    }
  });

  it('rejects combining a named preset with explicit dimensions', () => {
    const result = resolveRuntimeProfile(presets, { preset: 'codex-main', model: 'gpt-5.2' });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('cannot combine'); }
  });

  it('resolves an explicit codex triple against a catalog preset of that harness', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'codex', model: 'gpt-5.3-codex', thinking: 'high' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.presetName).toBe('codex-main');
      expect(result.overrides).toEqual({ model: 'gpt-5.3-codex', reasoningEffort: 'high' });
    }
  });

  it('rejects an unsupported harness with the valid harnesses as options', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'gemini', model: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unsupported harness: gemini');
      expect(result.options).toEqual(expect.arrayContaining(['claude', 'codex']));
    }
  });

  it('rejects a model that is not a Codex identifier for the codex harness', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'codex', model: 'claude-sonnet-4-6' });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('not a Codex/ChatGPT model identifier'); }
  });

  it('requires an explicit model — never falls back to a default model', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'claude' });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('must declare a model'); }
  });

  it('rejects thinking on harnesses that cannot apply it instead of silently ignoring it', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'claude', model: 'claude-sonnet-4-6', thinking: 'high' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not support a thinking level');
      expect(result.options).toEqual(['codex']);
    }
  });

  it('rejects invalid thinking values with the supported levels as options', () => {
    const result = resolveRuntimeProfile(presets, { harness: 'codex', model: 'gpt-5.2-codex', thinking: 'extreme' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid thinking level: extreme');
      expect(result.options).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    }
  });

  it('rejects an explicit harness no enabled preset provides (no credential borrowing)', () => {
    const result = resolveRuntimeProfile(
      { 'claude-main': presets['claude-main'] },
      { harness: 'codex', model: 'gpt-5.2-codex' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('No enabled agent preset provides the codex harness'); }
  });
});
