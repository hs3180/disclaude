import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';
import {
  assumedContextWindow,
  clearResolvedClaudeAliasCache,
  resolveClaudeModelAlias,
} from './model-alias.js';

function catalog(models: Array<Partial<ModelInfo> & { value: string }>): {
  rows: ModelInfo[];
  supportedModels: Mock<() => Promise<ModelInfo[]>>;
} {
  const rows = models.map((model) => ({
    displayName: model.value,
    description: '',
    resolvedModel: undefined,
    ...model,
  })) as ModelInfo[];
  const supportedModels = vi.fn((): Promise<ModelInfo[]> => Promise.resolve(rows));
  return { rows, supportedModels };
}

afterEach(() => {
  clearResolvedClaudeAliasCache();
});

describe('assumedContextWindow', () => {
  it('treats Opus 4.7+ and Opus 5 as 1M-window keys (Issue #5410)', () => {
    expect(assumedContextWindow('claude-opus-4-6')).toBe(200_000);
    expect(assumedContextWindow('claude-opus-4-7')).toBe(1_000_000);
    expect(assumedContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(assumedContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(assumedContextWindow('gateway/model-id')).toBe(200_000);
  });
});

describe('resolveClaudeModelAlias (Issue #5422)', () => {
  it('resolves the alias row value to its resolvedModel full ID', async () => {
    const { supportedModels } = catalog([
      { value: 'default', resolvedModel: 'claude-sonnet-5' },
      { value: 'opus', resolvedModel: 'claude-opus-5' },
    ]);
    await expect(resolveClaudeModelAlias('opus', 'gateway', { supportedModels })).resolves.toBe('claude-opus-5');
  });

  it('falls back to the row value when the catalog omits resolvedModel', async () => {
    const { supportedModels } = catalog([{ value: 'sonnet' }]);
    await expect(resolveClaudeModelAlias('sonnet', 'gateway', { supportedModels })).resolves.toBe('sonnet');
  });

  it('matches case-insensitively', async () => {
    const { supportedModels } = catalog([{ value: 'opus', resolvedModel: 'claude-opus-5' }]);
    await expect(resolveClaudeModelAlias('Opus', 'gateway', { supportedModels })).resolves.toBe('claude-opus-5');
  });

  it('reports the catalog values when the alias is absent', async () => {
    const { supportedModels } = catalog([
      { value: 'default', resolvedModel: 'claude-sonnet-5' },
      { value: 'sonnet', resolvedModel: 'claude-sonnet-5' },
    ]);
    await expect(resolveClaudeModelAlias('fable', 'gateway', { supportedModels }))
      .rejects.toThrow('behavesAs alias "fable" is not in the running Claude model catalog (available: default, sonnet)');
  });

  it('caches per LLM for the process lifetime and never caches failures', async () => {
    const { supportedModels } = catalog([{ value: 'opus', resolvedModel: 'claude-opus-5' }]);
    const session = { supportedModels };
    await resolveClaudeModelAlias('opus', 'gateway', session);
    await resolveClaudeModelAlias('opus', 'gateway', session);
    expect(supportedModels).toHaveBeenCalledTimes(1);
    // A different LLM binding re-asks the catalog (its settings can constrain it).
    await resolveClaudeModelAlias('opus', 'other-gateway', session);
    expect(supportedModels).toHaveBeenCalledTimes(2);
    // A failed lookup is retried on the next session boot.
    const miss = catalog([{ value: 'sonnet' }]);
    await expect(resolveClaudeModelAlias('fable', 'gateway', miss)).rejects.toThrow(/not in the running Claude model catalog/);
    await expect(resolveClaudeModelAlias('fable', 'gateway', miss)).rejects.toThrow(/not in the running Claude model catalog/);
    expect(miss.supportedModels).toHaveBeenCalledTimes(2);
  });

  it('keeps one config working across a simulated Claude Code upgrade (alias → new full ID)', async () => {
    // Before the upgrade the catalog resolves opus → claude-opus-5.
    const before = catalog([{ value: 'opus', resolvedModel: 'claude-opus-5' }]);
    await expect(resolveClaudeModelAlias('opus', 'gateway', before)).resolves.toBe('claude-opus-5');
    // After the upgrade (new process, fresh cache) the same alias resolves to
    // the renamed catalog ID — a pinned full-ID config would have silently
    // missed the renamed key instead.
    clearResolvedClaudeAliasCache();
    const after = catalog([{ value: 'opus', resolvedModel: 'claude-opus-5-2' }]);
    await expect(resolveClaudeModelAlias('opus', 'gateway', after)).resolves.toBe('claude-opus-5-2');
  });
});
