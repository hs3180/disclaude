import { describe, expect, it } from 'vitest';
import { ClaudeRetryBudget, claudeRetryPolicy } from './retry-budget.js';

describe('Claude retry policy', () => {
  it('pins finite native/prelaunch counts and a shared retry-wait budget', () => {
    expect(claudeRetryPolicy({})).toEqual({ prelaunchMaxRetries: 2, sdkMaxRetries: 2, backoffBudgetMs: 60_000 });
    expect(claudeRetryPolicy({ CLAUDE_CODE_MAX_RETRIES: '0', DISCLAUDE_QUERY_MAX_RETRIES: '3',
      DISCLAUDE_RETRY_BACKOFF_BUDGET_MS: '5000' })).toEqual({ prelaunchMaxRetries: 3, sdkMaxRetries: 0, backoffBudgetMs: 5000 });
  });
  it.each(['-1', '16', '3oops', 'Infinity', '1.2'])('rejects an invalid native retry budget %s before spawn', raw => {
    expect(() => claudeRetryPolicy({ CLAUDE_CODE_MAX_RETRIES: raw })).toThrow('CLAUDE_CODE_MAX_RETRIES');
  });
  it('shares the wait budget across host and SDK retries, preserving Retry-After', () => {
    const budget = new ClaudeRetryBudget({ prelaunchMaxRetries: 2, sdkMaxRetries: 2, backoffBudgetMs: 60_500 });
    budget.reserve('prelaunch', 1, 2, 500);
    expect(budget.reserve('sdk', 1, 2, 60_000, 429)).toMatchObject({ delayMs: 60_000, remainingBackoffMs: 0 });
    expect(() => budget.reserve('sdk', 2, 2, 60_000, 429)).toThrow('remaining 0ms');
    budget.nextTurn();
    expect(budget.reserve('sdk', 1, 2, 60_000)).toMatchObject({ turn: 2, remainingBackoffMs: 500 });
  });
  it('denies native SDK budget changes and malformed progress', () => {
    const budget = new ClaudeRetryBudget(claudeRetryPolicy({}));
    expect(() => budget.reserve('sdk', 1, 10, 10)).toThrow('configured cap 2');
    expect(() => budget.reserve('sdk', 3, 2, 10)).toThrow('configured cap 2');
    expect(() => budget.reserve('sdk', 1, 2, NaN)).toThrow('invalid SDK retry progress');
  });
});
