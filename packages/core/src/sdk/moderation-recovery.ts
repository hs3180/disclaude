/**
 * Shared Z.ai content-moderation failure classification and recovery policy
 * (Issue #5463, rework round 1).
 *
 * The original 2026-10-20 incident ran on the NON-codex path: the claude
 * backend talking to an Anthropic-compatible gateway (`ANTHROPIC_BASE_URL`,
 * e.g. Z.ai), where the CLI burned its retries on the deterministic `[1301]`
 * verdict and surfaced a raw `turn_failed` result. Round 1 landed the
 * classification + degradation ladder only in the codex provider; this module
 * is the harness-agnostic core both providers share:
 *
 * - `readContentModerationFailure` — the deterministic `[1301]` signature and
 *   nothing else. Capacity, usage-limit and output-cap 4xx failures stay in
 *   their own classes and never enter this one.
 * - `readModerationRecoveryPolicy` — fallback-model chain + per-chat hourly
 *   admission cap, read from provider-scoped env names.
 * - `ModerationRecoveryLimiter` — provider-instance rolling window; every
 *   attempt for one chat message shares a single budget.
 *
 * Guardrail contract shared by every consumer: replays carry the ORIGINAL
 * payload unmodified (no trimming, no sensitive-word splitting, no
 * rewriting), each replay still passes the target model's own review, a
 * repeat verdict terminates the ladder at once, and past the hourly cap only
 * the structured explanation is emitted. The ladder is containment for
 * false positives, never a review-bypass channel.
 */

/** Confirmed upstream content-review failures; never transport uncertainty. */
export interface ContentModerationFailure {
  code: '1301';
  message: string;
}

/** Z.ai's deterministic review verdict. Other 4xx failures stay in their own classes. */
export function readContentModerationFailure(value: unknown): ContentModerationFailure | undefined {
  if (typeof value === 'string') {
    return /\[1301\]/.test(value) ? { code: '1301', message: value } : undefined;
  }
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const error = value as Record<string, unknown>;
  const message = typeof error.message === 'string' ? error.message : '';
  const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
  if (!/\[1301\]/.test(`${message}\n${details}`)) {
    return undefined;
  }
  return { code: '1301', message: `${message}${details ? `\n${details}` : ''}` };
}

export interface ModerationRecoveryPolicy {
  /** Ordered wire model IDs. Empty means clean-session retry only. */
  fallbackModels: string[];
  /** Automatic recoveries admitted per chat in a rolling hour; zero disables them. */
  maxPerChatPerHour: number;
}

/** Env variable names a provider reads its policy from (scoped per harness). */
export interface ModerationRecoveryPolicyEnvNames {
  fallbackModels: string;
  maxPerChatPerHour: string;
}

export function readModerationRecoveryPolicy(
  env: Record<string, string | undefined> = process.env,
  configured: Partial<ModerationRecoveryPolicy> = {},
  names: ModerationRecoveryPolicyEnvNames = {
    fallbackModels: 'DISCLAUDE_MODERATION_FALLBACK_MODELS',
    maxPerChatPerHour: 'DISCLAUDE_MODERATION_MAX_PER_CHAT_PER_HOUR',
  }
): ModerationRecoveryPolicy {
  const envModels = env[names.fallbackModels]?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const rawLimit = env[names.maxPerChatPerHour];
  const parsedLimit = rawLimit === undefined ? undefined : Number(rawLimit);
  return {
    fallbackModels: [...new Set(envModels ?? configured.fallbackModels ?? [])],
    maxPerChatPerHour:
      parsedLimit !== undefined && Number.isSafeInteger(parsedLimit) && parsedLimit >= 0
        ? parsedLimit
        : (configured.maxPerChatPerHour ?? 2),
  };
}

/** Provider-instance rolling limiter: all attempts for one chat share one budget. */
export class ModerationRecoveryLimiter {
  private readonly admitted = new Map<string, number[]>();

  tryAcquire(chatId: string, policy: ModerationRecoveryPolicy, now = Date.now()): boolean {
    const recent = (this.admitted.get(chatId) ?? []).filter((time) => now - time < 3_600_000);
    if (recent.length >= policy.maxPerChatPerHour) {
      this.admitted.set(chatId, recent);
      return false;
    }
    recent.push(now);
    this.admitted.set(chatId, recent);
    return true;
  }
}
