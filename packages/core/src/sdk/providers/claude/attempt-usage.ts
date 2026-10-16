import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { QueryUsageAudit, UsageEstimate } from '../../types.js';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd'] as const;
type Totals = Pick<UsageEstimate, typeof fields[number]>;
const sum = (items: Totals[]): Totals => Object.fromEntries(fields.flatMap(field => {
  const values = items.map(item => item[field]).filter(finite);
  return values.length ? [[field, values.reduce((a, b) => a + b, 0)]] : [];
}));
function mainUsage(raw: unknown): Totals {
  if (!raw || typeof raw !== 'object') { return {}; }
  const data = raw as Record<string, unknown>;
  return Object.fromEntries(Object.entries({ inputTokens: data.input_tokens, outputTokens: data.output_tokens,
    cacheReadTokens: data.cache_read_input_tokens, cacheCreationTokens: data.cache_creation_input_tokens }).filter(([, value]) => finite(value)));
}

/** SDK estimates are observations, never proof of final upstream billing. */
export class ClaudeAttemptUsage {
  private readonly startedAt = Date.now();
  private endedAt?: number;
  private pipeline?: Totals;
  private pipelineComplete = false;
  private accountingWindowChanged = false;
  private readonly assistants = new Map<string, Totals>();
  private readonly turnResults: Totals[] = [];
  private readonly resultIds = new Set<string>();
  private estimatedCost?: number;
  private failedResult = false;
  private incomplete = false;
  private resultCount = 0;

  constructor(readonly ordinal: number) {}

  observe(message: SDKMessage): void {
    if (message.type === 'conversation_reset') { this.accountingWindowChanged = true; }
    if (message.type === 'assistant' && !message.parent_tool_use_id && message.message?.id && message.message.usage) {
      // Multiple content blocks may repeat the same message usage.
      this.assistants.set(message.message.id, mainUsage(message.message.usage));
    }
    if (message.type !== 'result') { return; }
    const id = message.uuid;
    if (id && this.resultIds.has(id)) { return; }
    if (id) { this.resultIds.add(id); }
    this.resultCount++;
    this.failedResult = message.subtype !== 'success' || message.is_error;
    const usage = mainUsage(message.usage);
    if (Object.keys(usage).length) { this.turnResults.push(usage); }
    this.assistants.clear();
    if (finite(message.total_cost_usd)) { this.estimatedCost = message.total_cost_usd; }
    const models = Object.values(message.modelUsage ?? {});
    if (models.length) {
      this.pipeline = sum(models.map(model => ({
        ...(finite(model.inputTokens) ? { inputTokens: model.inputTokens } : {}),
        ...(finite(model.outputTokens) ? { outputTokens: model.outputTokens } : {}),
        ...(finite(model.cacheReadInputTokens) ? { cacheReadTokens: model.cacheReadInputTokens } : {}),
        ...(finite(model.cacheCreationInputTokens) ? { cacheCreationTokens: model.cacheCreationInputTokens } : {}),
        ...(finite(model.costUSD) ? { costUsd: model.costUSD } : {}),
      })));
      this.pipelineComplete = models.every(model => finite(model.inputTokens) && finite(model.outputTokens)
        && finite(model.cacheReadInputTokens) && finite(model.cacheCreationInputTokens));
    }
    // modelUsage/cost are cumulative for the query. Replace, never sum them
    // across result turns. usage is main-loop-only and per native result turn.
  }

  finish(incomplete = false): void { this.endedAt ??= Date.now(); this.incomplete ||= incomplete; }

  snapshot(): UsageEstimate {
    const pending = [...this.assistants.values()];
    const main = sum([...this.turnResults, ...pending]);
    const totals = this.pipeline ? sum([this.pipeline, ...pending]) : main;
    const hasTokens = fields.slice(0, 4).some(key => finite(totals[key]));
    const zeroFailed = this.failedResult && !Object.values(totals).some(value => finite(value) && value > 0);
    const state = !hasTokens || zeroFailed ? 'unknown'
      : this.pipelineComplete && !this.failedResult && !this.incomplete && !pending.length && !this.accountingWindowChanged ? 'reported' : 'partial';
    return { attempt: this.ordinal, state, scope: this.pipeline ? 'query-pipeline' : hasTokens ? 'main-loop' : 'unavailable',
      latencyMs: (this.endedAt ?? Date.now()) - this.startedAt, ...totals,
      ...(finite(this.estimatedCost) ? { costUsd: this.estimatedCost } : {}), resultCount: this.resultCount,
      ...(this.accountingWindowChanged ? { accountingWindowChanged: true } : {}),
      billingVerified: false };
  }
}

export function claudeQueryUsage(queryId: string, attempts: ClaudeAttemptUsage[]): QueryUsageAudit {
  const estimates = attempts.map(attempt => attempt.snapshot());
  return { queryId, attempts: estimates, attemptCount: estimates.length,
    unknownAttempts: estimates.filter(item => item.state === 'unknown').length,
    partialAttempts: estimates.filter(item => item.state === 'partial').length,
    knownTotals: sum(estimates.filter(item => item.state !== 'unknown')), billingVerified: false };
}
