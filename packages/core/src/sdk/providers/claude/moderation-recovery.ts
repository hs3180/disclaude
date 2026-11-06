/**
 * Claude-harness degradation ladder for Z.ai `[1301]` content-moderation
 * false positives (Issue #5463, rework round 1).
 *
 * This provider IS the original incident path: the claude backend drives the
 * Claude Agent SDK against an Anthropic-compatible gateway
 * (`ANTHROPIC_BASE_URL`, e.g. Z.ai), and on 2026-10-20 the gateway's
 * deterministic `[1301]` verdict killed a benign turn — the SDK burned ~40 s
 * retrying the verdict, then the host surfaced the raw `turn_failed` result
 * (`message-adapter.ts` maps `is_error` / `error_during_execution` results to
 * `terminatedReason: 'turn_failed'`; `chat-agent.ts` turns that into the
 * generic ❌ provider-turn-failed card). Round 1 landed the ladder only in
 * the codex provider; this wrapper brings the shared classification and
 * ladder (see `sdk/moderation-recovery.ts`) onto that incident path:
 *
 * 1. classify — a `turn_failed` terminal carrying the `[1301]` signature is
 *    `content_moderation`, distinct from overload/transport failures (which
 *    keep today's behavior untouched).
 * 2. degrade — replay the ORIGINAL, unmodified turn inputs in a clean
 *    one-shot session (a fresh `query()` with no conversation history) on
 *    the same model; on a repeat verdict, once more on the first configured
 *    fallback model. Each replay is submitted verbatim — no trimming, no
 *    sensitive-word splitting, no rewriting — and passes the target model's
 *    own review. A second verdict on the fallback model terminates at once.
 * 3. preserve — the original long-lived conversation stream keeps running;
 *    after a recovery, later turns resume it, replay messages re-anchor to
 *    the conversation's session id, and the user gets a completion note.
 * 4. contain — turns that already produced tool calls or visible output are
 *    never replayed (side-effect safety), and automatic recoveries are
 *    capped per chat per hour; past the cap (or when every rung fails) only
 *    a structured explanation card is emitted, mirroring the codex ladder.
 */

import { createLogger } from '../../../utils/logger.js';
import type { AgentMessage, AgentQueryOptions, StreamQueryResult, UserInput } from '../../types.js';
import {
  ModerationRecoveryLimiter,
  readContentModerationFailure,
  readModerationRecoveryPolicy,
  type ContentModerationFailure,
} from '../../moderation-recovery.js';

const logger = createLogger('ClaudeModerationRecovery');

/**
 * Z.ai's `[1301]` verdict as it survives the Claude SDK's failed terminal:
 * the adapter drops the raw error into `content` (is_error result text /
 * `error_during_execution` errors), and the provider may add stderr-derived
 * evidence — scan every text channel before concluding.
 */
export function readResultContentModerationFailure(
  message: AgentMessage
): ContentModerationFailure | undefined {
  if (message.type !== 'result' || message.metadata?.terminatedReason !== 'turn_failed') {
    return undefined;
  }
  const raw = message.raw as { result?: unknown; errors?: unknown } | undefined;
  const texts: unknown[] = [
    message.content,
    message.metadata.terminationDetail,
    message.metadata.upstreamApiErrorStderr,
    typeof raw?.result === 'string' ? raw.result : undefined,
    Array.isArray(raw?.errors)
      ? raw.errors.filter((entry): entry is string => typeof entry === 'string').join('\n')
      : undefined,
  ];
  for (const text of texts) {
    const failure = readContentModerationFailure(text);
    if (failure) {
      return failure;
    }
  }
  return undefined;
}

/** A failed turn that already emitted observable work must never be replayed. */
function marksAttemptUnsafe(message: AgentMessage): boolean {
  return (
    message.type === 'tool_use' ||
    message.type === 'tool_progress' ||
    message.type === 'tool_result' ||
    (message.type === 'text' && message.role === 'assistant' && message.content.length > 0)
  );
}

/** Ladder state for one chat message, mirroring the codex provider's shape. */
interface ModerationLadderState {
  nextModel: string | undefined;
  inFallback: boolean;
  attemptedModels: string[];
  cleanSessionAttempts: number;
}

/**
 * Wrap a long-lived conversation stream with the moderation ladder. `start`
 * launches one provider attempt (the original conversation, or a clean
 * one-shot replay); the wrapper owns turn bookkeeping and never re-wraps a
 * replay attempt. Cancellation propagates to every live attempt.
 */
export function withModerationRecovery<T extends AgentQueryOptions>(
  input: AsyncGenerator<UserInput>,
  options: T,
  start: (input: AsyncGenerator<UserInput>, options: T) => StreamQueryResult,
  limiter: ModerationRecoveryLimiter
): StreamQueryResult {
  const policy = readModerationRecoveryPolicy({ ...process.env, ...options.env });
  const abort = new AbortController();
  const aborted = new Promise<void>((resolve) =>
    abort.signal.addEventListener('abort', () => resolve(), { once: true })
  );
  // Start the conversation attempt EAGERLY, exactly like the unwrapped
  // provider: the SDK query() call (and its subprocess spawn) happens at
  // queryStream() time, not on the first iterator pull — close() before
  // iteration must still settle that process, and a synchronous query()
  // throw must reach the caller as before.
  const main: StreamQueryResult = start(recordedInput(), options);
  let active: StreamQueryResult | undefined = main;
  let turnInputs: UserInput[] = [];
  let ladder: ModerationLadderState | undefined;
  let recoveryModel: string | undefined;
  let conversationSessionId: string | undefined;

  // Tee the conversation input: every UserInput the (single) SDK consumer
  // pulls is retained verbatim as this turn's replay source.
  async function* recordedInput(): AsyncGenerator<UserInput> {
    for (;;) {
      const { value, done } = await input.next();
      if (done) {
        return;
      }
      turnInputs.push(value);
      yield value;
    }
  }

  const replayInput = (inputs: readonly UserInput[]): AsyncGenerator<UserInput> =>
    (async function* () {
      for (const value of inputs) {
        yield value;
      }
    })();

  const restoreConversationAnchor = (message: AgentMessage): AgentMessage =>
    conversationSessionId !== undefined &&
    message.metadata?.sessionId !== undefined &&
    message.metadata.sessionId !== conversationSessionId
      ? { ...message, metadata: { ...message.metadata, sessionId: conversationSessionId } }
      : message;

  return {
    handle: {
      get inputDelivery() {
        return active?.handle.inputDelivery ?? main?.handle.inputDelivery;
      },
      close() {
        abort.abort();
        main?.handle.close();
        if (active && active !== main) {
          active.handle.close();
        }
      },
      cancel() {
        abort.abort();
        main?.handle.cancel();
        if (active && active !== main) {
          active.handle.cancel();
        }
      },
      get sessionId() {
        return active?.handle.sessionId ?? main?.handle.sessionId;
      },
      async interrupt() {
        abort.abort();
        const targets = [...new Set([main, active])].filter(
          (target): target is StreamQueryResult => target !== undefined
        );
        const results = await Promise.allSettled(
          targets.map((target) => target.handle.interrupt?.() ?? Promise.resolve())
        );
        const rejection = results.find((result) => result.status === 'rejected');
        if (rejection) {
          throw rejection.reason;
        }
      },
    },
    iterator: (async function* (): AsyncGenerator<AgentMessage> {
      try {
        for (;;) {
          // Drive the active attempt until its turn terminal. A manual
          // next() loop (not for-await) — breaking on the terminal must not
          // return() the long-lived conversation iterator.
          let terminal: AgentMessage | undefined;
          let moderation: ContentModerationFailure | undefined;
          let attemptUnsafe = false;
          for (;;) {
            const nextStep = active.iterator.next();
            // A late rejection after an abort already won the race must not
            // surface as an unhandled host crash; the race itself re-raises
            // it whenever the failure settles first.
            nextStep.catch(() => {});
            const step = await Promise.race([nextStep, aborted.then(() => undefined)]);
            if (step === undefined || step.done) {
              terminal = undefined;
              break;
            }
            const message = step.value;
            if (
              conversationSessionId === undefined &&
              typeof message.metadata?.sessionId === 'string' &&
              message.metadata.sessionId
            ) {
              conversationSessionId = message.metadata.sessionId;
            }
            if (message.type === 'result') {
              terminal = message;
              moderation = readResultContentModerationFailure(message);
              break;
            }
            if (marksAttemptUnsafe(message)) {
              attemptUnsafe = true;
            }
            yield active === main ? message : restoreConversationAnchor(message);
          }
          if (terminal === undefined) {
            return;
          }
          if (moderation === undefined) {
            // Not a review verdict: the terminal settles this turn as-is and
            // the original conversation keeps serving later turns.
            if (active !== main) {
              if (!terminal.metadata?.terminatedReason) {
                yield {
                  type: 'status',
                  role: 'system',
                  content: `✅ 上游内容审核未通过后的自动降级已完成：在干净一次性会话中使用模型 ${recoveryModel ?? 'Claude 默认模型'} 正常交付；原聊天上下文保持不变。`,
                };
              }
              yield restoreConversationAnchor(terminal);
              turnInputs = [];
              ladder = undefined;
              recoveryModel = undefined;
              const retired = active;
              active = main;
              // One-shot recovery sessions never outlive their turn — release
              // the replay's native process before resuming the conversation.
              retired.handle.close();
              continue;
            }
            turnInputs = [];
            ladder = undefined;
            yield terminal;
            continue;
          }
          // #5463: a deterministic review verdict never enters backoff — the
          // same request would fail identically later. Walk the ladder.
          const failure = moderation;
          const lastInput = turnInputs[turnInputs.length - 1];
          const diagnosticId = `${lastInput?.correlation?.traceId ?? options.sessionKey ?? 'claude'}:${lastInput?.correlation?.runId ?? 'unknown-turn'}`;
          const chatIdentity = lastInput?.correlation?.chatId ?? options.sessionKey ?? 'claude';
          const settle = (reason: string): AgentMessage => ({
            type: 'result',
            role: 'assistant',
            content:
              '🛡️ 上游内容审核未通过（可能误判）\n' +
              `- 诊断 ID: ${diagnosticId}\n` +
              `- 失败类别: content_moderation [${failure.code}]\n` +
              `- 终止原因: ${reason}\n` +
              `- 已尝试: 原会话${ladder?.cleanSessionAttempts ? ` + ${ladder.cleanSessionAttempts} 次干净会话重放（模型 ${ladder.attemptedModels.join(' → ')}）` : ''}\n` +
              '- 建议: 尝试换一种表述重发，或稍后再试；原会话上下文已保留，无需 /reset。',
            metadata: {
              terminatedReason: 'turn_failed' as const,
              terminationDetail: `content moderation [${failure.code}]: ${reason}; diagnosticId=${diagnosticId}; cleanSessionAttempts=${ladder?.cleanSessionAttempts ?? 0}; attemptedModels=${JSON.stringify(ladder?.attemptedModels ?? [options.model ?? 'claude-default'])}`,
            },
          });
          let replayModel: string | undefined;
          if (attemptUnsafe) {
            yield settle('已发生工具或输出，自动重放可能重复外部副作用，已停止降级');
            ladder = undefined;
          } else if (!turnInputs.length) {
            yield settle('未能取得本回合原始输入，无法原样重放，已停止降级');
            ladder = undefined;
          } else if (!ladder) {
            if (!limiter.tryAcquire(chatIdentity, policy)) {
              yield settle(`本 chat 每小时自动降级次数已达上限 ${policy.maxPerChatPerHour}`);
            } else {
              ladder = {
                nextModel: options.model,
                inFallback: false,
                attemptedModels: [options.model ?? 'claude-default'],
                cleanSessionAttempts: 0,
              };
              replayModel = ladder.nextModel;
            }
          } else if (ladder.inFallback) {
            yield settle('回退模型再次命中同一内容审核判决，已立即终止');
            ladder = undefined;
          } else if (!policy.fallbackModels.length) {
            yield settle('未配置回退模型链');
            ladder = undefined;
          } else {
            const fallbackModel = policy.fallbackModels[0] ?? 'claude-default';
            ladder = {
              ...ladder,
              nextModel: fallbackModel,
              inFallback: true,
              attemptedModels: [...ladder.attemptedModels, fallbackModel],
            };
            replayModel = fallbackModel;
          }
          const recovery = replayModel === undefined ? undefined : ladder;
          if (recovery === undefined) {
            turnInputs = [];
            recoveryModel = undefined;
            if (active !== main) {
              const retired = active;
              active = main;
              retired.handle.close();
            }
            continue;
          }
          if (abort.signal.aborted) {
            return;
          }
          recovery.cleanSessionAttempts += 1;
          recoveryModel = recovery.nextModel;
          const replaySource = [...turnInputs];
          logger.warn(
            {
              sessionKey: options.sessionKey,
              diagnosticId,
              chatId: chatIdentity,
              code: failure.code,
              attempt: recovery.cleanSessionAttempts,
              model: recovery.nextModel ?? 'claude-default',
            },
            'Replaying original Claude input in a clean one-shot session after content-review rejection (#5463)'
          );
          yield {
            type: 'status',
            role: 'system',
            content: `🛡️ 上游内容审核未通过（可能误判），正在干净一次性会话中用模型 ${recovery.nextModel ?? 'Claude 默认模型'} 原样重放本条消息（不裁剪、不拆分）。`,
          };
          if (active !== main) {
            const retired = active;
            active = undefined;
            retired.handle.close();
          }
          active = start(replayInput(replaySource), {
            ...options,
            ...(recovery.nextModel !== undefined ? { model: recovery.nextModel } : {}),
          });
        }
      } finally {
        abort.abort();
        main?.handle.close();
        if (active && active !== main) {
          active.handle.close();
        }
      }
    })(),
  };
}
