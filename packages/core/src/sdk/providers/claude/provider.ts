import { assertToolOptions } from '../../tools.js';
/**
 * Claude SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 Claude Agent SDK 的功能。
 */

import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
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
import { automaticReplayBlock, preventAutomaticReplay } from '../../../utils/replay-safety.js';
import { ClaudeAttemptProcess, type AttemptExit } from './attempt-process.js';
import { Config } from '../../../config/index.js';
import type { BaseAgentConfig } from '../../../agents/types.js';
import { withDiscoveredCompaction } from './compaction.js';
import { buildClaudeDisallowedTools } from './disallowed-tools.js';
import { privateSdkSettings } from './private-settings.js';
import { apiErrorEvidence, ClaudeTranscriptErrors, type ApiErrorEvidence } from './api-error-evidence.js';

const logger = createLogger('ClaudeSDKProvider');

// Issue #4442 (part 3): empty-stream terminal notice. Synthesized when the SDK
// query ends cleanly with ZERO messages (200-OK-zero-content).
const EMPTY_STREAM_TERMINATE_NOTICE =
  '❌ 上游返回了空响应（200 但零内容事件），本次会话未产生任何输出。请稍后重试。';

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
// Prefer structured stream fields, then the current session's new transcript
// API-error records. Stderr signatures remain a legacy fallback. Preserve the
// same classification if the SDK throws after emitting its failed terminal.

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
const UPSTREAM_API_ERROR_RE = /\bserver_overload after retries\b|\boverloaded_error\b|\bAPI Error:\s*\[?\s*5\d{2}\b/i;

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
    const queryId = randomUUID();
    let latestUsage: Pick<NonNullable<AgentMessage['metadata']>,
      'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens' | 'costUsd'> = {};
    let usageLogged = false;
    const logQueryUsage = (): void => {
      if (usageLogged) { return; }
      usageLogged = true;
      logger.info({ event: 'claude_query_usage', queryId, ...latestUsage }, 'Claude SDK-reported usage');
    };
    const privateSettings = privateSdkSettings(native);
    const cleanupPrivateSettings = (): void => {
      try { privateSettings.cleanup(); }
      catch { logger.warn({ cleanupFailed: true }, 'Private Claude SDK settings cleanup failed'); }
    };
    const sdkOptions = privateSettings.options;
    const transcriptErrors = new ClaudeTranscriptErrors();
    let streamedApiError: ApiErrorEvidence | undefined;
    let terminalApiError: ApiErrorEvidence | undefined;
    let terminalApiErrorSource: 'stream' | 'transcript' | undefined;
    const environment = sdkOptions.env as NodeJS.ProcessEnv;
    const claudeConfigDir = resolve(options.cwd ?? process.cwd(), environment.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
    // 将 stderr 回调注入 SDK 选项
    const captureStderr = (data: string) => {
      stderrCapture.append(data);
      // 同时调用用户提供的回调（如果有）
      options.stderr?.(data);
    };

    // One logical query owns one SDK query and one input consumer. API retries
    // stay inside that native execution; the host never resubmits the prompt.
    sdkOptions.stderr = captureStderr;
    const nativeProcess = new ClaudeAttemptProcess({ stderr: captureStderr });
    let queryResult: ReturnType<typeof query>;
    let settlement: Promise<AttemptExit> | undefined;
    const stopProcess = (): Promise<AttemptExit> => {
      settlement ??= nativeProcess.stop(() => queryResult?.close?.()).then(exit => {
        const { pid: nativePid, ...details } = exit;
        logger.info({ queryAttempt: 1, nativePid, ...details, scope: 'native-process-and-observed-descendants' },
          'Claude attempt process settled');
        return exit;
      });
      return settlement;
    };
    let inputCount = 0;
    async function* adaptInputStream(): AsyncGenerator<SDKUserMessage> {
      while (!nativeProcess.closed) {
        const { value, done } = await input.next();
        if (done || nativeProcess.closed) { return; }
        inputCount++;
        logger.info({ inputCount, contentLength: value.content?.length }, 'Input received');
        yield adaptUserInput(value);
      }
    }

    let cancelled = false;
    const queryStartMs = Date.now();
    try {
      queryResult = query({
        prompt: adaptInputStream(),
        options: { ...sdkOptions, spawnClaudeCodeProcess: nativeProcess.spawn } as Parameters<typeof query>[0]['options'],
      });
    } catch (error) {
      void stopProcess().finally(() => { cleanupPrivateSettings(); logQueryUsage(); });
      if (!nativeProcess.started) { cleanupPrivateSettings(); }
      cleanupNewProcessListeners(listenerSnapshot);
      throw preventAutomaticReplay(error, 'whole-query-replay-disabled');
    }

    // Issue #3003: Track SDK query timing for diagnostics

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
          if (cancelled) {return;}
          if ('session_id' in message && typeof message.session_id === 'string') {
            transcriptErrors.bindSession(message.session_id, claudeConfigDir, queryStartMs);
          }
          terminalApiError = undefined;
          terminalApiErrorSource = undefined;
          const streamed = apiErrorEvidence(message) ?? ('message' in message ? apiErrorEvidence(message.message) : undefined);
          if (streamed) { streamedApiError = streamed; }
          else if (message.type === 'assistant') { streamedApiError = undefined; }
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
            continue;
          }
          const now = Date.now();
          messageCount++;
          // 提前适配,使日志与检测均能复用(D1:保留 system subtype 到 metadata 供诊断)
          // Issue #4200 part 2: thread the per-query task registry so status-only
          // TaskUpdate calls can recall a label seen on an earlier update.
          const adapted = adaptSDKMessage(message, taskSubjectRegistry);
          if (adapted.type === 'result') {
            const { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd } = adapted.metadata ?? {};
            // SDK result snapshots replace prior turns; never add cumulative usage.
            latestUsage = { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, costUsd };
            adapted.metadata = { ...adapted.metadata, automaticReplayBlocked: 'whole-query-replay-disabled' };
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
          // 空 system 消息超过阈值仅记录现象;工具等待、后台心跳与上游重试都可能产生,不能据此推定根因。
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
                + 'system messages. Possible causes include foreground tools waiting indefinitely, '
                + 'background-task heartbeats, teammate loops, or upstream retries. Check active '
                + 'tool_progress/processes and concrete provider errors before attributing this '
                + 'to rate limits. This warning leaves the stream running. See Issues #5515/#3706.'
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

          // A terminal can precede the transcript flush. Structured API evidence
          // enriches both masked successes and already-failed terminals without
          // changing their existing termination reason.
          if (adapted.type === 'result') {
            const transcript = streamedApiError ? await transcriptErrors.read()
              : await transcriptErrors.readAfterFlush(adapted.metadata?.terminatedReason === 'turn_failed'
                || stderrIndicatesUpstreamApiError(stderrCapture.getCaptured()), () => cancelled);
            const evidence = streamedApiError ?? transcript.error;
            logger.debug({ transcriptState: transcript.state, hasStructuredApiError: Boolean(evidence) }, 'Read current-turn API error evidence');
            const source = streamedApiError ? 'stream' : transcript.error ? 'transcript' : 'stderr';
            terminalApiError = evidence;
            terminalApiErrorSource = evidence ? (streamedApiError ? 'stream' : 'transcript') : undefined;
            if (evidence || (!adapted.metadata?.terminatedReason && stderrIndicatesUpstreamApiError(stderrCapture.getCaptured()))) {
              const tag = evidence ? tagErrorCategory(new Error('Upstream API failure'), evidence) : undefined;
              adapted.metadata = {
                ...(adapted.metadata ?? {}), upstreamApiError: true,
                upstreamApiErrorSource: source,
                ...(tag ? { upstreamApiErrorStatus: tag.status, upstreamApiErrorIsTransient: tag.transient } : {}),
                upstreamApiErrorStderr: tag ? `Upstream API error${tag.status ? ` (HTTP ${tag.status})` : ''}` : stderrCapture.getTail(300),
              };
              logger.warn({ evidenceSource: source, transcriptState: transcript.state,
                apiErrorStatus: tag?.status, apiErrorIsTransient: tag?.transient },
              'Upstream API failure classified');
            }
            streamedApiError = undefined;
            stderrCapture.reset();
          }

          yield adapted;
        }
        if (cancelled) {
          return;
        }
        // Issue #3003: log iterator completion timing
        const totalMs = Date.now() - queryStartMs;
        if (messageCount === 0) {
          const exit = await stopProcess();
          logger.error({ totalMs, model: options.model, partialsObserved, nativePid: exit.pid,
            processStatus: exit.status }, 'SDK query completed with zero messages; whole-query replay is disabled');
          yield { type: 'result', content: EMPTY_STREAM_TERMINATE_NOTICE, role: 'system',
            metadata: { terminatedReason: 'empty-stream', automaticReplayBlocked: 'whole-query-replay-disabled' } };
          return;
        }
        logger.info(
          { totalMs, messageCount, ttftMs: firstMessageMs ? firstMessageMs - queryStartMs : undefined },
          'SDK iterator completed'
        );
        return;
      } catch (error) {
        if (cancelled) {return;}
        // Issue #2920: 将捕获的 stderr 附加到 error 对象
        if (stderrCapture.hasContent()) {
          attachStderrToError(error, stderrCapture.getCaptured());
        }
        // Issue #4192 (L0): classify the error so the structured log (and any
        // downstream handler reading the tagged error) knows the category, e.g.
        // NETWORK/TIMEOUT (transient → retry candidate) vs CONFIG/SDK (not).
        const transcript = terminalApiError ? { state: 'available' as const, error: undefined }
          : await transcriptErrors.readAfterFlush(true, () => cancelled);
        const evidence = streamedApiError ?? transcript.error ?? terminalApiError;
        const evidenceSource = streamedApiError ? 'stream' : transcript.error ? 'transcript' : terminalApiErrorSource;
        const { category: errorCategory, transient: errorTransient, status: errorStatus, source: classificationSource } = tagErrorCategory(error, evidence);
        const exit = await stopProcess();
        if (cancelled) { return; }
        logger.error(
          {
            err: error,
            errorCategory,
            errorTransient,
            errorStatus,
            nativePid: exit.pid,
            processStatus: exit.status,
            classificationSource,
            evidenceSource: evidenceSource ?? classificationSource ?? 'message',
            messageCount,
            stderr: stderrCapture.hasContent() ? stderrCapture.getTail() : '(no stderr)',
          },
          'adaptIterator error'
        );
        throw preventAutomaticReplay(error, automaticReplayBlock(error) ?? 'whole-query-replay-disabled');
      } finally {
        await stopProcess();
        // Issue #3378: Clean up SDK-registered process listeners after query completes.
        // This prevents listener accumulation across multiple queries in long-running
        // processes (e.g., integration test server).
        cleanupListeners();
      }
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
      const stopped = stopProcess();
      if (!nativeProcess.started) { cleanupPrivateSettings(); }
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
        finally { await stopProcess(); cleanupPrivateSettings(); logQueryUsage(); }
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
