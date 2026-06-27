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
import { adaptSDKMessage, adaptUserInput } from './message-adapter.js';
import { adaptOptions } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ClaudeSDKProvider');

// ============================================================================
// D3: system-message flood termination (Issue #3706)
// ============================================================================
// Under GLM account-level rate-limiting (1302) an agent stream gets stuck
// emitting empty `thinking_tokens` system messages for hours, saturating the
// event loop. D3 stops the stream once the consecutive-empty count exceeds the
// (configurable) warn threshold by this delta. Kept as a delta — not an
// absolute — so it always tracks DISCLAUDE_SYSTEM_FLOOD_THRESHOLD and never
// terminates before warning. Healthy tasks peak around ~36 (measured), so the
// default warn(50)+delta(50)=terminate(100) gives ~2.8× margin.
const SYSTEM_FLOOD_TERMINATE_DELTA = 50;
const SYSTEM_FLOOD_TERMINATE_NOTICE =
  '⚠️ 上游模型限流，已自动取消本次响应以避免卡死，请稍后重试。';

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
    async function* adaptInputStream(): AsyncGenerator<SDKUserMessage> {
      // Manual iteration - only pull one value at a time
      const iterator = input[Symbol.asyncIterator]();
      while (true) {
        const { value, done } = await iterator.next();
        if (done) {
          return;
        }
        inputCount++;
        logger.info({ inputCount, contentLength: value.content?.length }, 'Input received');
        yield adaptUserInput(value);
      }
    }

    const queryResult = query({
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
      try {
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
        // D3: 终止阈值 = warn 阈值 + delta(始终 > warn,跟随可配置的 warn)。
        const SYSTEM_FLOOD_TERMINATE_THRESHOLD = SYSTEM_FLOOD_THRESHOLD + SYSTEM_FLOOD_TERMINATE_DELTA;
        const model = options.model as string | undefined;

        for await (const message of queryResult) {
          const now = Date.now();
          messageCount++;
          // 提前适配,使日志与检测均能复用(D1:保留 system subtype 到 metadata 供诊断)
          const adapted = adaptSDKMessage(message);
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
          // 空的 system 消息连续累积 → D2 在 SYSTEM_FLOOD_THRESHOLD 发诊断 warn,
          // D3 在 SYSTEM_FLOOD_TERMINATE_THRESHOLD 终止流,避免洪流持续数小时拖垮事件循环(Issue #3706)。
          if (adapted.role === 'system' && !adapted.content) {
            consecutiveEmptySystemCount++;
            if (adapted.metadata?.systemSubtype) {
              lastSystemSubtype = adapted.metadata.systemSubtype;
            }
            // D2: 诊断 warn(只触发一次)。
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
                + 'D3 will terminate the stream at the higher threshold. See Issue #3706.'
              );
            }
            // D3: 到达终止阈值 → 停掉流,把洪流约束在秒级(否则会跑数小时,拖垮事件循环)。
            if (consecutiveEmptySystemCount >= SYSTEM_FLOOD_TERMINATE_THRESHOLD) {
              logger.error(
                { messageCount, consecutiveEmptySystemCount, model, lastSystemSubtype },
                `System-message flood reached terminate threshold (${SYSTEM_FLOOD_TERMINATE_THRESHOLD}); `
                + 'stopping stream (D3) to free the event loop and unblock the chat.'
              );
              try {
                // interrupt() = SDK 的「停止当前任务」;不调 close()(会杀子进程,交给
                // ChatAgent 正常 teardown 的 handle.close() 去做,避免重复清理)。
                await queryResult.interrupt();
              } catch (interruptErr) {
                logger.warn(
                  { err: interruptErr },
                  'D3: queryResult.interrupt() rejected; yielding terminal result anyway'
                );
              }
              // 合成一条带 terminatedReason 标记的 result,复用 ChatAgent 完成路径;
              // content 携带用户可见提示,由通用 content-send 块投递一次。
              yield {
                type: 'result',
                content: SYSTEM_FLOOD_TERMINATE_NOTICE,
                role: 'system',
                metadata: { terminatedReason: 'system_flood' },
              };
              return;
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

          yield adapted;
        }
        // Issue #3003: log iterator completion timing
        const totalMs = Date.now() - queryStartMs;
        logger.info(
          { totalMs, messageCount, ttftMs: firstMessageMs ? firstMessageMs - queryStartMs : undefined },
          'SDK iterator completed'
        );
      } catch (error) {
        // Issue #2920: 将捕获的 stderr 附加到 error 对象
        if (stderrCapture.hasContent()) {
          attachStderrToError(error, stderrCapture.getCaptured());
        }
        logger.error(
          { err: error, messageCount, stderr: stderrCapture.hasContent() ? stderrCapture.getTail() : '(no stderr)' },
          'adaptIterator error'
        );
        throw error;
      } finally {
        // Issue #3378: Clean up SDK-registered process listeners after query completes.
        // This prevents listener accumulation across multiple queries in long-running
        // processes (e.g., integration test server).
        cleanupListeners();
      }
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
