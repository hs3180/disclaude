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
// Process Listener Cleanup (Issue #3378)
// ============================================================================

/**
 * Event names on `process` that the Claude Agent SDK registers listeners for.
 * The SDK accumulates these listeners across queries without proper cleanup,
 * causing MaxListenersExceededWarning after multiple queries.
 */
const SDK_PROCESS_EVENTS = ['exit', 'SIGINT', 'SIGTERM'] as const;

/**
 * Snapshot of process listeners for a set of events.
 * Used to detect and clean up listeners added by the SDK during a query.
 */
interface ProcessListenerSnapshot {
  /** Map of event name → array of listener functions at snapshot time */
  listeners: Map<string, Set<(...args: unknown[]) => void>>;
}

/**
 * Capture a snapshot of current process listeners for SDK-monitored events.
 * Call this BEFORE invoking `query()` to establish a baseline.
 */
function snapshotProcessListeners(): ProcessListenerSnapshot {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  for (const event of SDK_PROCESS_EVENTS) {
    // Cast through unknown because Node.js typings don't allow 'exit' as a
    // valid argument to process.listeners() / process.off() — but it works
    // at runtime and is exactly what the SDK registers.
    const current = (process as unknown as { listeners(e: string): ((...args: unknown[]) => void)[] }).listeners(event);
    listeners.set(event, new Set(current));
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
function cleanupNewProcessListeners(snapshot: ProcessListenerSnapshot): void {
  let cleaned = 0;
  for (const event of SDK_PROCESS_EVENTS) {
    const before = snapshot.listeners.get(event);
    if (!before) {continue;}
    const after = (process as unknown as { listeners(e: string): ((...args: unknown[]) => void)[] }).listeners(event);
    for (const listener of after) {
      if (!before.has(listener)) {
        try {
          (process as unknown as { off(e: string, fn: (...args: unknown[]) => void): void }).off(event, listener);
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
// stderr 捕获工具（Issue #2920）
// ============================================================================

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
  readonly version = '0.2.19';

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
        for await (const message of queryResult) {
          const now = Date.now();
          messageCount++;
          // Issue #3003: log TTFT and per-message elapsed
          if (!firstMessageMs) {
            firstMessageMs = now;
            logger.info(
              { messageCount, messageType: message.type, ttftMs: now - queryStartMs },
              'SDK first message received (TTFT)'
            );
          } else if (message.type === 'assistant' || message.type === 'tool_use') {
            // Log timing for significant messages (not every system message)
            logger.info(
              { messageCount, messageType: message.type, elapsedMs: now - queryStartMs },
              'SDK message received'
            );
          } else {
            logger.info(
              { messageCount, messageType: message.type },
              'SDK message received'
            );
          }
          yield adaptSDKMessage(message);
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
