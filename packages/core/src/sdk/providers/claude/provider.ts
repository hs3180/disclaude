/**
 * Claude SDK Provider 实现
 *
 * 实现 IAgentSDKProvider 接口，封装 Claude Agent SDK 的功能。
 *
 * Issue #2920: Enhanced error diagnostics for subprocess startup failures.
 * Captures CLI stderr output and distinguishes startup errors from runtime errors.
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
import { adaptOptions, adaptInput } from './options-adapter.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('ClaudeSDKProvider');

/**
 * Maximum stderr buffer size (64KB).
 * Prevents unbounded memory growth from verbose CLI output.
 */
const MAX_STDERR_LENGTH = 64 * 1024;

/**
 * Create a stderr capture buffer.
 *
 * Returns a callback for the SDK's `stderr` option and methods to
 * access the captured output.
 *
 * Issue #2920: The SDK subprocess's stderr contains detailed startup
 * error information (MCP initialization failures, auth errors, etc.)
 * that is critical for diagnosing startup failures.
 *
 * @returns Object with stderr callback, getter, and clearer
 */
export function createStderrCapture(): {
  /** Callback to pass to SDK's stderr option */
  onStderr: (data: string) => void;
  /** Get the captured stderr output */
  getCapturedStderr: () => string;
  /** Reset the captured stderr buffer */
  reset: () => void;
} {
  let buffer = '';

  return {
    onStderr: (data: string) => {
      // Prevent unbounded growth
      if (buffer.length < MAX_STDERR_LENGTH) {
        buffer += data;
        if (buffer.length > MAX_STDERR_LENGTH) {
          buffer = buffer.slice(-MAX_STDERR_LENGTH);
        }
      }
      // Also log at debug level for real-time diagnostics
      logger.debug({ stderrChunk: data.slice(-200) }, 'SDK stderr output');
    },
    getCapturedStderr: () => buffer,
    reset: () => { buffer = ''; },
  };
}

/**
 * Extract actionable error detail from stderr output.
 *
 * Parses common error patterns from CLI stderr to produce
 * user-friendly error messages.
 *
 * Issue #2920: Instead of showing "Claude Code process exited with code 1",
 * extract specific reasons like "MCP server 'X' 配置错误" or
 * "API 认证失败 (401)".
 *
 * @param stderr - Captured stderr output
 * @param fallbackMessage - Original error message as fallback
 * @returns Extracted actionable error detail
 */
export function extractStartupDetail(stderr: string, fallbackMessage: string): string {
  if (!stderr || stderr.trim().length === 0) {
    return fallbackMessage;
  }

  const lines = stderr.split('\n').filter(l => l.trim());
  // Take the last meaningful lines (errors are typically at the end)
  const tailLines = lines.slice(-10).join('\n');

  // Pattern: MCP server configuration errors
  const mcpMatch = tailLines.match(/MCP server\s+["']?(\S+?)["']?\s*(?:failed|error|config)/i);
  if (mcpMatch) {
    return `MCP server "${mcpMatch[1]}" 配置错误`;
  }

  // Pattern: Authentication failures (401)
  const authMatch = tailLines.match(/(?:authentication|auth|token).*(?:401|expired|invalid)/i)
    || tailLines.match(/(?:401).*(?:token|auth|expired)/i);
  if (authMatch) {
    return 'API 认证失败 (401): 令牌已过期或验证不正确';
  }

  // Pattern: MCP startup timeout
  const timeoutMatch = tailLines.match(/MCP server\s+["']?(\S+?)["']?\s*(?:timeout|timed out)/i);
  if (timeoutMatch) {
    return `MCP server "${timeoutMatch[1]}" 启动超时`;
  }

  // Pattern: command not found / empty command
  const cmdMatch = tailLines.match(/(?:command|spawn).*?(?:empty|undefined|ENOENT)/i);
  if (cmdMatch) {
    return 'MCP 服务器 command 为空或不存在';
  }

  // Pattern: any explicit "Error:" line
  const errorLine = lines.reverse().find(l => /^error:/i.test(l.trim()));
  if (errorLine) {
    // Truncate long error lines
    const msg = errorLine.trim().replace(/^error:\s*/i, '');
    return msg.length > 200 ? `${msg.slice(0, 200)}...` : msg;
  }

  // Fallback: use the last few lines of stderr, truncated
  const summary = tailLines.trim();
  if (summary.length > 300) {
    return summary.slice(-300);
  }
  return summary || fallbackMessage;
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

  async *queryOnce(
    input: string | UserInput[],
    options: AgentQueryOptions
  ): AsyncGenerator<AgentMessage> {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    // Issue #2920: Capture stderr for better error diagnostics
    const stderrCapture = createStderrCapture();
    const enhancedOptions: AgentQueryOptions = {
      ...options,
      stderr: stderrCapture.onStderr,
    };

    const sdkOptions = adaptOptions(enhancedOptions);
    const adaptedInput = adaptInput(input);

    const queryResult = query({
      prompt: adaptedInput as Parameters<typeof query>[0]['prompt'],
      options: sdkOptions as Parameters<typeof query>[0]['options'],
    });

    try {
      for await (const message of queryResult) {
        yield adaptSDKMessage(message);
      }
    } catch (error) {
      // Issue #2920: Enhance error with captured stderr for diagnostics
      const stderr = stderrCapture.getCapturedStderr();
      if (stderr) {
        logger.error({ err: error, stderr }, 'queryOnce: subprocess failed with stderr');
        // Attach stderr to the error for upstream consumers
        if (error instanceof Error) {
          (error as Error & { stderr?: string }).stderr = stderr;
        }
      }
      throw error;
    }
  }

  queryStream(
    input: AsyncGenerator<UserInput>,
    options: AgentQueryOptions
  ): StreamQueryResult {
    if (this.disposed) {
      throw new Error('Provider has been disposed');
    }

    // Issue #2920: Capture stderr for better error diagnostics
    const stderrCapture = createStderrCapture();
    const enhancedOptions: AgentQueryOptions = {
      ...options,
      stderr: stderrCapture.onStderr,
    };

    const sdkOptions = adaptOptions(enhancedOptions);

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

    // 创建消息适配迭代器
    let messageCount = 0;
    async function* adaptIterator(): AsyncGenerator<AgentMessage> {
      try {
        for await (const message of queryResult) {
          messageCount++;
          logger.info(
            { messageCount, messageType: message.type },
            'SDK message received'
          );
          yield adaptSDKMessage(message);
        }
      } catch (error) {
        // Issue #2920: Enhance error with captured stderr
        const stderr = stderrCapture.getCapturedStderr();
        if (stderr) {
          logger.error({ err: error, messageCount, stderr }, 'adaptIterator error (stderr captured)');
          // Attach stderr to the error for upstream consumers
          if (error instanceof Error) {
            (error as Error & { stderr?: string }).stderr = stderr;
          }
        } else {
          logger.error({ err: error, messageCount }, 'adaptIterator error');
        }
        throw error;
      }
    }

    return {
      handle: {
        close: () => {
          if ('close' in queryResult && typeof queryResult.close === 'function') {
            queryResult.close();
          }
        },
        cancel: () => {
          if ('cancel' in queryResult && typeof queryResult.cancel === 'function') {
            queryResult.cancel();
          }
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
