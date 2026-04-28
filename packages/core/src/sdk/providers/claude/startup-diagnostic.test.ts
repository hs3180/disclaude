/**
 * Tests for Startup Diagnostic Utilities (Issue #2920)
 *
 * Verifies:
 * - SDKQueryError correctly wraps errors with stderr
 * - createStderrCollector captures stderr lines
 * - extractStartupDetail extracts actionable messages from patterns
 * - isStartupFailure detects startup vs runtime failures
 */

import { describe, it, expect } from 'vitest';
import {
  SDKQueryError,
  createStderrCollector,
  extractStartupDetail,
  isStartupFailure,
} from './startup-diagnostic.js';

describe('SDKQueryError', () => {
  it('should wrap an error with stderr output', () => {
    const original = new Error('Claude Code process exited with code 1');
    const stderr = 'MCP server "test" failed to initialize\nError: command not found';

    const error = new SDKQueryError(original, stderr);

    expect(error.message).toBe('Claude Code process exited with code 1');
    expect(error.stderr).toBe(stderr);
    expect(error.originalError).toBe(original);
    expect(error.name).toBe('SDKQueryError');
  });

  it('should extract exit code from error message', () => {
    const original = new Error('Claude Code process exited with code 42');
    const error = new SDKQueryError(original, '');

    expect(error.exitCode).toBe(42);
  });

  it('should return null exit code if not present in message', () => {
    const original = new Error('Something went wrong');
    const error = new SDKQueryError(original, '');

    expect(error.exitCode).toBeNull();
  });
});

describe('createStderrCollector', () => {
  it('should collect stderr lines', () => {
    const collector = createStderrCollector();

    collector.callback('line 1\n');
    collector.callback('line 2\n');
    collector.callback('line 3\n');

    expect(collector.getOutput()).toBe('line 1\nline 2\nline 3\n');
  });

  it('should return empty string when no stderr captured', () => {
    const collector = createStderrCollector();
    expect(collector.getOutput()).toBe('');
  });
});

describe('extractStartupDetail', () => {
  it('should detect MCP server initialization failure', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: MCP server "amap-maps" failed to initialize: invalid config'
    );

    expect(extractStartupDetail(error)).toBe('MCP server "amap-maps" 初始化失败');
  });

  it('should detect MCP server timeout', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: MCP server "playwright" timed out during initialization'
    );

    expect(extractStartupDetail(error)).toBe('MCP server "playwright" 启动超时');
  });

  it('should detect API authentication failure (401)', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: authentication failed: invalid API key'
    );

    expect(extractStartupDetail(error)).toBe('API 认证失败 (401): 令牌已过期或验证不正确');
  });

  it('should detect 401 in error message', () => {
    const error = new Error('Request failed with status 401');

    expect(extractStartupDetail(error)).toBe('API 认证失败 (401): 令牌已过期或验证不正确');
  });

  it('should detect ENOENT (command not found)', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: spawn ENOENT: command "nonexistent-binary" not found'
    );

    expect(extractStartupDetail(error)).toBe('命令未找到，请检查 MCP server 配置中的 command 路径');
  });

  it('should detect permission denied', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: EACCES: permission denied, open \'/etc/config\''
    );

    expect(extractStartupDetail(error)).toBe('权限不足，请检查相关文件或目录权限');
  });

  it('should detect empty MCP command', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Error: MCP server "test" command is empty'
    );

    expect(extractStartupDetail(error)).toBe('MCP server 配置错误: command 为空');
  });

  it('should fall back to last stderr lines for unknown patterns', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      'Some random error output\nMore details here\nFinal error line'
    );

    const detail = extractStartupDetail(error);
    expect(detail).toContain('Some random error output');
    expect(detail).toContain('Final error line');
  });

  it('should fall back to error message when no stderr', () => {
    const error = new Error('Unknown error occurred');

    expect(extractStartupDetail(error)).toBe('Unknown error occurred');
  });

  it('should handle empty stderr', () => {
    const error = new SDKQueryError(
      new Error('Claude Code process exited with code 1'),
      ''
    );

    expect(extractStartupDetail(error)).toBe('Claude Code process exited with code 1');
  });
});

describe('isStartupFailure', () => {
  it('should detect startup failure: 0 messages, fast exit', () => {
    const error = new Error('Claude Code process exited with code 1');

    expect(isStartupFailure(error, 0, 500)).toBe(true);
  });

  it('should detect startup failure: 0 messages, slow exit with exit code pattern', () => {
    const error = new Error('Claude Code process exited with code 1');

    // Even if it took 10 seconds, if 0 messages and mentions "exited with code"
    expect(isStartupFailure(error, 0, 10000)).toBe(true);
  });

  it('should NOT detect startup failure when messages were received', () => {
    const error = new Error('Claude Code process exited with code 1');

    expect(isStartupFailure(error, 5, 500)).toBe(false);
  });

  it('should NOT detect startup failure when there is no error', () => {
    expect(isStartupFailure(null, 0, 500)).toBe(false);
  });

  it('should NOT detect startup failure: slow exit without exit code pattern', () => {
    const error = new Error('Connection timeout');

    // Slow exit, no "exited with code" pattern, 0 messages
    expect(isStartupFailure(error, 0, 10000)).toBe(false);
  });

  it('should detect startup failure: 0 messages within 3s boundary', () => {
    const error = new Error('Some startup error');

    // Exactly 2999ms - still within the boundary
    expect(isStartupFailure(error, 0, 2999)).toBe(true);
  });

  it('should NOT detect startup failure: 0 messages at 3s+ without exit code', () => {
    const error = new Error('Some startup error');

    // 3001ms - past the boundary, no "exited with code" pattern
    expect(isStartupFailure(error, 0, 3001)).toBe(false);
  });
});
