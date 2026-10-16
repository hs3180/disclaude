import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, vi } from 'vitest';
import { ClaudeAttemptUsage, claudeQueryUsage } from './attempt-usage.js';

const result = (id: string, data: Record<string, unknown> = {}) => ({ type: 'result', subtype: 'success',
  uuid: id, is_error: false, ...data }) as SDKMessage;
const model = (input: number, output = 2) => ({ inputTokens: input, outputTokens: output,
  cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: input / 1000 });
const assistant = (id: string, input: number, output: number) => ({ type: 'assistant', parent_tool_use_id: null,
  message: { id, usage: { input_tokens: input, output_tokens: output } } }) as SDKMessage;

describe('Claude attempt and logical-query usage estimates', () => {
  it('reports a single native attempt with unknown API-retry charges', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe({ type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 2,
      retry_delay_ms: 1000, error_status: 429 } as SDKMessage);
    usage.observe(result('success', { modelUsage: { fixture: model(20) }, total_cost_usd: 0.02 }));
    usage.finish();
    expect(claudeQueryUsage('owned-query', [usage])).toMatchObject({ attemptCount: 1, unknownAttempts: 0,
      attempts: [{ state: 'reported', retryEvents: 1, retryUsage: 'unknown', billingVerified: false }],
      knownTotals: { inputTokens: 20, outputTokens: 2, costUsd: 0.02 }, billingVerified: false });
  });
  it('replaces cumulative modelUsage and cost rather than summing result turns', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe(result('turn-1', { modelUsage: { fixture: model(10) }, total_cost_usd: 0.01 }));
    usage.observe(result('turn-2', { modelUsage: { fixture: model(30, 5) }, total_cost_usd: 0.03 }));
    expect(usage.snapshot()).toMatchObject({ inputTokens: 30, outputTokens: 5, costUsd: 0.03, resultCount: 2 });
  });
  it('deduplicates repeated assistant and result snapshots', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe(assistant('one-response', 10, 2)); usage.observe(assistant('one-response', 10, 3));
    expect(usage.snapshot()).toMatchObject({ state: 'partial', inputTokens: 10, outputTokens: 3 });
    const terminal = result('terminal', { usage: { input_tokens: 10, output_tokens: 3 } });
    usage.observe(terminal); usage.observe(terminal);
    expect(usage.snapshot()).toMatchObject({ resultCount: 1, inputTokens: 10, outputTokens: 3 });
  });
  it('preserves later partial main-loop usage after an earlier complete turn', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe(result('one', { modelUsage: { fixture: model(10) } }));
    usage.observe(assistant('later', 7, 1)); usage.finish(true);
    expect(usage.snapshot()).toMatchObject({ state: 'partial', inputTokens: 17, outputTokens: 3 });
  });
  it('keeps zeroed crash usage unknown and records latency without inventing zero billing', () => {
    vi.useFakeTimers();
    try {
      const usage = new ClaudeAttemptUsage(1);
      usage.observe(result('startup-failure', { is_error: true,
        usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
      vi.advanceTimersByTime(3000); usage.finish(true); vi.advanceTimersByTime(5000);
      expect(usage.snapshot()).toMatchObject({ state: 'unknown', latencyMs: 3000, billingVerified: false });
      expect(claudeQueryUsage('crash', [usage]).knownTotals).toEqual({});
    } finally { vi.useRealTimers(); }
  });
  it('excludes malformed counters from known totals', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe(result('bad', { usage: { input_tokens: NaN, output_tokens: -3 }, total_cost_usd: Infinity }));
    expect(usage.snapshot()).toMatchObject({ state: 'unknown', scope: 'unavailable' });
    expect(claudeQueryUsage('bad', [usage]).knownTotals).toEqual({});
  });
  it('keeps a changed SDK accounting window partial and excludes subagent-only fallbacks', () => {
    const usage = new ClaudeAttemptUsage(1);
    usage.observe({ ...assistant('child-only', 4, 2), parent_tool_use_id: 'owned-task' } as SDKMessage);
    expect(usage.snapshot().state).toBe('unknown');
    usage.observe(result('before-clear', { modelUsage: { fixture: model(10) } }));
    usage.observe({ type: 'conversation_reset' } as SDKMessage);
    usage.observe(result('after-clear', { modelUsage: { fixture: model(2) } }));
    expect(usage.snapshot()).toMatchObject({ state: 'partial', accountingWindowChanged: true, inputTokens: 2 });
  });
});
