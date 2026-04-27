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

  it('should truncate output exceeding MAX_STDERR_LENGTH (64KB)', () => {
    const capture = createStderrCapture();
    const longLine = 'x'.repeat(100_000);
    capture.onStderr(longLine);
    const result = capture.getCapturedStderr();
    expect(result.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('should stop accumulating after buffer is full', () => {
    const capture = createStderrCapture();
    // Fill buffer beyond limit
    for (let i = 0; i < 200; i++) {
      capture.onStderr(`line ${i}: ${'x'.repeat(500)}\n`);
    }
    const result = capture.getCapturedStderr();
    expect(result.length).toBeLessThanOrEqual(64 * 1024);
  });
});

describe('extractStartupDetail', () => {
  it('should return fallback message when stderr is empty', () => {
    expect(extractStartupDetail('', 'Process exited with code 1'))
      .toBe('Process exited with code 1');
  });

  it('should return fallback message when stderr is whitespace only', () => {
    expect(extractStartupDetail('   \n  \n', 'Process exited'))
      .toBe('Process exited');
  });

  it('should extract MCP server configuration errors', () => {
    const stderr = `
[INFO] Starting Claude Code...
[INFO] Loading MCP servers...
MCP server "amap-maps" failed to initialize: command is empty
    at MCPManager.start (mcp.ts:123)
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('amap-maps');
    expect(result).toContain('配置错误');
  });

  it('should extract MCP server configuration errors with single quotes', () => {
    const stderr = 'Error initializing MCP server \'playwright\': config invalid';
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('playwright');
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

  it('should extract authentication failures with 401 at start', () => {
    const stderr = '401 unauthorized: invalid API key provided';
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('API 认证失败');
  });

  it('should extract API key errors', () => {
    const stderr = 'Error: API key expired or invalid';
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('API 认证失败');
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

  it('should extract bare ENOENT errors', () => {
    const stderr = 'Error: spawn /usr/bin/nonexistent ENOENT';
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

  it('should extract the last Error: line when multiple exist', () => {
    const stderr = `
Error: First error
Error: Second error
Error: Third error (most recent)
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toBe('Third error (most recent)');
  });

  it('should truncate long error lines from Error: pattern', () => {
    const longMessage = 'x'.repeat(300);
    const stderr = `Error: ${longMessage}`;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result.length).toBeLessThanOrEqual(203); // 200 + '...'
    expect(result.endsWith('...')).toBe(true);
  });

  it('should use tail of stderr as fallback when no pattern matches', () => {
    const stderr = `
[INFO] Line 1
[INFO] Line 2
[INFO] Line 3
    `;
    const result = extractStartupDetail(stderr, 'fallback');
    // Should contain the last lines
    expect(result).toContain('Line 3');
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

  it('should handle multiline stderr with mixed content', () => {
    const stderr = `[info] Starting server on port 3000
[warn] Configuration file not found, using defaults
[info] Connecting to database...
[info] Connected successfully
[info] Registering MCP servers...
MCP server "custom-tool" failed to initialize: timeout`;
    const result = extractStartupDetail(stderr, 'fallback');
    expect(result).toContain('custom-tool');
    expect(result).toContain('配置错误');
  });
});
