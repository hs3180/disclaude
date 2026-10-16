import { assertToolOptions } from '../../tools.js';
/**
 * Claude SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 Claude Agent SDK 的功能。
 */

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { randomUUID } from 'node:crypto';
import type { ChatAgentHooks, IAgentSDKProvider } from '../../interface.js';
import type {
  AgentMessage,
  AgentQueryOptions,
  ProviderInfo,
  StreamQueryResult,
  UserInput,
} from '../../types.js';
import { adaptSDKMessage, adaptUserInput, TaskSubjectRegistry } from './message-adapter.js';
import { adaptOptions } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';
import { tagErrorCategory } from '../../../utils/error-handler.js';
import { computeBackoffDelay } from '../../../utils/retry.js';
import { Config } from '../../../config/index.js';
import type { BaseAgentConfig } from '../../../agents/types.js';
import { withDiscoveredCompaction } from './compaction.js';
import { buildClaudeDisallowedTools } from './disallowed-tools.js';
import { privateSdkSettings } from './private-settings.js';
import { ClaudeAttemptProcess, type AttemptExit } from './attempt-process.js';
import { claudeReplayBlock, type ClaudeAttemptEvidence } from './replay-admission.js';
import { automaticReplayBlock, preventAutomaticReplay } from '../../../utils/replay-safety.js';
import { ClaudeRetryBudget, claudeRetryPolicy, retryProgressText } from './retry-budget.js';
import { ClaudeAttemptUsage, claudeQueryUsage } from './attempt-usage.js';

const logger = createLogger('ClaudeSDKProvider');

// Issue #4442 (part 3): empty-stream terminal notice. Synthesized when the SDK
// query ends cleanly with ZERO messages (200-OK-zero-content) and the in-request
// retries (below) are exhausted.
const EMPTY_STREAM_TERMINATE_NOTICE =
  '❌ 上游返回了空响应，已停止自动重试。请先核对已有操作和结果，再决定是否继续。';

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

/** Claude-native permissions are intentionally absent from AgentQueryOptions. */
export interface ClaudeQueryOptions extends AgentQueryOptions {
  allowedTools?: string[];
  disallowedTools?: string[];
}

/**
 * Claude SDK Provider
 *
 * 封装 @anthropic-ai/claude-agent-sdk 的功能，
 * 提供与 IAgentSDKProvider 接口一致的 API。
 */
export class ClaudeSDKProvider implements IAgentSDKProvider {
  readonly name = 'claude';
  readonly version = '0.3.263';

  private disposed = false;

  configureChat(hooks: ChatAgentHooks): ChatAgentHooks {
    return {
      ...hooks,
      configureQueryOptions: (options): ClaudeQueryOptions => ({
        ...(hooks.configureQueryOptions?.(options) ?? options),
        disallowedTools: buildClaudeDisallowedTools(),
      }),
    };
  }

  getInfo(config?: BaseAgentConfig): ProviderInfo {
    const reason = this.configurationError(config);
    const available = reason === undefined;
    return {
      name: this.name,
      version: this.version,
      available,
      unavailableReason: available ? undefined : `Claude API configuration is missing or invalid: ${reason}`,
    };
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: ClaudeQueryOptions
  ): StreamQueryResult {
    const { allowedTools, disallowedTools, ...commonOptions } = options;
    assertToolOptions(commonOptions);
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }


    if (options.autoCompactWindow === 'auto') {
      return withDiscoveredCompaction(input, options, (nextInput, nextOptions) =>
        this.queryStream(nextInput, nextOptions), 'streaming');
    }

    // Issue #3378: Snapshot process listeners BEFORE calling SDK query().
    // The SDK registers process.on('exit'|'SIGINT'|'SIGTERM') handlers during
    // each query but fails to clean them up. We restore the baseline after
    // the query completes to prevent listener accumulation.
    const listenerSnapshot = snapshotProcessListeners();

    // Issue #2920: 创建 stderr 捕获器
    const stderrCapture = new StderrCapture();

    const native = adaptOptions(commonOptions, { allowedTools, disallowedTools });
    const retryPolicy = claudeRetryPolicy({ ...process.env, ...(native.env as NodeJS.ProcessEnv) });
    const retryBudget = new ClaudeRetryBudget(retryPolicy);
    const retryEnv = { CLAUDE_CODE_MAX_RETRIES: String(retryPolicy.sdkMaxRetries) };
    native.env = { ...(native.env as NodeJS.ProcessEnv), ...retryEnv };
    const settings = native.settings as { env?: NodeJS.ProcessEnv } | undefined;
    native.settings = { ...settings, env: { ...settings?.env, ...retryEnv } };
    const queryId = randomUUID();
    logger.info({ event: 'claude_retry_policy', queryId, ...retryPolicy,
      nativeAttemptsPerQuery: 1, sdkAttemptsPerApiRequest: retryPolicy.sdkMaxRetries + 1,
      waitBudgetScope: 'per-native-result-turn', prelaunchRetriesCannotCallUpstream: true }, 'Claude retry policy resolved');
    const usageAttempts: ClaudeAttemptUsage[] = [];
    let usageLogged = false;
    const logQueryUsage = (): void => {
      if (usageLogged) { return; }
      usageLogged = true;
      logger.info({ event: 'claude_query_usage', ...claudeQueryUsage(queryId, usageAttempts) }, 'Claude logical query usage estimate');
    };
    const privateSettings = privateSdkSettings(native);
    const cleanupPrivateSettings = (): void => {
      try { privateSettings.cleanup(); }
      catch { logger.warn({ cleanupFailed: true }, 'Private Claude SDK settings cleanup failed'); }
    };
    const sdkOptions = privateSettings.options;
    type Attempt = ClaudeAttemptEvidence & {
      ordinal: number; process: ClaudeAttemptProcess; usage: ClaudeAttemptUsage; failed: boolean;
      sdk?: ReturnType<typeof query>; exit?: Promise<AttemptExit>;
    };
    const captureStderr = (current: Attempt, data: string): void => {
      stderrCapture.append(data);
      if (/\b(?:tool_use|tool_result|PreToolUse|PostToolUse|Executing tool)\b/i.test(data)) { current.toolObserved = true; }
      options.stderr?.(data);
    };
    const createAttempt = (ordinal: number): Attempt => {
      const process = new ClaudeAttemptProcess({ stderr: data => captureStderr(current, data) });
      const usage = new ClaudeAttemptUsage(ordinal);
      usageAttempts.push(usage);
      const current: Attempt = { ordinal, process, usage, failed: false, messages: 0, partials: false, permissionRequests: 0, toolObserved: false,
        inputOffered: false, inputPullPending: false, get processStarted() { return process.started; } };
      return current;
    };
    let attempt = createAttempt(1);
    const stopAttempt = (current: Attempt): Promise<AttemptExit> => {
      current.exit ??= current.process.stop(() => current.sdk?.close?.()).then(exit => {
        const { pid: nativePid, ...settlement } = exit;
        current.usage.finish(current.failed || cancelled || !exit.confirmed);
        logger.info({ queryId, queryAttempt: current.ordinal, nativePid, ...settlement, scope: 'native-process-and-observed-descendants' },
          'Claude attempt process settled');
        logger.info({ event: 'claude_attempt_usage', queryId, nativePid, ...current.usage.snapshot() }, 'Claude attempt usage estimate');
        return exit;
      });
      return current.exit;
    };
    // 创建输入适配器生成器
    // IMPORTANT: Use manual iteration instead of `for await...of` to avoid blocking on input
    let inputCount = 0;
    // Issue #4192 (L1): buffer the adapted input so a retried query can replay
    // the full prompt. Populated lazily as the SDK pulls; adaptInputStream()
    // yields the buffer first, then resumes the outer `input` generator.
    const inputBuffer: SDKUserMessage[] = [];
    let inputExhausted = false;
    async function* adaptInputStream(current: Attempt): AsyncGenerator<SDKUserMessage> {
      // Replay buffered input first (retries), then resume the outer generator.
      for (const buffered of inputBuffer) {
        if (current.process.closed) { return; }
        current.inputOffered = true;
        yield buffered;
      }
      if (inputExhausted) {
        return;
      }
      // Manual iteration - only pull one value at a time
      const iterator = input[Symbol.asyncIterator]();
      while (true) {
        if (current.process.closed) { return; }
        current.inputPullPending = true;
        let next: IteratorResult<UserInput>;
        try { next = await iterator.next(); }
        finally { current.inputPullPending = false; }
        const { value, done } = next;
        if (done) {
          inputExhausted = true;
          return;
        }
        inputCount++;
        const adapted = adaptUserInput(value);
        inputBuffer.push(adapted); // tee for replay on retry
        if (current.process.closed) { return; }
        current.inputOffered = true;
        logger.info({ inputCount, contentLength: value.content?.length }, 'Input received');
        yield adapted;
      }
    }

    // `let` (not const): Issue #4192 (L1) reassigns this on a transient-error
    // retry before the first SDK message. Created eagerly here so handle.close
    // works even before iteration starts.
    let cancelled = false;
    let queryResult: ReturnType<typeof query>;
    const startQuery = (current: Attempt): ReturnType<typeof query> => {
      const nativeOptions = { ...sdkOptions, spawnClaudeCodeProcess: (command: Parameters<ClaudeAttemptProcess['spawn']>[0]) => {
        const child = current.process.spawn(command);
        logger.info({ queryId, queryAttempt: current.ordinal, nativePid: current.process.pid }, 'Claude attempt process started');
        return child;
      },
        stderr: (data: string) => captureStderr(current, data) };
      const permission = sdkOptions.canUseTool as NonNullable<Parameters<typeof query>[0]['options']>['canUseTool'];
      if (permission) {
        Object.assign(nativeOptions, { canUseTool: (...args: Parameters<NonNullable<typeof permission>>) => {
          current.permissionRequests++;
          return permission(...args);
        } });
      }
      current.sdk = query({ prompt: adaptInputStream(current),
        options: nativeOptions as Parameters<typeof query>[0]['options'] });
      return current.sdk;
    };
    try {
      queryResult = startQuery(attempt);
    } catch (error) {
      attempt.failed = true;
      void stopAttempt(attempt).finally(() => { cleanupPrivateSettings(); logQueryUsage(); });
      if (!attempt.process.started) { cleanupPrivateSettings(); }
      cleanupNewProcessListeners(listenerSnapshot);
      throw attempt.process.started || attempt.inputOffered || attempt.inputPullPending
        ? preventAutomaticReplay(error, 'startup-outcome-uncertain') : error;
    }

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
      let partialsObserved = false;
      // Whole-query retry needs positive pre-work evidence and confirmed teardown.
      // SDK/client API retries remain inside the original native execution.
      //
      // Issue #4313: MAX_QUERY_RETRIES is operator-tunable via
      // DISCLAUDE_QUERY_MAX_RETRIES (e.g. to retry more before rethrowing when the
      // upstream is flaky — cf. the overloaded_error scenario in #4322). 0
      // disables the in-request retry. Default 2 (preserves prior behavior).
      const MAX_QUERY_RETRIES = retryPolicy.prelaunchMaxRetries;
      const QUERY_RETRY_TIMING = {
        initialDelayMs: 500, backoffMultiplier: 2, maxDelayMs: 8000, jitter: true,
      };
      const delayMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const reserveRetry = (...args: Parameters<ClaudeRetryBudget['reserve']>) => {
        try { return retryBudget.reserve(...args); }
        catch (error) {
          logger.warn({ event: 'claude_retry_refused', queryId, queryAttempt: attempt.ordinal,
            layer: args[0], attempt: args[1], maxRetries: args[2], requestedWaitMs: args[3], status: args[4],
            reason: error instanceof Error ? error.message : 'retry budget unavailable' }, 'Claude retry denied by shared budget');
          attempt.failed = true; throw preventAutomaticReplay(error, 'retry-budget-exhausted');
        }
      };
      for (let queryAttempt = 0; ; queryAttempt++) {
        if (cancelled) { return; }
        // The previous attempt is settled before the next attempt is created.
        messageCount = 0;
        partialsObserved = false;
        listenersCleanedUp = false;
        if (queryAttempt > 0) {
          // Issue #4322: clear stale stderr from the previous (failed) attempt
          // before recreating the query, so a recovered L1 retry isn't falsely
          // tagged upstreamApiError by the prior attempt's error line. Reset
          // here (not at the top of the loop) so attempt 0's stderr — which may
          // be fed during query() creation, before the loop — is preserved for
          // the catch's attachStderrToError, and so each retry starts clean.
          stderrCapture.reset();
          attempt = createAttempt(queryAttempt + 1);
        }
      try {
        if (queryAttempt > 0) { queryResult = startQuery(attempt); }
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
          if (cancelled) {return;}
          try {
            options.onActivity?.(message.type === 'stream_event'
              ? `claude:${message.event.type}`
              : `claude:${message.type === 'system' ? message.subtype : message.type}`);
          } catch {
            logger.debug('Host activity observer failed');
          }
          // Partial stream events are provider-internal and are not user messages.
          // Claude SDK/CLI owns stream-level retry and liveness; disclaude must not
          // terminate a turn merely because content deltas pause during backoff.
          if (message.type === 'stream_event') {
            partialsObserved = true;
            attempt.partials = true;
            continue;
          }
          const now = Date.now();
          messageCount++;
          attempt.messages = messageCount;
          attempt.usage.observe(message);
          const retryProgress = message.type === 'system' && message.subtype === 'api_retry'
            ? reserveRetry('sdk', message.attempt, message.max_retries, message.retry_delay_ms, message.error_status) : undefined;
          // 提前适配,使日志与检测均能复用(D1:保留 system subtype 到 metadata 供诊断)
          // Issue #4200 part 2: thread the per-query task registry so status-only
          // TaskUpdate calls can recall a label seen on an earlier update.
          const adapted = adaptSDKMessage(message, taskSubjectRegistry);
          if (retryProgress) {
            adapted.type = 'status'; adapted.role = 'system'; adapted.content = retryProgressText(retryProgress);
            adapted.metadata = { ...adapted.metadata, retryProgress };
            logger.warn({ event: 'claude_retry_progress', queryId, queryAttempt: attempt.ordinal, ...retryProgress }, 'Claude upstream retry wait');
          }
          if (message.type === 'result') {
            adapted.metadata = { ...adapted.metadata, queryUsage: claudeQueryUsage(queryId, usageAttempts) };
            retryBudget.nextTurn();
          }
          if (adapted.type === 'tool_use') { attempt.toolObserved = true; }
          if (adapted.type === 'result' && (attempt.process.started || attempt.inputOffered)) {
            adapted.metadata = { ...adapted.metadata, automaticReplayBlocked: 'execution-outcome-uncertain' };
          }
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
        if (cancelled) {
          return;
        }
        // Issue #3003: log iterator completion timing
        const totalMs = Date.now() - queryStartMs;
        if (messageCount === 0) {
          const exit = await stopAttempt(attempt);
          const replayBlock = claudeReplayBlock(attempt, exit);
          if (!replayBlock && queryAttempt < MAX_QUERY_RETRIES) {
            logger.warn({ queryAttempt: queryAttempt + 1, totalMs, partialsObserved, nativePid: exit.pid,
              processStatus: exit.status },
            'Issue #4442: SDK query completed with zero messages — retrying confirmed pre-work failure (Issue #4192 L1 budget)');
            const progress = reserveRetry('prelaunch', queryAttempt + 1, MAX_QUERY_RETRIES, computeBackoffDelay(queryAttempt, QUERY_RETRY_TIMING));
            yield { type: 'status', role: 'system', content: retryProgressText(progress), metadata: { retryProgress: progress } };
            await delayMs(progress.delayMs);
            continue;
          }
          logger.error({ totalMs, model: options.model, partialsObserved, replayBlock, nativePid: exit.pid,
            processStatus: exit.status },
          'Issue #4442: SDK query completed with zero messages; automatic retry stopped');
          yield { type: 'result', content: EMPTY_STREAM_TERMINATE_NOTICE, role: 'system',
            metadata: { terminatedReason: 'empty-stream', automaticReplayBlocked: replayBlock ?? 'retry-budget-exhausted' } };
          return;
        }
        logger.info(
          { totalMs, messageCount, ttftMs: firstMessageMs ? firstMessageMs - queryStartMs : undefined },
          'SDK iterator completed'
        );
        return; // success — exit the retry loop + generator (Issue #4192 L1)
      } catch (error) {
        if (cancelled) {return;}
        attempt.failed = true;
        // Issue #2920: 将捕获的 stderr 附加到 error 对象
        if (stderrCapture.hasContent()) {
          attachStderrToError(error, stderrCapture.getCaptured());
        }
        // Issue #4192 (L0): classify the error so the structured log (and any
        // downstream handler reading the tagged error) knows the category, e.g.
        // NETWORK/TIMEOUT (transient → retry candidate) vs CONFIG/SDK (not).
        const { category: errorCategory, transient: errorTransient } = tagErrorCategory(error);
        const exit = await stopAttempt(attempt);
        const replayBlock = claudeReplayBlock(attempt, exit);
        if (cancelled) { return; }
        if (errorTransient && !replayBlock && queryAttempt < MAX_QUERY_RETRIES) {
          logger.warn({ queryAttempt: queryAttempt + 1, err: error, errorCategory,
            nativePid: exit.pid, processStatus: exit.status },
          'Transient pre-work error — retrying query (Issue #4192 L1)');
          const progress = reserveRetry('prelaunch', queryAttempt + 1, MAX_QUERY_RETRIES, computeBackoffDelay(queryAttempt, QUERY_RETRY_TIMING));
          yield { type: 'status', role: 'system', content: retryProgressText(progress), metadata: { retryProgress: progress } };
          await delayMs(progress.delayMs);
          continue;
        }
        logger.error(
          {
            err: error,
            errorCategory,
            errorTransient,
            replayBlock,
            nativePid: exit.pid,
            processStatus: exit.status,
            messageCount,
            stderr: stderrCapture.hasContent() ? stderrCapture.getTail() : '(no stderr)',
          },
          'adaptIterator error'
        );
        throw replayBlock ? preventAutomaticReplay(error, automaticReplayBlock(error) ?? replayBlock) : error;
      } finally {
        await stopAttempt(attempt);
        // Issue #3378: Clean up SDK-registered process listeners after query completes.
        // This prevents listener accumulation across multiple queries in long-running
        // processes (e.g., integration test server).
        cleanupListeners();
      }
      } // end Issue #4192 (L1) retry loop
    }

    let interruptSent = false;
    const cancel = () => {
      cancelled = true;
      if (!interruptSent && typeof queryResult.interrupt === 'function') {
        interruptSent = true;
        try {
          void Promise.resolve(queryResult.interrupt()).catch(() => logger.debug('Interrupt channel closed during cancellation'));
        } catch { logger.debug('Interrupt channel unavailable during cancellation'); }
      }
    };
    const close = (): Promise<AttemptExit> => {
      cancelled = true;
      cleanupListeners();
      const stopped = stopAttempt(attempt);
      if (!attempt.process.started) { cleanupPrivateSettings(); }
      return stopped.finally(() => { cleanupPrivateSettings(); logQueryUsage(); });
    };
    return {
      handle: {
        inputDelivery: 'streaming',
        close: () => { void close(); },
        cancel: () => { cancel(); void close(); },
        interrupt: async () => {
          cancel();
          const exit = await close();
          if (!exit.confirmed) { throw preventAutomaticReplay(new Error('Claude process exit could not be confirmed'), 'process-exit-unconfirmed'); }
        },
        sessionId: undefined,
      },
      iterator: (async function* () {
        try { yield* adaptIterator(); }
        finally { await stopAttempt(attempt); cleanupPrivateSettings(); logQueryUsage(); }
      })(),
    };
  }

  validateConfig(): boolean {
    return this.configurationError() === undefined;
  }

  private configurationError(target?: BaseAgentConfig): string | undefined {
    if (this.disposed) { return 'provider has been disposed'; }
    try {
      const config = target ?? Config.getAgentConfig();
      if (config.apiProtocol && config.apiProtocol !== 'anthropic') {
        return 'Claude requires an Anthropic API connection';
      }
      if (!config.apiKey?.trim()) { return 'the selected LLM API credential is required'; }
      if (!config.model?.trim()) { return 'the selected LLM model is required'; }
      if (config.apiBaseUrl !== undefined) {
        try {
          const url = new URL(config.apiBaseUrl);
          if (!['http:', 'https:'].includes(url.protocol)) { return 'the selected preset apiBaseUrl must use HTTP or HTTPS'; }
        } catch {
          return 'the selected preset apiBaseUrl must be an HTTP or HTTPS URL';
        }
      }
      return undefined;
    } catch {
      return 'check the selected API service credentials, model and endpoint';
    }
  }

  dispose(): void {
    this.disposed = true;
  }
}
