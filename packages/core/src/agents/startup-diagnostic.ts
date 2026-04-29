/**
 * Startup Diagnostic - Detect and diagnose Agent subprocess startup failures.
 *
 * When the Claude Code CLI subprocess exits during startup (before producing
 * any messages), the error is typically caused by configuration issues such as:
 * - Invalid MCP server configuration
 * - API authentication failure
 * - Missing commands or tools
 *
 * These errors are NOT transient — retrying will not fix them. This module
 * provides utilities to detect startup failures and generate actionable
 * error messages.
 *
 * Related: Issue #2920
 *
 * @module agents/startup-diagnostic
 */

/**
 * Time window (ms) within which an error is considered a "startup failure".
 *
 * A generous threshold that accounts for MCP server initialization,
 * network timeouts during startup, and other one-time setup costs.
 */
export const STARTUP_FAILURE_WINDOW_MS = 15_000;

/**
 * Error patterns that indicate a startup failure regardless of timing.
 * These are matched against the error message (case-insensitive).
 */
const STARTUP_ERROR_PATTERNS: ReadonlyArray<{
  /** Regex pattern to match in the error message */
  pattern: RegExp;
  /** Diagnostic category */
  category: StartupFailureCategory;
  /** Short description for user-facing messages */
  description: string;
}> = [
  {
    pattern: /exited with code (\d+)/i,
    category: 'process_exit',
    description: 'Agent 进程异常退出',
  },
  {
    pattern: /spawn.*enoent/i,
    category: 'command_not_found',
    description: '命令或程序未找到',
  },
  {
    pattern: /eacces/i,
    category: 'permission_denied',
    description: '权限不足',
  },
];

/**
 * Diagnostic categories for startup failures.
 */
export type StartupFailureCategory =
  | 'process_exit'
  | 'command_not_found'
  | 'permission_denied'
  | 'timeout'
  | 'unknown';

/**
 * Result of startup failure analysis.
 */
export interface StartupFailureDetail {
  /** Whether this is a startup failure */
  isStartupFailure: boolean;
  /** Diagnostic category */
  category: StartupFailureCategory;
  /** Short user-facing description */
  description: string;
  /** Actionable suggestion for the user */
  suggestion: string;
  /** Original error message */
  originalMessage: string;
  /** Elapsed time in ms since iterator started */
  elapsedMs: number;
  /** Number of messages received before failure */
  messageCount: number;
}

/**
 * Determine whether an error represents a startup failure.
 *
 * A startup failure is detected when:
 * 1. No messages were received (messageCount === 0), OR
 * 2. The error occurred within the startup failure time window AND
 *    messageCount is very low (<= 1)
 *
 * @param error - The error that occurred
 * @param messageCount - Number of messages received before the error
 * @param elapsedMs - Time elapsed since the iterator started
 * @returns StartupFailureDetail with analysis and actionable suggestions
 */
export function analyzeStartupFailure(
  error: unknown,
  messageCount: number,
  elapsedMs: number,
): StartupFailureDetail {
  const errorMessage = error instanceof Error ? error.message : String(error);

  // Check if this looks like a startup failure
  const isStartupFailure =
    messageCount === 0 ||
    (messageCount <= 1 && elapsedMs < STARTUP_FAILURE_WINDOW_MS);

  if (!isStartupFailure) {
    return {
      isStartupFailure: false,
      category: 'unknown',
      description: '',
      suggestion: '',
      originalMessage: errorMessage,
      elapsedMs,
      messageCount,
    };
  }

  // Match against known error patterns
  for (const { pattern, category, description } of STARTUP_ERROR_PATTERNS) {
    if (pattern.test(errorMessage)) {
      return {
        isStartupFailure: true,
        category,
        description,
        suggestion: getSuggestion(category, errorMessage),
        originalMessage: errorMessage,
        elapsedMs,
        messageCount,
      };
    }
  }

  // Generic startup failure — still useful to report
  return {
    isStartupFailure: true,
    category: messageCount === 0 ? 'process_exit' : 'unknown',
    description: messageCount === 0
      ? 'Agent 启动失败（未产生任何消息）'
      : 'Agent 启动阶段异常',
    suggestion: getGenericSuggestion(errorMessage),
    originalMessage: errorMessage,
    elapsedMs,
    messageCount,
  };
}

/**
 * Generate a user-facing error message for a startup failure.
 *
 * Includes the diagnostic description and actionable suggestions,
 * plus the original error for context.
 */
export function formatStartupFailureMessage(detail: StartupFailureDetail): string {
  const parts: string[] = [
    `❌ Agent 启动失败: ${detail.description}`,
  ];

  if (detail.suggestion) {
    parts.push(`\n💡 ${detail.suggestion}`);
  }

  parts.push(`\n\n🔧 原始错误: ${detail.originalMessage}`);
  parts.push('\n\n请检查配置后发送 /reset 重置会话。');

  return parts.join('');
}

/**
 * Get a specific suggestion based on the error category.
 */
function getSuggestion(category: StartupFailureCategory, errorMessage: string): string {
  switch (category) {
    case 'process_exit':
      return extractExitCodeSuggestion(errorMessage);
    case 'command_not_found':
      return 'MCP 服务器配置的命令不存在。请检查 disclaude.yaml 中 mcpServers 部分的 command 字段。';
    case 'permission_denied':
      return 'Agent 没有执行权限。请检查文件权限或工作目录设置。';
    case 'timeout':
      return 'MCP 服务器启动超时。请检查网络连接或增加超时时间。';
    default:
      return getGenericSuggestion(errorMessage);
  }
}

/**
 * Extract a more specific suggestion based on the exit code.
 */
function extractExitCodeSuggestion(errorMessage: string): string {
  const match = errorMessage.match(/exited with code (\d+)/);
  const exitCode = match ? parseInt(match[1], 10) : -1;

  switch (exitCode) {
    case 1:
      return '进程以错误码 1 退出，通常是 MCP 配置错误或 API 认证失败。请检查:\n'
        + '  • disclaude.yaml 中的 mcpServers 配置\n'
        + '  • API Key 是否有效\n'
        + '  • 服务日志中的详细错误信息';
    case 137:
      return '进程被 OOM Killer 终止（内存不足）。请考虑增加可用内存。';
    case 126:
      return '命令存在但无法执行（权限问题）。请检查 MCP 服务器命令的执行权限。';
    default:
      return getGenericSuggestion(errorMessage);
  }
}

/**
 * Generate a generic suggestion when no specific pattern matches.
 */
function getGenericSuggestion(errorMessage: string): string {
  const suggestions: string[] = [
    '请检查以下配置:',
    '  • MCP 服务器配置是否正确（disclaude.yaml → mcpServers）',
    '  • API Key 是否有效且未过期',
    '  • 工作目录是否存在且可访问',
    '  • 服务日志中的详细错误信息',
  ];

  // Add hint about exit code if present
  if (/exited with code/i.test(errorMessage)) {
    suggestions.push('  • 进程退出码表明启动阶段失败（配置/认证问题）');
  }

  return suggestions.join('\n');
}
