/**
 * Tests for ClaudeSDKProvider stderr capture and startup error extraction.
 *
 * Issue #2920: Tests for enhanced error diagnostics for subprocess startup failures.
 */

import { describe, it, expect } from 'vitest';
import { extractStartupDetail, createStderrCapture } from './provider.js';

describe('createStderrCapture', () => {
  it('should capture stderr output', () => {
    const capture = createStderrCapture();
    capture.onStderr('line 1\n');
    capture.onStderr('line 2\n');
    expect(capture.getCapturedStderr()).toBe('line 1\nline 2\n');
  });

  it('should reset the buffer', () => {
    const capture = createStderrCapture();
    capture.onStderr('some output');
    capture.reset();
    expect(capture.getCapturedStderr()).toBe('');
  });

  it('should truncate output exceeding MAX_STDERR_LENGTH', () => {
    const capture = createStderrCapture();
    const longLine = 'x'.repeat(100_000);
    capture.onStderr(longLine);
    const result = capture.getCapturedStderr();
    expect(result.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('extractStartupDetail', () => {
  it('should return fallback message when stderr is empty', () => {
    expect(extractStartupDetail('', 'Process exited with code 1')).toBe('Process exited with code 1');
  });

  it('should return fallback message when stderr is whitespace only', () => {
    expect(extractStartupDetail('   \n  \n', 'Process exited')).toBe('Process exited');
  });

  it('should extract MCP server configuration errors', () => {
    const stderr = `
[INFO] Starting Claude Code...
[INFO] Loading MCP servers...
Error: MCP server "amap-maps" failed to initialize: command is empty
    at MCPManager.start (mcp.ts:123)
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('amap-maps');
    expect(result).toContain('配置错误');
  });

  it('should extract authentication failures (401)', () => {
    const stderr = `
[INFO] Starting Claude Code...
[ERROR] authentication failed: 401 token expired or invalid
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('API 认证失败');
    expect(result).toContain('401');
  });

  it('should extract MCP server timeout errors', () => {
    const stderr = `
[INFO] Starting MCP server "playwright"...
[ERROR] MCP server "playwright" timed out after 30s
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('playwright');
    expect(result).toContain('启动超时');
  });

  it('should extract command/ENOENT errors', () => {
    const stderr = `
[ERROR] spawn ENOENT: command undefined not found
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('command 为空或不存在');
  });

  it('should extract explicit Error: lines', () => {
    const stderr = `
[INFO] Initializing...
Error: Something went wrong during startup
    at main (index.ts:42)
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toBe('Something went wrong during startup');
  });

  it('should use tail of stderr as fallback', () => {
    const stderr = `
[INFO] Line 1
[INFO] Line 2
[INFO] Line 3
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    // Should contain the last lines
    expect(result).toContain('Line 3');
  });

  it('should truncate long error lines from Error: pattern', () => {
    const longMessage = 'x'.repeat(300);
    const stderr = `Error: ${longMessage}`;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('should truncate long stderr tail', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `[INFO] Line ${i} with some content here`);
    const stderr = lines.join('\n');
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result.length).toBeLessThanOrEqual(300);
  });

  it('should return stderr content if no meaningful pattern found and stderr is short', () => {
    const stderr = 'just some output\n';
    const result = extractStartupDetail(stderr, 'Process exited with code 1');
    expect(result).toBe('just some output');
  });
});
