/**
 * Tests for Claude SDK Provider.
 *
 * Issue #2920: Tests for StderrCapture, getErrorStderr, isStartupFailure.
 * Issue #1617: Phase 2 - ClaudeSDKProvider class test coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StderrCapture, getErrorStderr, isStartupFailure, attachStderrToError, ClaudeSDKProvider } from './provider.js';
import { ErrorCategory } from '../../../utils/error-handler.js';
import type { AgentMessage, UserInput } from '../../types.js';

// ============================================================================
// Mocks for ClaudeSDKProvider tests
// ============================================================================

// Mock the Claude Agent SDK
const mockQuery = vi.fn();
const mockTool = vi.fn((_name: string, _desc: string, _params: unknown, handler: unknown) => ({
  type: 'sdk_tool',
  name: _name,
  handler,
}));
const mockCreateSdkMcpServer = vi.fn((config: { name: string; version: string }) => ({
  type: 'sdk',
  name: config.name,
  instance: { name: config.name },
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (arg: unknown) => mockQuery(arg),
  tool: (name: string, desc: string, params: unknown, handler: unknown) => mockTool(name, desc, params, handler),
  createSdkMcpServer: (arg: { name: string; version: string }) => mockCreateSdkMcpServer(arg),
}));

// Mock the logger to prevent noise in test output.
// 共享同一个 mock 实例(createLogger 每次返回同一对象),以便断言 provider 内部对
// logger.warn / logger.info 的调用 —— 例如 system-flood 检测是否真的触发了 warn。
const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => loggerMock,
}));

// ============================================================================
// StderrCapture
// ============================================================================

describe('StderrCapture', () => {
  it('should buffer appended lines', () => {
    const capture = new StderrCapture();
    capture.append('line 1');
    capture.append('line 2');
    capture.append('line 3');

    expect(capture.hasContent()).toBe(true);
    expect(capture.getCaptured()).toBe('line 1\nline 2\nline 3');
  });

  it('should ignore empty lines', () => {
    const capture = new StderrCapture();
    capture.append('');
    capture.append('   ');
    capture.append('\n');

    expect(capture.hasContent()).toBe(false);
    expect(capture.getCaptured()).toBe('');
  });

  it('should trim trailing whitespace from lines', () => {
    const capture = new StderrCapture();
    capture.append('hello  \n');
    capture.append('world\n');

    expect(capture.getCaptured()).toBe('hello\nworld');
  });

  it('should respect maxLines limit', () => {
    const capture = new StderrCapture(3);
    capture.append('line 1');
    capture.append('line 2');
    capture.append('line 3');
    capture.append('line 4');
    capture.append('line 5');

    // Should only keep last 3 lines
    expect(capture.getCaptured()).toBe('line 3\nline 4\nline 5');
  });

  it('should return empty when no content', () => {
    const capture = new StderrCapture();
    expect(capture.hasContent()).toBe(false);
    expect(capture.getCaptured()).toBe('');
    expect(capture.getTail()).toBe('');
  });

  describe('getTail', () => {
    it('should return full text when within maxChars', () => {
      const capture = new StderrCapture();
      capture.append('short text');

      expect(capture.getTail(100)).toBe('short text');
    });

    it('should truncate with ellipsis when exceeding maxChars', () => {
      const capture = new StderrCapture();
      const longText = 'a'.repeat(600);
      capture.append(longText);

      const result = capture.getTail(100);
      expect(result.length).toBeLessThanOrEqual(100);
      expect(result.startsWith('...')).toBe(true);
      expect(result).toContain('aaa');
    });
  });

  describe('reset', () => {
    it('should clear all buffered content', () => {
      const capture = new StderrCapture();
      capture.append('line 1');
      capture.append('line 2');

      capture.reset();

      expect(capture.hasContent()).toBe(false);
      expect(capture.getCaptured()).toBe('');
    });
  });
});

// ============================================================================
// attachStderrToError / getErrorStderr
// ============================================================================

describe('attachStderrToError / getErrorStderr', () => {
  it('should attach and retrieve stderr from Error object', () => {
    const error = new Error('test error');
    attachStderrToError(error, 'MCP server failed to initialize');

    const stderr = getErrorStderr(error);
    expect(stderr).toBe('MCP server failed to initialize');
  });

  it('should return undefined for Error without attached stderr', () => {
    const error = new Error('test error');
    expect(getErrorStderr(error)).toBeUndefined();
  });

  it('should return undefined for non-Error values', () => {
    expect(getErrorStderr('string error')).toBeUndefined();
    expect(getErrorStderr(42)).toBeUndefined();
    expect(getErrorStderr(null)).toBeUndefined();
    expect(getErrorStderr(undefined)).toBeUndefined();
  });

  it('should handle stderr with multiline content', () => {
    const error = new Error('CLI exited');
    const multilineStderr = [
      'Error: MCP server "amap-maps" failed to initialize',
      '  at initializeMcpServer (sdk.js:123:45)',
      '  at startProcess (sdk.js:67:89)',
      'Caused by: command is empty or undefined',
    ].join('\n');
    attachStderrToError(error, multilineStderr);

    expect(getErrorStderr(error)).toBe(multilineStderr);
  });
});

// ============================================================================
// isStartupFailure
// ============================================================================

describe('isStartupFailure', () => {
  it('should detect startup failure: 0 messages, short elapsed time', () => {
    expect(isStartupFailure(0, 500)).toBe(true);
    expect(isStartupFailure(0, 1000)).toBe(true);
    expect(isStartupFailure(0, 5000)).toBe(true);
    expect(isStartupFailure(0, 9999)).toBe(true);
  });

  it('should not detect startup failure: messages received', () => {
    expect(isStartupFailure(1, 500)).toBe(false);
    expect(isStartupFailure(5, 1000)).toBe(false);
    expect(isStartupFailure(1, 9999)).toBe(false);
  });

  it('should not detect startup failure: elapsed time exceeds threshold', () => {
    expect(isStartupFailure(0, 10_000)).toBe(false);
    expect(isStartupFailure(0, 15_000)).toBe(false);
    expect(isStartupFailure(0, 60_000)).toBe(false);
  });

  it('should detect startup failure at boundary', () => {
    // Just under threshold
    expect(isStartupFailure(0, 9999)).toBe(true);
    // At threshold
    expect(isStartupFailure(0, 10_000)).toBe(false);
  });
});

// ============================================================================
// ClaudeSDKProvider
// ============================================================================

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider;
  let originalApiKey: string | undefined;
  // Issue #3706 (review): snapshot stall-watchdog env knobs so they are restored
  // even if a test's assertion throws before reaching its manual `delete`.
  let originalStallTimeout: string | undefined;
  let originalStallGrace: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    originalStallTimeout = process.env.DISCLAUDE_STALL_TIMEOUT_MS;
    originalStallGrace = process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS;
    provider = new ClaudeSDKProvider();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    }
    if (originalStallTimeout === undefined) {
      delete process.env.DISCLAUDE_STALL_TIMEOUT_MS;
    } else {
      process.env.DISCLAUDE_STALL_TIMEOUT_MS = originalStallTimeout;
    }
    if (originalStallGrace === undefined) {
      delete process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS;
    } else {
      process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS = originalStallGrace;
    }
  });

  // --------------------------------------------------------------------------
  // Properties
  // --------------------------------------------------------------------------

  describe('properties', () => {
    it('should have name "claude"', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have a version string', () => {
      expect(provider.version).toBeTruthy();
      expect(typeof provider.version).toBe('string');
    });
  });

  // --------------------------------------------------------------------------
  // validateConfig
  // --------------------------------------------------------------------------

  describe('validateConfig', () => {
    it('should return true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when ANTHROPIC_API_KEY is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(provider.validateConfig()).toBe(false);
    });

    it('should return false when ANTHROPIC_API_KEY is empty string', () => {
      process.env.ANTHROPIC_API_KEY = '';
      expect(provider.validateConfig()).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // getInfo
  // --------------------------------------------------------------------------

  describe('getInfo', () => {
    it('should return available info when API key is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const info = provider.getInfo();

      expect(info.name).toBe('claude');
      expect(info.version).toBe(provider.version);
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('should return unavailable info when API key is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const info = provider.getInfo();

      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('ANTHROPIC_API_KEY not set');
    });
  });

  // --------------------------------------------------------------------------
  // dispose
  // --------------------------------------------------------------------------

  describe('dispose', () => {
    it('should prevent queryStream after disposal', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      provider.dispose();

      async function* emptyInput(): AsyncGenerator<UserInput> {
        // no input
      }

      expect(() => provider.queryStream(emptyInput(), {
        settingSources: ['user', 'project', 'local'],
      })).toThrow('Provider has been disposed');
    });

    it('should be idempotent', () => {
      provider.dispose();
      provider.dispose();
      // Should not throw on second dispose
    });
  });

  // --------------------------------------------------------------------------
  // queryStream
  // --------------------------------------------------------------------------

  describe('queryStream', () => {
    it('should return handle and iterator from SDK query', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // Mock SDK query to return an async iterable
      const sdkMessages = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
      ];

      mockQuery.mockReturnValue((async function* () {
        for (const msg of sdkMessages) {
          yield msg;
        }
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hi' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      });

      expect(result.handle).toBeDefined();
      expect(result.iterator).toBeDefined();
      expect(result.handle.sessionId).toBeUndefined();

      // Consume iterator
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages.length).toBe(1);
      expect(messages[0].role).toBe('assistant');
      expect(mockQuery).toHaveBeenCalled();
    });

    // Issue #3706 (GLM stall): no-content-progress watchdog.
    // Margins chosen with headroom over the timeout to stay green under CI load.
    it('should terminate on GLM stall (message_start, no content_block_delta for STALL_TIMEOUT_MS)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.DISCLAUDE_STALL_TIMEOUT_MS = '80';
      let interrupted = false;
      const interruptSpy = vi.fn(() => { interrupted = true; return Promise.resolve(); });
      const gen = (async function* () {
        yield { type: 'stream_event', event: { type: 'message_start' } };
        while (!interrupted) { await new Promise<void>(r => setTimeout(r, 5)); }
      })();
      mockQuery.mockReturnValue(Object.assign(gen, { interrupt: interruptSpy, close: vi.fn() }));
      async function* testInput(): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Hi' }; }
      const result = provider.queryStream(testInput(), { settingSources: ['user', 'project', 'local'], cwd: '/workspace', env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) { messages.push(msg); }
      expect(messages.find(m => m.metadata?.terminatedReason === 'stall')).toBeDefined();
      expect(interruptSpy).toHaveBeenCalledTimes(1);
    });

    it('should NOT terminate on healthy stream (content_block_delta resets watchdog)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.DISCLAUDE_STALL_TIMEOUT_MS = '80';
      const interruptSpy = vi.fn();
      const gen = (async function* () {
        yield { type: 'stream_event', event: { type: 'message_start' } };
        for (let i = 0; i < 5; i++) {
          yield { type: 'stream_event', event: { type: 'content_block_delta', delta: {} } };
          await new Promise<void>(r => setTimeout(r, 15));
        }
        yield { type: 'stream_event', event: { type: 'message_stop' } };
        yield { type: 'result', subtype: 'success' };
      })();
      mockQuery.mockReturnValue(Object.assign(gen, { interrupt: interruptSpy, close: vi.fn() }));
      async function* testInput(): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Hi' }; }
      const result = provider.queryStream(testInput(), { settingSources: ['user', 'project', 'local'], cwd: '/workspace', env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) { messages.push(msg); }
      expect(interruptSpy).not.toHaveBeenCalled();
    });

    it('should NOT terminate during between-request gap (message_stop clears watchdog)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.DISCLAUDE_STALL_TIMEOUT_MS = '80';
      const interruptSpy = vi.fn();
      const gen = (async function* () {
        yield { type: 'stream_event', event: { type: 'message_start' } };
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: {} } };
        yield { type: 'stream_event', event: { type: 'message_stop' } };
        await new Promise<void>(r => setTimeout(r, 250)); // gap >> timeout, but watchdog cleared
        yield { type: 'stream_event', event: { type: 'message_start' } };
        yield { type: 'stream_event', event: { type: 'content_block_delta', delta: {} } };
        yield { type: 'stream_event', event: { type: 'message_stop' } };
        yield { type: 'result', subtype: 'success' };
      })();
      mockQuery.mockReturnValue(Object.assign(gen, { interrupt: interruptSpy, close: vi.fn() }));
      async function* testInput(): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Hi' }; }
      const result = provider.queryStream(testInput(), { settingSources: ['user', 'project', 'local'], cwd: '/workspace', env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) { messages.push(msg); }
      expect(interruptSpy).not.toHaveBeenCalled();
    });

    it('should force-close the query when interrupt() does not end the stream (Issue #3706)', async () => {
      // Covers the review caveat: if interrupt() can't tear down a stalled socket,
      // the watchdog escalates to query.close() after STALL_FORCE_CLOSE_GRACE_MS.
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      process.env.DISCLAUDE_STALL_TIMEOUT_MS = '50';
      process.env.DISCLAUDE_STALL_FORCE_CLOSE_GRACE_MS = '20';
      let closed = false;
      const interruptSpy = vi.fn(() => Promise.resolve()); // does NOT unblock the stream
      const closeSpy = vi.fn(() => { closed = true; });
      const gen = (async function* () {
        yield { type: 'stream_event', event: { type: 'message_start' } };
        while (!closed) { await new Promise<void>(r => setTimeout(r, 5)); } // only close() unblocks
      })();
      mockQuery.mockReturnValue(Object.assign(gen, { interrupt: interruptSpy, close: closeSpy }));
      async function* testInput(): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Hi' }; }
      const result = provider.queryStream(testInput(), { settingSources: ['user', 'project', 'local'], cwd: '/workspace', env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) { messages.push(msg); }
      expect(interruptSpy).toHaveBeenCalledTimes(1);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(messages.find(m => m.metadata?.terminatedReason === 'stall')).toBeDefined();
    });

    it('should log a blind-watchdog warning when partials never flow (Issue #3706)', async () => {
      // If includePartialMessages is ineffective for the provider, no stream_event
      // is ever seen → the watchdog is INACTIVE. Surface it loudly.
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const interruptSpy = vi.fn();
      const gen = (async function* () {
        // A message flows but NO stream_event partials → watchdog never arms.
        yield { type: 'result', subtype: 'success' };
      })();
      mockQuery.mockReturnValue(Object.assign(gen, { interrupt: interruptSpy, close: vi.fn() }));
      async function* testInput(): AsyncGenerator<UserInput> { yield { role: 'user', content: 'Hi' }; }
      const result = provider.queryStream(testInput(), { settingSources: ['user', 'project', 'local'], cwd: '/workspace', env: { ANTHROPIC_API_KEY: 'sk-test-key' } });
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) { messages.push(msg); }
      expect(interruptSpy).not.toHaveBeenCalled();
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({ messageCount: expect.any(Number) }),
        expect.stringContaining('watchdog was INACTIVE'),
      );
    });

    // 根因记录(D2):Agent Teams 并发触发上游限流(GLM 1302)时,卡住的 teammate 会
    // 产出海量空 system 消息(实测以 thinking_tokens 为主)。flood 检测必须 warn-only
    // —— 不终止流(范围不含 D3 终止防护),否则会改变行为。此处用任意未识别 subtype 验证。
    it('should NOT terminate the stream on system-message flood (warn-only)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // 55 条空 system 消息(超过 SYSTEM_FLOOD_THRESHOLD=50)
      const floodMessages = Array.from({ length: 55 }, () => ({
        type: 'system' as const,
        subtype: 'task_started',
      }));

      mockQuery.mockReturnValue((async function* () {
        for (const msg of floodMessages) {
          yield msg;
        }
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hi' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      });

      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      // warn-only:超过阈值后流仍不被终止,55 条全部 yield
      expect(messages.length).toBe(55);
      // content 必须保持空(否则 chat-agent 会当回复发给用户)
      expect(messages.every((m) => m.content === '')).toBe(true);
      // D1:subtype 经 adapter 保留到 metadata,在 provider 层可见(供诊断)
      expect(messages[0].metadata?.systemSubtype).toBe('task_started');
      // D2:超过阈值时确实发出了 flood warn(且只发一次,防止刷屏)
      const floodWarnCalls = loggerMock.warn.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && /flood/i.test(msg),
      );
      expect(floodWarnCalls).toHaveLength(1);
    });

    // 修正点①:contentful 的 system 消息(如 status:"🤔 Thinking…")不应重置 flood 计数。
    // 否则「空消息 + 偶发 status」交替的 flood 会被不断清零、永远到不了阈值。
    // (旧逻辑会把计数清零 → 最终不到 50;新逻辑只由非 system 进展重置 → 命中 50)
    it('should NOT reset flood counter on contentful system messages (e.g. status)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // 30 空 system → 1 条带 content 的 status(映射成 role:'system' + "🤔 Thinking…")→ 30 空 system
      const messageSeq = [
        ...Array.from({ length: 30 }, () => ({ type: 'system' as const, subtype: 'task_started' })),
        { type: 'system' as const, subtype: 'status', status: 'requesting' },
        ...Array.from({ length: 30 }, () => ({ type: 'system' as const, subtype: 'task_started' })),
      ];

      mockQuery.mockReturnValue((async function* () {
        for (const msg of messageSeq) {
          yield msg;
        }
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hi' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
        cwd: '/workspace',
        env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      });

      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      // warn-only:全部 yield(共 61 条)
      expect(messages.length).toBe(61);
      // 关键断言:尽管中间夹了一条带 content 的 status,flood warn 仍命中(证明未被重置)
      const floodWarnCalls = loggerMock.warn.mock.calls.filter(
        ([, msg]) => typeof msg === 'string' && /flood/i.test(msg),
      );
      expect(floodWarnCalls).toHaveLength(1);
    });

    // 修正点③:阈值可经 DISCLAUDE_SYSTEM_FLOOD_THRESHOLD 调节(须为正整数)。
    it('should honor DISCLAUDE_SYSTEM_FLOOD_THRESHOLD env override', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const prevThreshold = process.env.DISCLAUDE_SYSTEM_FLOOD_THRESHOLD;
      process.env.DISCLAUDE_SYSTEM_FLOOD_THRESHOLD = '5';

      try {
        // 10 条空 system:默认阈值 50 下不会命中;降到 5 后应在累计到 5 时命中
        const floodMessages = Array.from({ length: 10 }, () => ({
          type: 'system' as const,
          subtype: 'task_started',
        }));

        mockQuery.mockReturnValue((async function* () {
          for (const msg of floodMessages) {
            yield msg;
          }
        })());

        async function* testInput(): AsyncGenerator<UserInput> {
          yield { role: 'user', content: 'Hi' };
        }

        const result = provider.queryStream(testInput(), {
          settingSources: ['user', 'project', 'local'],
          cwd: '/workspace',
          env: { ANTHROPIC_API_KEY: 'sk-test-key' },
        });

        const messages: AgentMessage[] = [];
        for await (const msg of result.iterator) {
          messages.push(msg);
        }

        expect(messages.length).toBe(10);
        const floodWarnCalls = loggerMock.warn.mock.calls.filter(
          ([, msg]) => typeof msg === 'string' && /flood/i.test(msg),
        );
        expect(floodWarnCalls).toHaveLength(1);
      } finally {
        if (prevThreshold === undefined) {
          delete process.env.DISCLAUDE_SYSTEM_FLOOD_THRESHOLD;
        } else {
          process.env.DISCLAUDE_SYSTEM_FLOOD_THRESHOLD = prevThreshold;
        }
      }
    });

    it('should pass adapted options to SDK query', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      mockQuery.mockReturnValue((async function* () {
        // no messages
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
        cwd: '/workspace',
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
        env: { ANTHROPIC_API_KEY: 'sk-test-key' },
      });

      // Verify query was called with prompt and options
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(mockQuery.mock.calls[0][0]).toHaveProperty('prompt');
      const callOptions = (mockQuery.mock.calls[0][0] as { options: Record<string, unknown> }).options;
      expect(callOptions).toHaveProperty('cwd');
      expect(callOptions).toHaveProperty('permissionMode');
      expect(callOptions.model).toBe('claude-sonnet-4-20250514');
    });

    it('should adapt user input correctly through the stream', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      let capturedPrompt: unknown;
      mockQuery.mockImplementation(({ prompt }: { prompt: unknown }) => {
        capturedPrompt = prompt;
        return (async function* () {
          // no messages
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello world' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // Consume iterator to trigger input processing
      for await (const _ of result.iterator) {
        // consume
      }

      // The prompt should be an async generator (adapted input)
      expect(capturedPrompt).toBeDefined();
      // Verify it's an async iterable by consuming it
      const promptMessages: unknown[] = [];
      for await (const chunk of capturedPrompt as AsyncIterable<unknown>) {
        promptMessages.push(chunk);
      }
      expect(promptMessages.length).toBe(1);
    });

    it('should inject stderr callback into SDK options', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const userStderrCalls: string[] = [];
      mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
        // Verify stderr callback is set
        expect(options.stderr).toBeDefined();
        expect(typeof options.stderr).toBe('function');

        // Simulate SDK stderr output
        if (options.stderr) {
          (options.stderr as (data: string) => void)('test stderr line');
        }

        return (async function* () {
          // no messages
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        // no input
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
        stderr: (data: string) => { userStderrCalls.push(data); },
      });

      for await (const _ of result.iterator) {
        // consume
      }

      // User's stderr callback should have been called
      expect(userStderrCalls).toContain('test stderr line');
    });

    it('should capture stderr and attach to error on iterator failure', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const stderrLines = ['MCP server error: config invalid', 'Failed to start'];
      mockQuery.mockImplementation(({ options }: { options: Record<string, unknown> }) => {
        // Simulate stderr output
        if (options.stderr) {
          for (const line of stderrLines) {
            (options.stderr as (data: string) => void)(line);
          }
        }
        return (async function* () {
          throw new Error('SDK process exited with code 1');
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        // no input
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // Expect the iterator to throw with stderr attached
      let thrownError: Error | undefined;
      try {
        for await (const _ of result.iterator) {
          // consume
        }
      } catch (error) {
        thrownError = error as Error;
      }

      expect(thrownError).toBeDefined();
      if (thrownError) {
        expect(thrownError.message).toContain('SDK process exited');
      }
      // stderr should be attached via attachStderrToError
      const stderr = getErrorStderr(thrownError);
      expect(stderr).toContain('MCP server error');
      expect(stderr).toContain('Failed to start');
    });

    it('should log classified errorCategory/errorTransient on iterator failure (Issue #4192 L0)', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // A clearly transient NETWORK error so the tag carries a non-default
      // category + transient=true through the catch path's structured log.
      mockQuery.mockImplementation(() => {
        return (async function* () {
          throw new Error('fetch failed: ECONNRESET');
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        // no input
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      let thrownError: Error | undefined;
      try {
        for await (const _ of result.iterator) {
          // consume
        }
      } catch (error) {
        thrownError = error as Error;
      }

      expect(thrownError).toBeDefined();
      // The catch path classifies the error once and emits the tag in the
      // structured log — locks the L0 contract so L1/L2 can rely on it.
      expect(loggerMock.error).toHaveBeenCalledWith(
        expect.objectContaining({
          errorCategory: ErrorCategory.NETWORK,
          errorTransient: true,
        }),
        'adaptIterator error',
      );
    });

    it('should handle query result without close/cancel gracefully', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // Return a plain async iterable (no close/cancel methods)
      mockQuery.mockReturnValue((async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Response' }] } };
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // close and cancel should not throw even when not available
      expect(() => result.handle.close()).not.toThrow();
      expect(() => result.handle.cancel()).not.toThrow();
    });

    it('should call close and cancel on query result when available', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const closeFn = vi.fn();
      const cancelFn = vi.fn();

      // Create an async iterable with close/cancel methods
      const asyncIterable = Object.assign(
        (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } };
        })(),
        { close: closeFn, cancel: cancelFn },
      );

      mockQuery.mockReturnValue(asyncIterable);

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      result.handle.close();
      expect(closeFn).toHaveBeenCalled();

      result.handle.cancel();
      expect(cancelFn).toHaveBeenCalled();
    });

    it('should handle multiple user inputs', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      let inputCount = 0;
      mockQuery.mockImplementation(({ prompt }: { prompt: AsyncGenerator<unknown> }) => {
        return (async function* () {
          // Consume the prompt generator to count inputs
          for await (const _ of prompt) {
            inputCount++;
          }
          // Then yield a response
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
        })();
      });

      async function* multiInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'First message' };
        yield { role: 'user', content: 'Second message' };
      }

      const result = provider.queryStream(multiInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(inputCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // createInlineTool
  // --------------------------------------------------------------------------

  describe('createInlineTool', () => {
    it('should create a tool using SDK tool function', () => {
      const handler = vi.fn();
      const definition = {
        name: 'test_tool',
        description: 'A test tool',
        parameters: {} as never, // Zod schema - simplified for test
        handler,
      };

      const result = provider.createInlineTool(definition);

      expect(mockTool).toHaveBeenCalledWith(
        'test_tool',
        'A test tool',
        definition.parameters,
        handler,
      );
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // createMcpServer
  // --------------------------------------------------------------------------

  describe('createMcpServer', () => {
    it('should create MCP server for inline config with tools', () => {
      const tools = [
        {
          name: 'tool1',
          description: 'First tool',
          parameters: {} as never, // Zod schema - simplified for test
          handler: vi.fn(),
        },
        {
          name: 'tool2',
          description: 'Second tool',
          parameters: {} as never, // Zod schema - simplified for test
          handler: vi.fn(),
        },
      ];

      const config = {
        type: 'inline' as const,
        name: 'test-server',
        version: '1.0.0',
        tools,
      };

      const result = provider.createMcpServer(config);

      expect(mockCreateSdkMcpServer).toHaveBeenCalledWith({
        name: 'test-server',
        version: '1.0.0',
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'tool1' }),
          expect.objectContaining({ name: 'tool2' }),
        ]),
      });
      expect(result).toBeDefined();
    });

    it('should create MCP server for inline config without tools', () => {
      const config = {
        type: 'inline' as const,
        name: 'empty-server',
        version: '1.0.0',
      };

      provider.createMcpServer(config);

      expect(mockCreateSdkMcpServer).toHaveBeenCalledWith({
        name: 'empty-server',
        version: '1.0.0',
        tools: [],
      });
    });

    it('should throw error for stdio config', () => {
      const config = {
        type: 'stdio' as const,
        name: 'stdio-server',
        command: 'npx',
        args: ['-y', 'some-mcp-server'],
      };

      expect(() => provider.createMcpServer(config)).toThrow(
        'stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer'
      );
    });
  });

  // --------------------------------------------------------------------------
  // Process Listener Cleanup (Issue #3378)
  // --------------------------------------------------------------------------

  describe('process listener cleanup (Issue #3378)', () => {
    let exitListenersBefore: number;
    let sigintListenersBefore: number;
    let sigtermListenersBefore: number;

    beforeEach(() => {
      // Snapshot current listener counts so we can verify cleanup
      exitListenersBefore = process.listenerCount('exit');
      sigintListenersBefore = process.listenerCount('SIGINT');
      sigtermListenersBefore = process.listenerCount('SIGTERM');
    });

    afterEach(() => {
      // Ensure no leaked listeners remain after each test
      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
      expect(process.listenerCount('SIGTERM')).toBe(sigtermListenersBefore);
    });

    it('should clean up process listeners after iterator completes normally', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // Simulate SDK registering extra listeners during query
      const leakedListener = () => {};
      mockQuery.mockImplementation(() => {
        process.on('exit', leakedListener);
        process.on('SIGINT', leakedListener);
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // Consume the iterator
      for await (const _ of result.iterator) {
        // consume
      }

      // Leaked listeners should have been cleaned up
      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
      expect(process.listenerCount('SIGINT')).toBe(sigintListenersBefore);
    });

    it('should clean up process listeners after handle.close()', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const leakedListener = () => {};
      mockQuery.mockImplementation(() => {
        process.on('exit', leakedListener);
        return (async function* () {
          // never yields — simulates a hanging query
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // Close without consuming iterator
      result.handle.close();

      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
    });

    it('should not remove pre-existing listeners', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      // Register a pre-existing listener
      const preExisting = () => {};
      process.on('exit', preExisting);
      const countWithPreExisting = process.listenerCount('exit');

      mockQuery.mockImplementation(() => {
        // SDK adds one more
        process.on('exit', () => {});
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Ok' }] } };
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      for await (const _ of result.iterator) {
        // consume
      }

      // Pre-existing listener should still be present
      expect(process.listenerCount('exit')).toBe(countWithPreExisting);

      // Clean up our pre-existing listener
      process.off('exit', preExisting);
    });

    it('should not double-clean when both iterator completes and close is called', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const leakedListener = () => {};
      mockQuery.mockImplementation(() => {
        process.on('exit', leakedListener);
        return (async function* () {
          yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] } };
        })();
      });

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      const result = provider.queryStream(testInput(), {
        settingSources: ['user', 'project', 'local'],
      });

      // Consume iterator fully
      for await (const _ of result.iterator) {
        // consume
      }

      // Then also call close (should be a no-op for cleanup)
      result.handle.close();

      // Should still be at baseline, not below
      expect(process.listenerCount('exit')).toBe(exitListenersBefore);
    });
  });
});
