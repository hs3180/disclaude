/**
 * Startup Diagnostic Utilities for Claude SDK Provider
 *
 * Issue #2920: Improves error diagnostics for agent subprocess startup failures.
 *
 * When the Claude Code CLI subprocess crashes during startup (e.g., invalid MCP
 * server config, authentication failure), the stderr output contains detailed
 * error information. This module provides utilities to:
 *
 * 1. Capture stderr from the subprocess via SDK's `stderr` callback
 * 2. Enrich errors with captured stderr for better diagnostics
 * 3. Extract actionable error messages from stderr patterns
 *
 * @module sdk/providers/claude/startup-diagnostic
 */

import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('StartupDiagnostic');

/**
 * Custom error class that enriches SDK errors with stderr output.
 *
 * When the Claude Code CLI subprocess exits abnormally, this error wraps
 * the original error and includes the captured stderr output, which
 * contains detailed startup diagnostics (MCP failures, auth errors, etc.).
 */
export class SDKQueryError extends Error {
  /** Captured stderr output from the Claude Code process */
  readonly stderr: string;

  /** The original error thrown by the SDK */
  readonly originalError: Error;

  /** Exit code extracted from the error message (if present) */
  readonly exitCode: number | null;

  constructor(originalError: Error, stderr: string) {
    // Extract exit code from message like "Claude Code process exited with code 1"
    const exitCodeMatch = originalError.message.match(/exited with code (\d+)/i);
    const exitCode = exitCodeMatch ? parseInt(exitCodeMatch[1], 10) : null;

    super(originalError.message);
    this.name = 'SDKQueryError';
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.originalError = originalError;
  }
}

/**
 * Create a stderr collector for use with the SDK's `stderr` callback.
 *
 * Returns an object with:
 * - `callback`: The function to pass to the SDK options
 * - `getOutput()`: Retrieves all collected stderr output
 *
 * @returns Stderr collector with callback and output accessor
 */
export function createStderrCollector(): {
  callback: (data: string) => void;
  getOutput: () => string;
} {
  const chunks: string[] = [];

  return {
    callback: (data: string) => {
      chunks.push(data);
      logger.debug({ stderrLine: data.slice(0, 200) }, 'SDK stderr captured');
    },
    getOutput: () => chunks.join(''),
  };
}

/**
 * Known error patterns to check against stderr and error messages.
 * Each pattern maps to a user-friendly diagnostic message.
 */
const ERROR_PATTERNS: Array<{
  /** Pattern to match in stderr or error message */
  pattern: RegExp;
  /** Extractor for dynamic parts (e.g., MCP server name) */
  extract?: (match: RegExpMatchArray) => string;
  /** Fallback message if extraction fails */
  message: string;
}> = [
  {
    pattern: /MCP server "([^"]+)" failed to initialize/i,
    extract: (m) => `MCP server "${m[1]}" 初始化失败`,
    message: 'MCP server 初始化失败',
  },
  {
    pattern: /MCP server "([^"]+)" timed out/i,
    extract: (m) => `MCP server "${m[1]}" 启动超时`,
    message: 'MCP server 启动超时',
  },
  {
    pattern: /MCP server.*command.*empty|command.*is.*empty.*MCP/i,
    message: 'MCP server 配置错误: command 为空',
  },
  {
    // Auth failures: 401, token expired, invalid API key
    pattern: /(?:authentication failed|401|token.*expired|invalid.*api.*key|令牌已过期)/i,
    message: 'API 认证失败 (401): 令牌已过期或验证不正确',
  },
  {
    // Spawn ENOENT: command not found
    pattern: /spawn ENOENT|command not found/i,
    message: '命令未找到，请检查 MCP server 配置中的 command 路径',
  },
  {
    // Permission denied
    pattern: /EACCES|permission denied/i,
    message: '权限不足，请检查相关文件或目录权限',
  },
];

/**
 * Extract a user-friendly diagnostic message from an error and its stderr output.
 *
 * Checks known error patterns against both stderr and the error message.
 * Returns the first matching pattern's message, or falls back to the
 * error message itself.
 *
 * @param error - The error to analyze
 * @returns A user-friendly diagnostic message
 */
export function extractStartupDetail(error: Error): string {
  const {message} = error;
  const stderr = error instanceof SDKQueryError ? error.stderr : '';

  // Combine stderr and message for pattern matching
  const combined = `${stderr}\n${message}`;

  for (const { pattern, extract, message: defaultMsg } of ERROR_PATTERNS) {
    const match = combined.match(pattern);
    if (match) {
      return extract ? extract(match) : defaultMsg;
    }
  }

  // Fallback: if stderr has content, use the last few lines
  if (stderr.trim()) {
    const lines = stderr.trim().split('\n').filter(l => l.trim());
    const lastLines = lines.slice(-3);
    if (lastLines.length > 0) {
      return lastLines.join('\n');
    }
  }

  return message;
}

/**
 * Determine if an error represents a startup failure.
 *
 * A startup failure is when the subprocess exits before producing any messages,
 * typically within 3 seconds. These failures are usually caused by:
 * - Invalid MCP server configuration
 * - Authentication failures
 * - Missing binaries (ENOENT)
 *
 * @param error - The error to check
 * @param messageCount - Number of messages received before the error
 * @param elapsedMs - Time elapsed since the session started
 * @returns true if this appears to be a startup failure
 */
export function isStartupFailure(
  error: Error | null,
  messageCount: number,
  elapsedMs: number,
): boolean {
  if (!error) {
    return false;
  }

  // If we received messages, it's not a startup failure
  if (messageCount > 0) {
    return false;
  }

  // If the error happened quickly (< 3 seconds), it's likely a startup failure
  if (elapsedMs < 3000) {
    return true;
  }

  // Even if it took longer, if no messages were received and the error
  // mentions "exited with code", it's still likely a startup failure
  if (error.message.toLowerCase().includes('exited with code')) {
    return true;
  }

  return false;
}
