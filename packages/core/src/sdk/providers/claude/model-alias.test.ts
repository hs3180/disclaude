import { describe, expect, it } from 'vitest';
import { assumedContextWindow, isFullClaudeModelId } from './model-alias.js';

describe('assumedContextWindow', () => {
  it('treats Opus 4.7+ and Opus 5 as 1M-window keys (Issue #5410)', () => {
    expect(assumedContextWindow('claude-opus-4-6')).toBe(200_000);
    expect(assumedContextWindow('claude-opus-4-7')).toBe(1_000_000);
    expect(assumedContextWindow('claude-opus-5')).toBe(1_000_000);
    expect(assumedContextWindow('claude-sonnet-4-5')).toBe(200_000);
    expect(assumedContextWindow('gateway/model-id')).toBe(200_000);
  });
});

describe('isFullClaudeModelId (Issue #5422)', () => {
  it('accepts full Claude catalog IDs', () => {
    expect(isFullClaudeModelId('claude-opus-5')).toBe(true);
    expect(isFullClaudeModelId('claude-sonnet-4-5')).toBe(true);
    expect(isFullClaudeModelId('claude-opus-4-1-20250805')).toBe(true);
  });

  it('rejects bare tier aliases — r2 compiles them into tier-keyed mappings at config time', () => {
    expect(isFullClaudeModelId('opus')).toBe(false);
    expect(isFullClaudeModelId('sonnet')).toBe(false);
    expect(isFullClaudeModelId('haiku')).toBe(false);
    expect(isFullClaudeModelId('fable')).toBe(false);
    expect(isFullClaudeModelId('default')).toBe(false);
  });

  it('normalizes case and surrounding whitespace before checking', () => {
    expect(isFullClaudeModelId('Claude-Opus-5')).toBe(true);
    expect(isFullClaudeModelId('  claude-opus-5 ')).toBe(true);
  });

  it('rejects gateway-style and empty keys', () => {
    expect(isFullClaudeModelId('group/hq-degrade')).toBe(false);
    expect(isFullClaudeModelId('glm-5.3')).toBe(false);
    expect(isFullClaudeModelId('')).toBe(false);
  });
});
