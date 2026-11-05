/** Confirmed upstream content-review failures; never transport uncertainty. */
export interface CodexContentModerationFailure {
  code: '1301';
  message: string;
}

/** Z.ai's deterministic review verdict. Other 4xx failures stay in their own classes. */
export function readCodexContentModerationFailure(
  value: unknown
): CodexContentModerationFailure | undefined {
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

export interface CodexModerationRecoveryPolicy {
  /** Ordered wire model IDs. Empty means clean-session retry only. */
  fallbackModels: string[];
  /** Automatic recoveries admitted per chat in a rolling hour; zero disables them. */
  maxPerChatPerHour: number;
}

export function readCodexModerationRecoveryPolicy(
  env: Record<string, string | undefined> = process.env,
  configured: Partial<CodexModerationRecoveryPolicy> = {}
): CodexModerationRecoveryPolicy {
  const envModels = env.DISCLAUDE_CODEX_MODERATION_FALLBACK_MODELS?.split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const rawLimit = env.DISCLAUDE_CODEX_MODERATION_MAX_PER_CHAT_PER_HOUR;
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
export class CodexModerationRecoveryLimiter {
  private readonly admitted = new Map<string, number[]>();

  tryAcquire(chatId: string, policy: CodexModerationRecoveryPolicy, now = Date.now()): boolean {
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
