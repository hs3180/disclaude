/**
 * Codex-scoped re-export of the shared Z.ai `[1301]` content-moderation
 * classification and recovery policy (Issue #5463, rework round 1).
 *
 * Round 1 implemented the classification + degradation ladder inside this
 * provider; the rework moved the harness-agnostic core to
 * `packages/core/src/sdk/moderation-recovery.ts` so the claude backend (the
 * original incident harness) can reuse it. This shim keeps the public
 * `Codex*` names and the `DISCLAUDE_CODEX_MODERATION_*` env contract
 * unchanged — codex behavior is preserved verbatim, no re-classification
 * through the generic `DISCLAUDE_MODERATION_*` names.
 */

import {
  ModerationRecoveryLimiter,
  readContentModerationFailure,
  readModerationRecoveryPolicy,
  type ContentModerationFailure,
  type ModerationRecoveryPolicy,
} from '../../moderation-recovery.js';

export type CodexContentModerationFailure = ContentModerationFailure;
export type CodexModerationRecoveryPolicy = ModerationRecoveryPolicy;
export { ModerationRecoveryLimiter as CodexModerationRecoveryLimiter };
export { readContentModerationFailure as readCodexContentModerationFailure };

export function readCodexModerationRecoveryPolicy(
  env: Record<string, string | undefined> = process.env,
  configured: Partial<CodexModerationRecoveryPolicy> = {}
): CodexModerationRecoveryPolicy {
  return readModerationRecoveryPolicy(env, configured, {
    fallbackModels: 'DISCLAUDE_CODEX_MODERATION_FALLBACK_MODELS',
    maxPerChatPerHour: 'DISCLAUDE_CODEX_MODERATION_MAX_PER_CHAT_PER_HOUR',
  });
}
