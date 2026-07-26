/**
 * Claude SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 Claude Agent SDK 的功能。
 */

import { query, tool, createSdkMcpServer, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  InlineToolDefinition,
  McpServerConfig,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import { adaptSDKMessage, adaptUserInput, TaskSubjectRegistry } from './message-adapter.js';
import { adaptOptions } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';
import { tagErrorCategory } from '../../../utils/error-handler.js';
import { computeBackoffDelay } from '../../../utils/retry.js';

const logger = createLogger('ClaudeSDKProvider');

// ============================================================================
// GLM stall detection (Issue #3706: no-content-progress watchdog)
// ============================================================================
// GLM-5.2 (via LiteLLM) intermittently STALLS on agent requests: it keeps the
// SSE stream open, sends `ping` keepalives, but produces NO `content_block_delta`
// (no text, no thinking) and NO `message_stop` for many minutes, then bursts.
// Detection: an in-flight request (message_start → message_stop) that yields NO
// content_block_delta for STALL_TIMEOUT_MS → stall → interrupt + notify.
//
// This is zero-false-fire: legitimate reasoning streams content_block_delta
// continuously (including thinking deltas), resetting the watchdog; only a true
// stall (zero content_block_delta) lets it fire. The between-request gap
// (message_stop → tool execution → next message_start) is excluded because the
// watchdog is armed only while a request is in-flight.
//
// Requires `includePartialMessages: true` (set in base-agent.ts createSdkOptions)
// so stream_event messages reach adaptIterator.
const STALL_TERMINATE_NOTICE =
  '⚠️ 上游模型响应超时（疑似 stall），已自动取消本次响应。请稍后重试。';

// ============================================================================
// Upstream API error detection (Issue #4322)
// ============================================================================
//
// Symptom: a scheduled-task (or any) turn killed mid-execution by an upstream
// API error (HTTP 500 overloaded_error) is reported as `✅ Complete` — a silent
// failure. Root cause: after the SDK exhausts its built-in retries on an upstream
// overload, it prints the error to stderr but STILL emits a `result` with
// subtype=success (carrying the accumulated usage), so ChatAgent faithfully
// reports ✅ Complete and nothing surfaces the failure.
//
// Fix (part 1, this slice): detect the upstream-API-error signature in the
// stderr captured for the turn and tag the success result's metadata so the
// consumer (ChatAgent) can report ❌ Failed + recordFailure instead of masking
// it. Turn-level retry is a separate, larger follow-up (Issue #4314 / #4192 L2).

/**
 * Stderr signatures that definitively indicate the SDK gave up on an upstream
 * API error during this turn (Issue #4322). Anchored to the markers observed
 * in the glm-5.2 + claude-agent-sdk incident:
 *   - `server_overload after retries` — the SDK's terminal "exhausted retries on
 *     upstream overload" line (unambiguous; a recovered transient would NOT
 *     print "after retries").
 *   - `overloaded_error` — the upstream error type the SDK surfaces.
 *   - `API Error: [5xx` / `API Error: 5xx` — Claude-Code-style failure print.
 *
 * Intentionally conservative: a transient error that the SDK retried and
 * recovered from does not emit "after retries", so this avoids false positives
 * on recovered turns. Broaden in a follow-up if other 5xx shapes appear.
 */
const UPSTREAM_API_ERROR_RE = /server_overload after retries|overloaded_error|API Error:\s*\[?\s*5\d\d/i;

/**
 * True when the captured stderr indicates the turn was killed by an upstream
 * API error (Issue #4322). Exported for unit testing.
 */
export function stderrIndicatesUpstreamApiError(stderr: string): boolean {
  return UPSTREAM_API_ERROR_RE.test(stderr);
}

// ============================================================================
// Process Listener Cleanup (Issue #3378)
// ============================================================================

/**
 * Event names on `process` that the Claude Agent SDK registers listeners for.
 * The SDK accumulates these listeners across queries without proper cleanup,
 * causing MaxListenersExceededWarning after multiple queries.
 */
export const SDK_PROCESS_EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const;

/** Type-safe access to process listeners/off for events not in Node.js typings. */
export type ProcessEventListener = (...args: unknown[]) => void;
const _process = process as unknown as {
  listeners(e: string): ProcessEventListener[];
  off(e: string, fn: ProcessEventListener): void;
};

/**
 * Snapshot of process listeners for a set of events.
 * Used to detect and clean up listeners added by the SDK during a query.
 */
export interface ProcessListenerSnapshot {
  /** Map of event name → set of listener functions at snapshot time */
  listeners: Map<string, Set<ProcessEventListener>>;
}

/**
 * Capture a snapshot of current process listeners for SDK-monitored events.
 * Call this BEFORE invoking `query()` to establish a baseline.
 */
export function snapshotProcessListeners(): ProcessListenerSnapshot {
  const listeners = new Map<string, Set<ProcessEventListener>>();
  for (const event of SDK_PROCESS_EVENTS) {
    listeners.set(event, new Set(_process.listeners(event)));
  }
  return { listeners };
}

/**
 * Remove process listeners that were added AFTER the snapshot was taken.
 *
 * The Claude Agent SDK registers `process.on('exit'|'SIGINT'|'SIGTERM')` handlers
 * during each `query()` call but fails to remove them after the query completes.
 * Over time (e.g., across multiple integration test suites sharing a single server),
 * these listeners accumulate past Node.js's default limit of 10, triggering
 * `MaxListenersExceededWarning` and degrading server performance.
 *
 * This function restores the listener state to what it was before the query,
 * effectively cleaning up the SDK's leaked listeners.
 */
export function cleanupNewProcessListeners(snapshot: ProcessListenerSnapshot): void {
  let cleaned = 0;
  for (const event of SDK_PROCESS_EVENTS) {
    const before = snapshot.listeners.get(event);
    if (!before) { continue; }
    for (const listener of _process.listeners(event)) {
      if (!before.has(listener)) {
        try {
          _process.off(event, listener);
          cleaned++;
        } catch {
          // Ignore errors during cleanup — listener may have already been removed
        }
      }
    }
  }
  if (cleaned > 0) {
    logger.debug({ cleaned }, 'Cleaned up SDK-registered process listeners');
  }
}

// ============================================================================
// Process Listener Baseline (Issue #3745)
// ============================================================================

/**
 * Baseline snapshot captured once at module load time.
 * Used by `forceCleanupLeakedListeners()` to restore listener counts when
 * the per-query snapshot/cleanup mechanism misses leaked listeners.
 */
const baselineSnapshot = snapshotProcessListeners();

/**
 * Forcefully remove all SDK-registered process listeners that have accumulated
 * beyond the baseline captured at module load time.
 *
 * Issue #3745: When agents are created/destroyed in rapid succession (CLI tests,
 * scheduled tasks), the per-query snapshot/cleanup can miss listeners if the
 * iterator's finally block hasn't run by the time the next agent is created.
 * This function provides a process-level ceiling check: if listener counts are
 * elevated, restore them to the baseline.
 *
 * @returns Number of listeners removed, or 0 if no cleanup was needed
 */
export function forceCleanupLeakedListeners(): number {
  const before = process.listenerCount('exit');
  if (before <= (baselineSnapshot.listeners.get('exit')?.size ?? 0)) {
    return 0; // No leak detected
  }
  let cleaned = 0;
  for (const event of SDK_PROCESS_EVENTS) {
    const baseline = baselineSnapshot.listeners.get(event);
    if (!baseline) { continue; }
    for (const listener of _process.listeners(event)) {
      if (!baseline.has(listener)) {
        try {
          _process.off(event, listener);
          cleaned++;
        } catch {
          // Listener may have already been removed
        }
      }
    }
  }
  if (cleaned > 0) {
    logger.info({ cleaned, before, after: process.listenerCount('exit') }, 'Force-cleaned leaked process listeners above baseline');
  }
  return cleaned;
}

/**
 * stderr 捕获器 — 缓冲 Claude Code 进程的 stderr 输出行
 *
 * 当进程因启动阶段错误（MCP 配置错误、认证失败等）退出时，
 * stderr 包含具体的错误原因。捕获器保留最近的输出行，
 * 以便在错误发生时附加到 error 对象上供上层使用。
 *
 * 设计决策：直接保存原始 stderr 文本，不使用 regex 解析。
 * 原因：regex 模式需要针对真实 CLI stderr 验证（见 PR #2933 审查意见），
 * 直接展示原始文本已足够帮助用户诊断问题。
 */
export class StderrCapture {
  private lines: string[] = [];
  private readonly maxLines: number;

  constructor(maxLines = 50) {
    this.maxLines = maxLines;
  }

  /** 接收一行 stderr 输出 */
  append(data: string): void {
    const text = data.trimEnd();
    if (!text) {return;}
    this.lines.push(text);
    // 只保留最近的 maxLines 行
    if (this.lines.length > this.maxLines) {
      this.lines = this.lines.slice(-this.maxLines);
    }
  }

  /** 获取已捕获的全部 stderr 文本 */
  getCaptured(): string {
    return this.lines.join('\n');
  }

  /** 是否有捕获内容 */
  hasContent(): boolean {
    return this.lines.length > 0;
  }

  /** 获取最后 N 行（用于简短错误消息） */
  getTail(maxChars = 500): string {
    const full = this.getCaptured();
    if (full.length <= maxChars) {return full;}
    return `...${  full.slice(-(maxChars - 3))}`;
  }

  /** 重置缓冲区 */
  reset(): void {
    this.lines = [];
  }
}

/**
 * 用于附加到 Error 对象上的 stderr 属性键
 *
 * 使用 Symbol 避免与 Error 对象的标准属性冲突。
 * 外部通过 `getErrorStderr()` 辅助函数读取。
 */
const STDERR_SYMBOL = Symbol('stderr');

/**
 * 将捕获的 stderr 附加到 error 对象上
 */
export function attachStderrToError(error: unknown, stderr: string): void {
  if (error instanceof Error) {
    (error as Error & { [STDERR_SYMBOL]: string })[STDERR_SYMBOL] = stderr;
  }
}

/**
 * 从 error 对象中读取附加的 stderr
 *
 * @returns stderr 字符串或 undefined
 */
export function getErrorStderr(error: unknown): string | undefined {
  if (error instanceof Error) {
    return (error as Error & { [STDERR_SYMBOL]?: string })[STDERR_SYMBOL];
  }
  return undefined;
}

/**
 * 检测是否为启动阶段失败（Issue #2920）
 *
 * 启动失败的特征：
 * - messageCount === 0（没有收到任何 SDK 消息）
 * - 进程在短时间内退出
 *
 * 启动失败不应触发重试/断路器，因为根因通常是配置错误，
 * 重试无法解决。
 *
 * @param messageCount - 已接收的 SDK 消息数
 * @param elapsedMs - 从查询开始到错误发生的时间
 * @returns true 如果判定为启动失败
 */
export function isStartupFailure(messageCount: number, elapsedMs: number): boolean {
  return messageCount === 0 && elapsedMs < 10_000;
}

/**
 * Claude SDK Provider
 *
 * 封装 @anthropic-ai/claude-agent-sdk 的功能，
 * 提供与 IAgentSDKProvider 接口一致的 API。
 */
export class ClaudeSDKProvider implements IAgentSDKProvider {
  readonly name = 'claude';
  readonly version = '0.3.177';

  private disposed = false;

  getInfo(): ProviderInfo {
    const available = this.validateConfig();
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available ? undefined : 'ANTHROPIC_API_KEY not set',
    };
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    // Issue #3378: Snapshot process listeners BEFORE calling SDK query().
    // The SDK registers process.on('exit'|'SIGINT'|'SIGTERM') handlers during
    // each query but fails to clean them up. We restore the baseline after
    // the query completes to prevent listener accumulation.
    const listenerSnapshot = snapshotProcessListeners();

    // Issue #2920: 创建 stderr 捕获器
    const stderrCapture = new StderrCapture();

    const sdkOptions = adaptOptions(options);
    // 将 stderr 回调注入 SDK 选项
    sdkOptions.stderr = (data: string) => {
      stderrCapture.append(data);
      // 同时调用用户提供的回调（如果有）
      options.stderr?.(data);
    };

    // 创建输入适配器生成器
    // IMPORTANT: Use manual iteration instead of `for await...of` to avoid blocking on input
    let inputCount = 0;
    // Issue #4192 (L1): buffer the adapted input so a retried query can replay
    // the full prompt. Populated lazily as the SDK pulls; adaptInputStream()
    // yields the buffer first, then resumes the outer `input` generator.
    const inputBuffer: SDKUserMessage[] = [];
    let inputExhausted = false;
    async function* adaptInputStream(): AsyncGenerator<SDKUserMessage> {
      // Replay buffered input first (retries), then resume the outer generator.
      for (const buffered of inputBuffer) {
        yield buffered;
      }
      if (inputExhausted) {
        return;
      }
      // Manual iteration - only pull one value at a time
      const iterator = input[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await iterator.next();
        if (done) {
          inputExhausted = true;
          return;
        }
        inputCount++;
        const adapted = adaptUserInput(value);
        inputBuffer.push(adapted); // tee for replay on retry
        logger.info({ inputCount, contentLength: value.content?.length }, 'Input received');
        yield adapted;
      }
    }

    // `let` (not const): Issue #4192 (L1) reassigns this on a transient-error
    // retry before the first SDK message. Created eagerly here so handle.close
    // works even before iteration starts.
    let queryResult = query({
      prompt: adaptInputStream(),
      options: sdkOptions as Parameters<typeof query>[0]['options'],
    });

    // Issue #3003: Track SDK query timing for diagnostics
    const queryStartMs = Date.now();

    // 创建消息适配迭代器
    let messageCount = 0;
    // Issue #3378: Track whether listener cleanup has been performed to avoid
    // running it twice (once from iterator finally, once from handle.close).
    let listenersCleanedUp = false;
    const cleanupListeners = () => {
      if (!listenersCleanedUp) {
        listenersCleanedUp = true;
        cleanupNewProcessListeners(listenerSnapshot);
      }
    };

    async function* adaptIterator(): AsyncGenerator<AgentMessage> {
      // ── Issue #3706 (GLM stall): no-content-progress watchdog ──
      // Timeout is read per-call (env DISCLAUDE_STALL_TIMEOUT_MS, default 180s) so
      // tests can set a short value. Declared BEFORE try so catch/finally can access.
      const STALL_TIMEOUT_MS = (() => {
        const env = Number.parseInt(process.env.DISCLAUDE_STALL_TIMEOUT_MS ?? '', 10);
        return Number.isFinite(env) && env > 0 ? env : 180_000;
      })();
      // Grace after interrupt() before force-closing the query, in case interrupt()
      // alone cannot tear down a stalled upstream socket (Issue #3706 review).
      const STALL_FORCE_CLOSE_GRACE_MS = (() => {
        const env = Number.parseInt(process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS ?? '', 10);
        return Number.isFinite(env) && env > 0 ? env : 5_000;
      })();
      // Declared BEFORE try so catch/finally can access them. Armed on
      // message_start, advanced on content_block_delta (any content incl. thinking
      // — so legit reasoning never fires), cleared on message_stop. Fires on the
      // event loop (independent of the for-await being blocked on a stalled stream).
      //
      // Efficiency (review feedback): instead of clearTimeout+setTimeout on every
      // content_block_delta, we only stamp lastProgressMs per delta and run a single
      // timer that fires at lastProgressMs + STALL_TIMEOUT_MS (re-arming at most once
      // per timeout window when it wakes early). The timer is unref'd so a pending
      // watchdog can never keep the process (e.g. once-mode) from exiting.
      let requestInFlight = false;
      let stalled = false;
      let partialsObserved = false; // true once any stream_event is seen (else watchdog is blind)
      let lastProgressMs = 0;
      let contentWatchdog: ReturnType<typeof setTimeout> | null = null;
      let forceCloseTimer: ReturnType<typeof setTimeout> | null = null;
      const armTimer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
        const t = setTimeout(fn, ms);
        (t as unknown as { unref?: () => void }).unref?.();
        return t;
      };
      const clearContentWatchdog = (): void => {
        if (contentWatchdog) { clearTimeout(contentWatchdog); contentWatchdog = null; }
      };
      const clearForceClose = (): void => {
        if (forceCloseTimer) { clearTimeout(forceCloseTimer); forceCloseTimer = null; }
      };
      const fireWatchdog = (): void => {
        if (!requestInFlight || stalled) { return; }
        stalled = true;
        logger.error(
          { messageCount, model: options.model, stallTimeoutMs: STALL_TIMEOUT_MS, apiBaseUrl: options.env?.ANTHROPIC_BASE_URL },
          `GLM stall: no content_block_delta for ${STALL_TIMEOUT_MS}ms during in-flight request; interrupting (Issue #3706)`,
        );
        queryResult.interrupt().catch((e: unknown) => {
          logger.warn({ err: e }, 'stall watchdog: queryResult.interrupt() rejected');
        });
        // Belt-and-suspenders (review feedback): if interrupt() cannot tear down the
        // stalled upstream socket, the for-await would never resume. Force-close the
        // query after a grace so the stream ends instead of hanging for the socket
        // timeout. No-op if interrupt() already ended the stream (finally clears this).
        forceCloseTimer = armTimer(() => {
          forceCloseTimer = null;
          const maybeClose = (queryResult as { close?: () => void }).close;
          if (typeof maybeClose === 'function') {
            try {
              maybeClose.call(queryResult);
              logger.warn(
                { graceMs: STALL_FORCE_CLOSE_GRACE_MS },
                'stall watchdog: stream did not end within grace after interrupt(); force-closed query',
              );
            } catch (e: unknown) {
              logger.warn({ err: e }, 'stall watchdog: queryResult.close() threw');
            }
          }
        }, STALL_FORCE_CLOSE_GRACE_MS);
      };
      const tickWatchdog = (): void => {
        contentWatchdog = null;
        if (!requestInFlight || stalled) { return; }
        // Woke before the window elapsed (content progressed since we scheduled) —
        // re-arm for the remainder so we still fire at lastProgressMs + timeout.
        const elapsed = Date.now() - lastProgressMs;
        if (elapsed < STALL_TIMEOUT_MS) {
          contentWatchdog = armTimer(tickWatchdog, STALL_TIMEOUT_MS - elapsed);
          return;
        }
        fireWatchdog();
      };
      const armContentWatchdog = (): void => {
        clearContentWatchdog();
        contentWatchdog = armTimer(tickWatchdog, STALL_TIMEOUT_MS);
      };

      // Issue #4192 (L1): retry the query on a transient error that occurs
      // BEFORE any SDK message is yielded (messageCount === 0) — nothing has
      // been emitted to the consumer, so a retry can safely replay the buffered
      // input without duplicating output or re-running tool side effects. Backoff
      // uses the centralized computeBackoffDelay (#4227). At most MAX_QUERY_RETRIES.
      //
      // Issue #4313: MAX_QUERY_RETRIES is operator-tunable via
      // DISCLAUDE_QUERY_MAX_RETRIES (e.g. to retry more before rethrowing when the
      // upstream is flaky — cf. the overloaded_error scenario in #4322). 0
      // disables the in-request retry. Default 2 (preserves prior behavior).
      const MAX_QUERY_RETRIES = (() => {
        const env = Number.parseInt(process.env.DISCLAUDE_QUERY_MAX_RETRIES ?? '', 10);
        return Number.isFinite(env) && env >= 0 ? env : 2;
      })();
      const QUERY_RETRY_TIMING = {
        initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000, jitter: true,
      };
      const delayMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      for (let queryAttempt = 0; ; queryAttempt++) {
        // Per-attempt reset: finally cleared the watchdog timers; counters/flags
        // reset here so each attempt starts clean.
        messageCount = 0;
        partialsObserved = false;
        requestInFlight = false;
        stalled = false;
        lastProgressMs = 0;
        listenersCleanedUp = false;
        if (queryAttempt > 0) {
          // Issue #4322: clear stale stderr from the previous (failed) attempt
          // before recreating the query, so a recovered L1 retry isn't falsely
          // tagged upstreamApiError by the prior attempt's error line. Reset
          // here (not at the top of the loop) so attempt 0's stderr — which may
          // be fed during query() creation, before the loop — is preserved for
          // the catch's attachStderrToError, and so each retry starts clean.
          stderrCapture.reset();
          queryResult = query({
            prompt: adaptInputStream(),
            options: sdkOptions as Parameters<typeof query>[0]['options'],
          });
        }
      try {
        // Issue #4200 part 2: per-query registry of taskId → label, so status-only
        // TaskUpdate calls can recall a subject/activeForm seen on an earlier
        // update. Local to this generator → GC'd when the query stream ends.
        const taskSubjectRegistry = new TaskSubjectRegistry();
        let firstMessageMs: number | undefined;
        // Issue #3706: Track consecutive text-only assistant responses for idle loop detection.
        // When a model fails to emit tool_use blocks, it enters an idle loop producing
        // only text responses. Detect this pattern and warn with diagnostic info.
        let consecutiveTextOnlyCount = 0;
        const IDLE_LOOP_THRESHOLD = 3;
        // 根因记录(Issue #3706 扩展):GLM + Agent Teams (in-process) 的真实 failure mode 是
        // 海量未识别的空 system 消息(task_started/task_progress/teammate_* 等),而非 assistant
        // text。现有 assistant-text 检测对它无效,故补充 system-message flood 检测。
        let consecutiveEmptySystemCount = 0;
        let lastSystemSubtype: string | undefined;
        // 可经 DISCLAUDE_SYSTEM_FLOOD_THRESHOLD 调节(须为正整数;默认 50,对齐真实
        // Agent Teams flood 量级)。IDLE_LOOP_THRESHOLD 保持硬编码以维持既有行为。
        const envFloodThreshold = Number.parseInt(
          process.env.DISCLAUDE_SYSTEM_FLOOD_THRESHOLD ?? '', 10,
        );
        const SYSTEM_FLOOD_THRESHOLD = Number.isFinite(envFloodThreshold) && envFloodThreshold > 0
          ? envFloodThreshold
          : 50;
        const model = options.model as string | undefined;

        for await (const message of queryResult) {
          // Issue #3706 (stall): handle stream_event (partial) messages for the
          // watchdog ONLY — filter them (not adapted/logged/yielded to ChatAgent).
          // Requires includePartialMessages (set in base-agent createSdkOptions).
          if (message.type === 'stream_event') {
            partialsObserved = true;
            const et = (message as { event?: { type?: string } }).event?.type;
            if (et === 'message_start') {
              requestInFlight = true;
              lastProgressMs = Date.now();
              armContentWatchdog();
            } else if (et === 'content_block_delta') {
              // Real progress (text/thinking/tool_use delta) — advance the deadline.
              // Only a timestamp write (no timer churn); the armed timer fires at
              // lastProgressMs + STALL_TIMEOUT_MS. Thinking deltas count too.
              if (requestInFlight) { lastProgressMs = Date.now(); }
            } else if (et === 'message_stop') {
              requestInFlight = false;
              clearContentWatchdog();
            }
            continue; // filter: partials don't reach ChatAgent
          }
          const now = Date.now();
          messageCount++;
          // 提前适配,使日志与检测均能复用(D1:保留 system subtype 到 metadata 供诊断)
          // Issue #4200 part 2: thread the per-query task registry so status-only
          // TaskUpdate calls can recall a label seen on an earlier update.
          const adapted = adaptSDKMessage(message, taskSubjectRegistry);
          // Issue #3003: log TTFT and per-message elapsed
          if (!firstMessageMs) {
            firstMessageMs = now;
            logger.info(
              { messageCount, messageType: message.type, ttftMs: now - queryStartMs },
              'SDK first message received (TTFT)'
            );
          } else if (message.type === 'assistant') {
            // Log timing for significant messages (not every system message)
            logger.info(
              { messageCount, messageType: message.type, elapsedMs: now - queryStartMs },
              'SDK message received'
            );
          } else {
            // D1:system 消息记录其 subtype,让刷屏的内部协调消息可诊断。
            // 仅对 system 类型附带 systemSubtype,避免在 tool_progress / result 等
            // 非 system 消息上留下恒为 undefined 的字段。
            logger.info(
              {
                messageCount,
                messageType: message.type,
                ...(message.type === 'system' && { systemSubtype: adapted.metadata?.systemSubtype }),
              },
              'SDK message received'
            );
          }

          // Issue #3706: Idle loop detection.
          // Count consecutive assistant messages that produce text only (no tool_use).
          // If this exceeds the threshold, the model may not support tool_use properly.
          if (adapted.type === 'text' && adapted.role === 'assistant' && adapted.content) {
            consecutiveTextOnlyCount++;
            if (consecutiveTextOnlyCount === IDLE_LOOP_THRESHOLD) {
              logger.warn(
                {
                  messageCount,
                  consecutiveTextOnlyCount,
                  model,
                  apiBaseUrl: options.env?.ANTHROPIC_BASE_URL,
                  hasAgentTeams: options.teammateMode !== undefined,
                },
                `Idle loop detected: ${IDLE_LOOP_THRESHOLD}+ consecutive text-only responses `
                + 'without tool_use. The model may not support tool execution. '
                + 'Check model compatibility (e.g., GLM models via Anthropic-compatible API '
                + 'may not emit tool_use blocks for in-process team workers).'
              );
            }
          } else if (adapted.type === 'tool_use') {
            consecutiveTextOnlyCount = 0;
          }

          // 根因记录:system-message flood 检测(GLM + Agent Teams failure mode)。
          // 空的 system 消息连续累积超过阈值 → 判定为 teammate 循环空转,发出诊断 warn。
          // 注意:这是诊断性检测(warn only),不终止流(范围不含 D3 终止防护)。
          if (adapted.role === 'system' && !adapted.content) {
            consecutiveEmptySystemCount++;
            if (adapted.metadata?.systemSubtype) {
              lastSystemSubtype = adapted.metadata.systemSubtype;
            }
            if (consecutiveEmptySystemCount === SYSTEM_FLOOD_THRESHOLD) {
              logger.warn(
                {
                  messageCount,
                  consecutiveEmptySystemCount,
                  model,
                  apiBaseUrl: options.env?.ANTHROPIC_BASE_URL,
                  hasAgentTeams: options.teammateMode !== undefined,
                  lastSystemSubtype,
                },
                `System-message flood detected: ${SYSTEM_FLOOD_THRESHOLD}+ consecutive empty `
                + 'system messages. This typically indicates a teammate (Agent tool) stuck in a '
                + 'loop — commonly caused by upstream rate-limiting (e.g. GLM account 1302) when '
                + 'Agent Teams fans out concurrent requests faster than the model quota allows. '
                + 'The SDK stream will not end until the upstream limit recovers. See Issue #3706.'
              );
            }
          } else if (
            adapted.role !== 'system' &&
            (adapted.content || adapted.type === 'tool_use' || adapted.type === 'result')
          ) {
            // 真实进展(非 system 角色:assistant 内容 / tool_use / result)→ 重置 flood 计数。
            // 注意:只对「非 system 角色」重置 —— system 角色下带 content 的消息(如 status
            // "🤔 Thinking…" / "🔄 Compacting…")仍属 system 通道噪声;若让它参与重置,会把
            // 「空消息 + 偶发 status」交替的 flood 不断清零、永远到不了阈值。
            consecutiveEmptySystemCount = 0;
          }

          // Issue #4322: 上游 API 错误(overloaded_error / 5xx)可能在本轮已流出
          // 部分输出后才杀掉 turn。SDK 把错误打到 stderr 但仍发 subtype=success 的
          // result,下游会静默报 ✅ Complete。若本轮捕获的 stderr 带上游 API 错误
          // 特征,给该 success result 打 upstreamApiError 标记,让 ChatAgent 改报
          // ❌ Failed + recordFailure。不覆盖 stall 合成的 result(terminatedReason)。
          if (
            adapted.type === 'result' &&
            !adapted.metadata?.terminatedReason &&
            stderrCapture.hasContent() &&
            stderrIndicatesUpstreamApiError(stderrCapture.getCaptured())
          ) {
            adapted.metadata = {
              ...(adapted.metadata ?? {}),
              upstreamApiError: true,
              // Surface the stderr tail (carries the upstream request_id) so the
              // consumer can include an actionable reference in the ❌ Failed notice.
              upstreamApiErrorStderr: stderrCapture.getTail(300),
            };
          }

          yield adapted;
        }
        // Issue #3706 (review): if partials never flowed this turn, the watchdog
        // was INACTIVE — surface it so operators know stalls won't be caught (e.g.
        // includePartialMessages ineffective for this provider). This is the
        // self-announcing signal for the live-validation caveat in the PR review.
        if (!partialsObserved && messageCount > 0) {
          logger.error(
            { messageCount, model: options.model, apiBaseUrl: options.env?.ANTHROPIC_BASE_URL },
            'Issue #3706: stream_event partials never observed this turn — no-content-progress '
              + 'watchdog was INACTIVE; GLM stalls will not be caught',
          );
        }
        // Issue #3706 (stall): watchdog fired → yield a terminal result.
        // (Covers the case where interrupt() ended the stream cleanly without throwing.)
        if (stalled) {
          clearContentWatchdog();
          clearForceClose();
          yield {
            type: 'result',
            content: STALL_TERMINATE_NOTICE,
            role: 'system',
            metadata: { terminatedReason: 'stall' },
          };
          return;
        }
        // Issue #3003: log iterator completion timing
        const totalMs = Date.now() - queryStartMs;
        logger.info(
          { totalMs, messageCount, ttftMs: firstMessageMs ? firstMessageMs - queryStartMs : undefined },
          'SDK iterator completed'
        );
        return; // success — exit the retry loop + generator (Issue #4192 L1)
      } catch (error) {
        // Issue #3706 (stall): the watchdog's interrupt() likely threw into the
        // for-await — convert to a clean terminal result instead of propagating the error.
        if (stalled) {
          clearContentWatchdog();
          clearForceClose();
          yield {
            type: 'result',
            content: STALL_TERMINATE_NOTICE,
            role: 'system',
            metadata: { terminatedReason: 'stall' },
          };
          return;
        }
        // Issue #2920: 将捕获的 stderr 附加到 error 对象
        if (stderrCapture.hasContent()) {
          attachStderrToError(error, stderrCapture.getCaptured());
        }
        // Issue #4192 (L0): classify the error so the structured log (and any
        // downstream handler reading the tagged error) knows the category, e.g.
        // NETWORK/TIMEOUT (transient → retry candidate) vs CONFIG/SDK (not).
        const { category: errorCategory, transient: errorTransient } = tagErrorCategory(error);
        // Issue #4192 (L1): retry on a transient error that occurred before the
        // first SDK message was yielded. messageCount === 0 ⇒ nothing was emitted
        // to the consumer, so replaying the buffered input can't duplicate output
        // or re-run tool side effects. `continue` → finally cleans this attempt.
        //
        // Note (review 🟠): messageCount===0 may still have partialsObserved===true
        // (the SDK yielded a message_start but no content/full message before the
        // network reset). Safe for our consumer (nothing emitted); upstream is
        // at-least-once (the request was accepted). For idempotent chat turns this
        // is fine. Tighten to !partialsObserved if at-most-once-upstream is needed.
        if (errorTransient && messageCount === 0 && queryAttempt < MAX_QUERY_RETRIES) {
          // Review 🟡 + 🟠(note 2): best-effort cleanup of the failed attempt's handle
          // before reassigning queryResult on retry (SDK iterator throw doesn't guarantee
          // subprocess/transport teardown — especially on network reset). This also
          // underpins the note-2 single-consumer guarantee: by the time we re-enter the
          // loop and call adaptInputStream() again, the prior attempt's prompt generator
          // is done (its for-await threw → return() ran), so the shared outer `input`
          // iterator has exactly one active consumer and the replayed/buffered pull can't
          // race the abandoned one.
          try { queryResult.close?.(); } catch { /* best-effort */ }
          logger.warn(
            { queryAttempt: queryAttempt + 1, err: error, errorCategory },
            'Transient error before first SDK message — retrying query (Issue #4192 L1)',
          );
          await delayMs(computeBackoffDelay(queryAttempt, QUERY_RETRY_TIMING));
          continue;
        }
        logger.error(
          {
            err: error,
            errorCategory,
            errorTransient,
            messageCount,
            stderr: stderrCapture.hasContent() ? stderrCapture.getTail() : '(no stderr)',
          },
          'adaptIterator error'
        );
        throw error;
      } finally {
        clearContentWatchdog();
        clearForceClose();
        // Issue #3378: Clean up SDK-registered process listeners after query completes.
        // This prevents listener accumulation across multiple queries in long-running
        // processes (e.g., integration test server).
        cleanupListeners();
      }
      } // end Issue #4192 (L1) retry loop
    }

    return {
      handle: {
        close: () => {
          if ('close' in queryResult && typeof queryResult.close === 'function') {
            queryResult.close();
          }
          // Issue #3378: Also clean up listeners when handle is explicitly closed,
          // in case the iterator wasn't fully consumed.
          cleanupListeners();
        },
        cancel: () => {
          if ('cancel' in queryResult && typeof queryResult.cancel === 'function') {
            queryResult.cancel();
          }
          // Issue #3378: Clean up listeners on cancel as well.
          cleanupListeners();
        },
        sessionId: undefined,
      },
      iterator: adaptIterator(),
    };
  }

  createInlineTool(definition: InlineToolDefinition): unknown {
    return tool(
      definition.name,
      definition.description,
      definition.parameters as unknown as Parameters<typeof tool>[2],
      definition.handler
    );
  }

  createMcpServer(config: McpServerConfig): unknown {
    if (config.type === 'inline') {
      const tools = (config.tools?.map(t => this.createInlineTool(t)) ?? []) as Parameters<typeof createSdkMcpServer>[0]['tools'];
      return createSdkMcpServer({
        name: config.name,
        version: config.version,
        tools,
      });
    }

    // stdio 模式不支持通过此方法创建
    throw new Error('stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer');
  }

  validateConfig(): boolean {
    // 检查 API 密钥是否配置
    return !!process.env.ANTHROPIC_API_KEY;
  }

  dispose(): void {
    this.disposed = true;
  }
}
