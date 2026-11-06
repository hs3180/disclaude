/**
 * Shared Z.ai content-moderation failure classification (Issue #5463).
 *
 * The original 2026-10-20 incident ran on the NON-codex path: the claude
 * backend talking to an Anthropic-compatible gateway (`ANTHROPIC_BASE_URL`,
 * e.g. Z.ai), where the CLI burned its retries on the deterministic `[1301]`
 * verdict and surfaced a raw `turn_failed` result. Round 1 answered with an
 * automatic degradation ladder (clean-session replay, fallback model chain,
 * hourly limiter). Maintainer review (2026-11-06, PR #5694) redirected the
 * design: 「这种情况自动恢复很难 不如给用户更清晰的提示如何 reset 如何切换
 * model 而不是盲目重试」 — the ladder is REMOVED; what stays is exactly this
 * classification, so a deterministic review verdict:
 *
 * - is its own failure class (`content_moderation [1301]`), never confused
 *   with capacity/overload/output-cap failures;
 * - is never retried or replayed anywhere (the same request would fail
 *   identically; replays could also become a review-bypass channel — no
 *   payload is ever trimmed or split);
 * - ends in a structured explanation card at the host (`chat-agent.ts`
 *   `turn_failed` branch) with the diagnostic ID and concrete `/reset` and
 *   `/agent use` guidance, instead of the generic ❌ provider-failure card.
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

/**
 * The text channels a terminal failure result exposes at the host: the
 * adapter-mapped `content` (is_error result text / `error_during_execution`
 * errors), the provider's `terminationDetail`, and stderr-derived upstream
 * evidence. Scan each before concluding the verdict is NOT a review rejection.
 */
export interface TerminalModerationFields {
  content?: unknown;
  terminationDetail?: unknown;
  upstreamApiErrorStderr?: unknown;
}

/** Classify a terminal `turn_failed` result from its surviving text channels. */
export function readTerminalContentModerationFailure(
  terminal: TerminalModerationFields
): ContentModerationFailure | undefined {
  const texts = [
    terminal.content,
    terminal.terminationDetail,
    terminal.upstreamApiErrorStderr,
  ];
  for (const text of texts) {
    const failure = readContentModerationFailure(text);
    if (failure) {
      return failure;
    }
  }
  return undefined;
}
