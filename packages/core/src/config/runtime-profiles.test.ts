/** Runtime profile declarations for chat creation (Issue #4913). */
import { describe, expect, it } from 'vitest';
import type { AgentRuntimes } from './types.js';
import { parseRuntimeProfileDeclaration, resolveRuntimeProfile } from './runtime-profiles.js';

const runtimes: AgentRuntimes = {
  'codex-main': { agentBackend: 'codex', model: 'gpt-5.2-codex', apiKey: 'k', llm: 'codex-llm' },
  'claude-main': { agentBackend: 'claude', model: 'claude-sonnet-4-6', apiKey: 'k', llm: 'claude-llm' },
  'pi-main': { agentBackend: 'pi', model: 'pi-default', apiKey: 'k', llm: 'pi-llm' },
};

describe('parseRuntimeProfileDeclaration', () => {
  it('accepts only the explicit harness/model/reasoningEffort surface', () => {
    expect(parseRuntimeProfileDeclaration({ harness: 'codex', model: 'gpt-5.2-codex', reasoningEffort: 'high' }))
      .toEqual({ harness: 'codex', model: 'gpt-5.2-codex', reasoningEffort: 'high' });
  });

  it('treats absence as no declaration', () => {
    expect(parseRuntimeProfileDeclaration(undefined)).toBeUndefined();
    expect(parseRuntimeProfileDeclaration(null)).toBeUndefined();
  });

  it('rejects legacy fields without aliasing or catalog derivation', () => {
    expect(() => parseRuntimeProfileDeclaration({ preset: 'codex-main' })).toThrow(/unsupported field\(s\): preset/);
    expect(() => parseRuntimeProfileDeclaration({ harness: 'codex', model: 'gpt-5.2-codex', thinking: 'high' })).toThrow(/unsupported field\(s\): thinking/);
  });

  it('rejects credential- or endpoint-looking fields instead of ignoring them', () => {
    expect(() => parseRuntimeProfileDeclaration({ harness: 'codex', apiKey: 'sk-1' })).toThrow(/unsupported field\(s\): apiKey/);
    expect(() => parseRuntimeProfileDeclaration({ harness: 'codex', apiBaseUrl: 'https://evil' })).toThrow(/apiBaseUrl/);
  });

  it('rejects empty values and empty objects', () => {
    expect(() => parseRuntimeProfileDeclaration({})).toThrow(/must declare/);
    expect(() => parseRuntimeProfileDeclaration({ model: ' ' })).toThrow(/non-empty/);
  });
});

describe('resolveRuntimeProfile', () => {
  it('validates an explicit codex triple and returns only an internal credential base', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'high' });
    expect(result).toEqual({
      ok: true,
      base: { presetName: 'codex-main', preset: runtimes['codex-main'] },
      overrides: { model: 'gpt-5.3-codex', reasoningEffort: 'high' },
    });
  });

  it('rejects an unsupported harness with the valid harnesses as options', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'gemini', model: 'x' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Unsupported harness: gemini');
      expect(result.options).toEqual(expect.arrayContaining(['claude', 'codex']));
    }
  });

  it('rejects a model that is not a Codex identifier for the codex harness', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'codex', model: 'claude-sonnet-4-6' });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('not a Codex/ChatGPT model identifier'); }
  });

  it('requires an explicit model — never falls back to a default model', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'claude' });
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('must declare a model'); }
  });

  it('rejects reasoning effort on harnesses that cannot apply it', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'claude', model: 'claude-sonnet-4-6', reasoningEffort: 'high' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('does not support a reasoning effort');
      expect(result.options).toEqual(['codex']);
    }
  });

  it('rejects invalid reasoning effort values with the supported levels as options', () => {
    const result = resolveRuntimeProfile(runtimes, { harness: 'codex', model: 'gpt-5.2-codex', reasoningEffort: 'extreme' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Invalid reasoning effort: extreme');
      expect(result.options).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    }
  });

  it('rejects a harness with no enabled credential base before chat creation', () => {
    const result = resolveRuntimeProfile(
      { 'claude-main': runtimes['claude-main'] },
      { harness: 'codex', model: 'gpt-5.2-codex' }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.error).toContain('No enabled agent provides the codex harness'); }
  });
});
