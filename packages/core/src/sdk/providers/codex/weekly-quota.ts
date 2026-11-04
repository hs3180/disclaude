/**
 * Codex weekly-quota ledger + tiered fresh-session admission (#5607).
 *
 * Neither codex transport exposes a real balance/reset-time data source
 * (research: runs/T-058/data-source-research-2026-11-04T22-40Z.md — usage
 * payloads carry only token counts; the plan's rolling windows surface
 * solely through failure text). The ledger therefore:
 *
 * - ESTIMATES consumption against a configured weekly budget
 *   (`agent.codex.weeklyBudgetTokens`, unset/0 = observe-only mode — the
 *   default, so the feature ships dark and is opted into per deployment);
 * - CALIBRATES from real usage-limit failures, parsing the upstream reset
 *   hint ("try again at <time>" / "try again in <duration>") into a
 *   deadline that gates NEW sessions until the window resets.
 *
 * Admission tiers (only the fresh-session boundary is ever gated — a
 * resumed turn and a running turn are never killed or delayed):
 * - latched limit (real evidence, works even in observe-only mode):
 *   every fresh session degrades with the reset moment;
 * - estimate ratio ≤ block threshold: every fresh session degrades;
 * - estimate ratio ≤ tighten threshold: NON-INTERACTIVE fresh sessions
 *   are skipped with a recorded reason (never silent).
 *
 * Every surfaced number is labeled an estimate: consumption counts only
 * what THIS process observed (uncached input + output tokens), so a
 * restart or a second process re-starts the count. No persistence —
 * mirror of the in-memory quota/governor state (#4632/#4634).
 */

/** Estimated weekly budget in tokens; > 0 enables the estimation tiers. */
export interface CodexWeeklyQuotaConfig {
  /** Configured weekly budget (tokens). Unset/0 = observe-only (default). */
  weeklyBudgetTokens?: number;
  /** Remaining ratio at/below which non-interactive fresh sessions are skipped. Default 0.2. */
  weeklyTightenThreshold?: number;
  /** Remaining ratio at/below which every fresh session degrades. Default 0.05. */
  weeklyBlockThreshold?: number;
  /** Conservative cooldown when a real limit hit carries no parsable reset hint. Default 1h. */
  weeklyLimitCooldownMs?: number;
}

export const DEFAULT_WEEKLY_TIGHTEN_THRESHOLD = 0.2;
export const DEFAULT_WEEKLY_BLOCK_THRESHOLD = 0.05;
export const DEFAULT_WEEKLY_LIMIT_COOLDOWN_MS = 60 * 60 * 1000;
export const CODEX_WEEKLY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type CodexWeeklyLimitWindow = 'weekly' | 'five-hour' | 'unknown';

/** /status view. Numbers are process-local estimates unless marked otherwise. */
export interface CodexWeeklyQuotaSnapshot {
  estimationEnabled: boolean;
  weeklyBudgetTokens?: number;
  /** Start of the current estimation window (epoch ms). */
  windowStartedAt?: number;
  /** Estimated window reset (epoch ms) — window start + 7d, or a calibrated deadline. */
  windowResetsAt?: number;
  /** Tokens consumed in the current window, as observed by THIS process (estimate). */
  consumedTokens: number;
  remainingTokens?: number;
  remainingRatio?: number;
  /** A real usage-limit failure is latched (its reset deadline not yet reached). */
  limitLatched: boolean;
  limitWindow?: CodexWeeklyLimitWindow;
  limitResetAt?: number;
  limitSource?: 'parsed' | 'conservative';
  /** Last tighten-tier skip (recorded, never silent). */
  lastSkip?: { at: number; reason: string };
}

export type CodexFreshSessionAdmission =
  | { decision: 'allow' }
  /** Tighten tier: skip this non-interactive fresh session, record the reason. */
  | { decision: 'skip'; reason: string; resetAt?: number }
  /** Admission-limit tier: friendly degrade for a user-visible fresh session. */
  | { decision: 'degrade'; reason: string; resetAt?: number };

interface LatchedLimit {
  until: number;
  window: CodexWeeklyLimitWindow;
  resetAt?: number;
  source: 'parsed' | 'conservative';
}

/**
 * Parse an upstream reset hint into an epoch-ms deadline. Two shapes,
 * captured from codex output (#4632): absolute "try again at Apr 30th,
 * 2026 11:21 AM" (ordinal suffixes stripped — Date.parse chokes on
 * "30th") and relative "try again in 2.5 hours". Returns undefined when
 * the text carries no usable hint.
 */
export function parseCodexResetHint(text: string, now: number): { deadline: number; source: 'parsed' } | undefined {
  const absolute = /try again (?:at|by)\s+([^.\n]+)/i.exec(text)?.[1];
  if (absolute) {
    const normalized = absolute.trim().replace(/(\d)(st|nd|rd|th)\b/gi, '$1');
    const parsed = Date.parse(normalized.includes('T') ? normalized : normalized.replace(/\s+/, ' '));
    if (Number.isFinite(parsed) && parsed > now) {
      return { deadline: parsed, source: 'parsed' };
    }
  }
  // Relative capture must NOT stop at "." — upstream durations carry
  // decimals ("in 2.5 hours"); the duration tokenizer picks its own tokens.
  const relative = /try again in\s+([^\n]+)/i.exec(text)?.[1];
  if (relative) {
    let ms = 0;
    let matched = false;
    for (const match of relative.matchAll(/(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)/gi)) {
      const value = Number.parseFloat(match[1]);
      if (!Number.isFinite(value)) { continue; }
      const unit = match[2].toLowerCase();
      const scale = unit.startsWith('week') ? 7 * 24 * 3600_000
        : unit.startsWith('day') ? 24 * 3600_000
        : unit.startsWith('hour') || unit.startsWith('hr') ? 3600_000
        : unit.startsWith('min') ? 60_000 : 1000;
      ms += value * scale;
      matched = true;
    }
    if (matched && ms > 0) {
      return { deadline: now + ms, source: 'parsed' };
    }
  }
  return undefined;
}

/** Distinguish the plan's rolling windows from the failure text when possible. */
export function classifyCodexLimitWindow(text: string): CodexWeeklyLimitWindow {
  if (/\bweek/i.test(text)) { return 'weekly'; }
  if (/\b(?:5[-\s]?h(?:ou)?rs?|five[-\s]?hours?)\b/i.test(text) || /\blimit[^.\n]{0,80}\bhour/i.test(text)) {
    return 'five-hour';
  }
  return 'unknown';
}

const WINDOW_LABEL: Record<CodexWeeklyLimitWindow, string> = {
  weekly: '周',
  'five-hour': '5 小时',
  unknown: '周期',
};

function formatTokens(value: number): string {
  return value.toLocaleString('en-US');
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export class CodexWeeklyQuotaLedger {
  private readonly weeklyBudgetTokens: number | undefined;
  private readonly tightenThreshold: number;
  private readonly blockThreshold: number;
  private readonly limitCooldownMs: number;
  private readonly now: () => number;
  private windowStartedAt: number | undefined;
  private consumedTokens = 0;
  private limit: LatchedLimit | undefined;
  private lastSkip: { at: number; reason: string } | undefined;

  constructor(config: CodexWeeklyQuotaConfig = {}, now: () => number = Date.now) {
    this.weeklyBudgetTokens =
      typeof config.weeklyBudgetTokens === 'number' && config.weeklyBudgetTokens > 0
        ? config.weeklyBudgetTokens
        : undefined;
    this.tightenThreshold = config.weeklyTightenThreshold ?? DEFAULT_WEEKLY_TIGHTEN_THRESHOLD;
    this.blockThreshold = config.weeklyBlockThreshold ?? DEFAULT_WEEKLY_BLOCK_THRESHOLD;
    this.limitCooldownMs = config.weeklyLimitCooldownMs ?? DEFAULT_WEEKLY_LIMIT_COOLDOWN_MS;
    this.now = now;
  }

  get estimationEnabled(): boolean {
    return this.weeklyBudgetTokens !== undefined;
  }

  /** Start a fresh estimation window (lazy — first observation wins). */
  private ensureWindow(now: number): void {
    if (this.windowStartedAt === undefined) {
      this.windowStartedAt = now;
      this.consumedTokens = 0;
    }
  }

  /** Roll the window when the configured span has elapsed. */
  private rollWindow(now: number): void {
    if (this.windowStartedAt !== undefined && now - this.windowStartedAt >= CODEX_WEEKLY_WINDOW_MS) {
      this.windowStartedAt = now;
      this.consumedTokens = 0;
    }
  }

  /**
   * Record one completed turn's usage. Cached input tokens are excluded —
   * subscription cache hits are effectively free, so counting them would
   * systematically understate the remaining budget (an estimate must err
   * toward earlier protection, not toward hitting the wall).
   */
  recordUsage(usage: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number }): void {
    const now = this.now();
    this.ensureWindow(now);
    this.rollWindow(now);
    const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - (usage.cachedInputTokens ?? 0));
    this.consumedTokens += uncachedInput + Math.max(0, usage.outputTokens ?? 0);
  }

  /**
   * Calibrate from a real usage-limit failure. Latches an admission gate
   * until the parsed (or conservative) reset deadline; a weekly hit also
   * restarts the estimation window at the deadline, because upstream just
   * told us exactly when the current weekly window ends.
   */
  recordLimitHit(failureText: string): void {
    const now = this.now();
    const parsed = parseCodexResetHint(failureText, now);
    const window = classifyCodexLimitWindow(failureText);
    const until = parsed?.deadline ?? now + this.limitCooldownMs;
    if (!this.limit || until > this.limit.until) {
      this.limit = { until, window, ...(parsed ? { resetAt: parsed.deadline } : {}), source: parsed ? 'parsed' : 'conservative' };
    } else {
      // Keep the furthest deadline but refine the window label if the new
      // text is more specific.
      this.limit = { ...this.limit, window: this.limit.window === 'unknown' ? window : this.limit.window };
    }
    if (window === 'weekly') {
      this.windowStartedAt = until;
      this.consumedTokens = 0;
    }
  }

  /** Lazy expiry + window roll before any decision/read. */
  private settle(now: number): void {
    if (this.limit && now >= this.limit.until) {
      this.limit = undefined;
    }
    this.ensureWindow(now);
    this.rollWindow(now);
  }

  /**
   * Tiered admission for a NEW codex conversation (fresh thread). Never
   * called for resumed turns — running work is untouchable by design.
   */
  checkFreshSession(input: { nonInteractive: boolean }): CodexFreshSessionAdmission {
    const now = this.now();
    this.settle(now);
    if (this.limit) {
      const resetAt = this.limit.resetAt ?? this.limit.until;
      return {
        decision: 'degrade',
        resetAt,
        reason:
          `Codex ${WINDOW_LABEL[this.limit.window]}额度已用尽（上游撞限实证${this.limit.source === 'conservative' ? '；未解析到重置时刻，按保守冷却估计' : ''}），` +
          `预计 ${formatTime(resetAt)} 重置，此前新会话暂缓。运行中的回合不受影响；窗口重置后重发消息即可恢复。` +
          '如已配置其它 agentBackend，可临时切换使用。',
      };
    }
    if (!this.estimationEnabled || this.weeklyBudgetTokens === undefined) {
      return { decision: 'allow' };
    }
    const budget = this.weeklyBudgetTokens;
    const remaining = Math.max(0, budget - this.consumedTokens);
    const ratio = remaining / budget;
    const windowResetsAt = (this.windowStartedAt ?? now) + CODEX_WEEKLY_WINDOW_MS;
    if (ratio <= this.blockThreshold) {
      return {
        decision: 'degrade',
        resetAt: windowResetsAt,
        reason:
          `Codex 周额度估计余量不足（剩余约 ${formatTokens(remaining)}/${formatTokens(budget)} tokens，` +
          `${Math.round(ratio * 100)}%——估计值，仅统计本进程消耗）。为避免任务中途撞限，新会话暂缓；` +
          `预计窗口重置约 ${formatTime(windowResetsAt)}。如已配置其它 agentBackend，可临时切换使用。`,
      };
    }
    if (ratio <= this.tightenThreshold && input.nonInteractive) {
      const reason =
        `周额度估计余量 ${Math.round(ratio * 100)}%（≤收紧阈值 ${Math.round(this.tightenThreshold * 100)}%，` +
        `估计值——仅统计本进程消耗），非交互新会话本轮跳过；窗口重置约 ${formatTime(windowResetsAt)}`;
      this.lastSkip = { at: now, reason };
      return { decision: 'skip', resetAt: windowResetsAt, reason };
    }
    return { decision: 'allow' };
  }

  snapshot(): CodexWeeklyQuotaSnapshot {
    const now = this.now();
    this.settle(now);
    const windowStartedAt = this.windowStartedAt ?? now;
    const snapshot: CodexWeeklyQuotaSnapshot = {
      estimationEnabled: this.estimationEnabled,
      consumedTokens: this.consumedTokens,
      limitLatched: this.limit !== undefined,
      windowStartedAt: this.windowStartedAt,
      windowResetsAt: this.limit?.until ?? windowStartedAt + CODEX_WEEKLY_WINDOW_MS,
    };
    if (this.weeklyBudgetTokens !== undefined) {
      snapshot.weeklyBudgetTokens = this.weeklyBudgetTokens;
      snapshot.remainingTokens = Math.max(0, this.weeklyBudgetTokens - this.consumedTokens);
      snapshot.remainingRatio = snapshot.remainingTokens / this.weeklyBudgetTokens;
    }
    if (this.limit) {
      snapshot.limitWindow = this.limit.window;
      snapshot.limitResetAt = this.limit.resetAt ?? this.limit.until;
      snapshot.limitSource = this.limit.source;
    }
    if (this.lastSkip) { snapshot.lastSkip = { ...this.lastSkip }; }
    return snapshot;
  }

  /** Human-readable /status lines. Every estimate is labeled as one. */
  formatStatusLines(): string[] {
    const snapshot = this.snapshot();
    const lines: string[] = [];
    if (snapshot.estimationEnabled && snapshot.weeklyBudgetTokens !== undefined && snapshot.remainingTokens !== undefined) {
      lines.push(
        `🪙 Codex 周额度（估计）：预算 ${formatTokens(snapshot.weeklyBudgetTokens)} tokens/周，` +
        `本进程已观测 ${formatTokens(snapshot.consumedTokens)}（估计，仅本进程累计），` +
        `剩余约 ${formatTokens(snapshot.remainingTokens)}（${Math.round((snapshot.remainingRatio ?? 0) * 100)}%，估计）`
      );
    } else {
      lines.push(
        `🪙 Codex 周额度：观测模式（未配置 agent.codex.weeklyBudgetTokens），本进程累计 ${formatTokens(snapshot.consumedTokens)} tokens`
      );
    }
    if (snapshot.limitLatched && snapshot.limitResetAt !== undefined) {
      lines.push(
        `⛔ 撞限校准：上游实证${snapshot.limitWindow === 'weekly' ? '周' : snapshot.limitWindow === 'five-hour' ? '5 小时' : '周期'}额度已用尽` +
        `（${snapshot.limitSource === 'conservative' ? '未解析到重置时刻，按保守冷却' : '按上游重置提示'}），` +
        `预计 ${formatTime(snapshot.limitResetAt)} 重置——重置前新会话准入受限`
      );
    }
    if (snapshot.lastSkip) {
      lines.push(`⏭️ 最近一次收紧跳过：${formatTime(snapshot.lastSkip.at)} —— ${snapshot.lastSkip.reason}`);
    }
    return lines;
  }
}
