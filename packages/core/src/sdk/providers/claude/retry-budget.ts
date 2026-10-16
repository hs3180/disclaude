import type { RetryProgress } from '../../types.js';

export interface ClaudeRetryPolicy {
  prelaunchMaxRetries: number;
  sdkMaxRetries: number;
  backoffBudgetMs: number;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') { return fallback; }
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) > max) {
    throw new Error(`${name} must be an integer from 0 to ${max}`);
  }
  return Number(raw);
}

/** Pin the native budget instead of inheriting an SDK-version-dependent default. */
export function claudeRetryPolicy(env: NodeJS.ProcessEnv): ClaudeRetryPolicy {
  return {
    prelaunchMaxRetries: integer(env, 'DISCLAUDE_QUERY_MAX_RETRIES', 2, 15),
    sdkMaxRetries: integer(env, 'CLAUDE_CODE_MAX_RETRIES', 2, 15),
    backoffBudgetMs: integer(env, 'DISCLAUDE_RETRY_BACKOFF_BUDGET_MS', 60_000, 1_800_000),
  };
}

export class ClaudeRetryBudgetError extends Error {
  readonly code = 'CLAUDE_RETRY_BUDGET_EXHAUSTED';
  constructor(readonly reason: string) { super(`Claude retry budget exhausted: ${reason}`); }
}

/** Budget advertised retry waits, never productive model/tool execution time. */
export class ClaudeRetryBudget {
  private spentMs = 0;
  private turn = 1;
  constructor(readonly policy: ClaudeRetryPolicy) {}

  reserve(layer: 'sdk' | 'prelaunch', attempt: number, maxRetries: number, delayMs: number,
    status?: number | null): RetryProgress {
    if (!Number.isSafeInteger(attempt) || attempt < 1 || !Number.isSafeInteger(maxRetries) || maxRetries < 0 ||
        !Number.isFinite(delayMs) || delayMs < 0) {
      throw new ClaudeRetryBudgetError('invalid SDK retry progress');
    }
    const cap = layer === 'sdk' ? this.policy.sdkMaxRetries : this.policy.prelaunchMaxRetries;
    if (attempt > cap || maxRetries > cap) { throw new ClaudeRetryBudgetError(`${layer} retry count exceeds configured cap ${cap}`); }
    if (delayMs > this.policy.backoffBudgetMs - this.spentMs) {
      throw new ClaudeRetryBudgetError(`requested ${delayMs}ms wait exceeds remaining ${this.policy.backoffBudgetMs - this.spentMs}ms`);
    }
    this.spentMs += delayMs;
    return { layer, attempt, maxRetries, delayMs, remainingBackoffMs: this.policy.backoffBudgetMs - this.spentMs,
      turn: this.turn, ...(typeof status === 'number' ? { status } : {}) };
  }

  /** Streaming sessions may accept another user turn after a native result. */
  nextTurn(): void { this.spentMs = 0; this.turn++; }
}

export function retryProgressText(progress: RetryProgress): string {
  return `⏳ 上游暂时不可用，正在第 ${progress.attempt}/${progress.maxRetries} 次重试，预计等待 ${Math.ceil(progress.delayMs / 1000)} 秒。`;
}
