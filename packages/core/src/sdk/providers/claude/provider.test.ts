/**
 * Tests for Claude SDK Provider.
 *
 * Issue #1617: Comprehensive tests including stderr capture utilities
 * AND ClaudeSDKProvider class methods (queryStream, createInlineTool,
 * createMcpServer, validateConfig, getInfo, dispose).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StderrCapture, getErrorStderr, isStartupFailure, attachStderrToError, ClaudeSDKProvider } from './provider.js';
import type { AgentMessage, AgentQueryOptions, UserInput } from '../../types.js';

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

// vi.mock is the appropriate strategy for testing the SDK provider layer.
// The project ESLint rule (no-restricted-syntax for @anthropic-ai/) exists
// to encourage nock VCR for HTTP-level testing (Issue #918), but here we
// test the SDK abstraction itself — nock cannot intercept SDK function calls.
// eslint-disable-next-line no-restricted-syntax
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => createMockQueryResult([])),
  tool: vi.fn((name: string, desc: string, params: unknown, handler: unknown) => ({ name, desc, params, handler })),
  createSdkMcpServer: vi.fn((config: { name: string }) => ({ type: 'sdk', name: config.name, instance: {} })),
}));

function createMockQueryResult(messages: unknown[] = []) {
  const close = vi.fn();
  const cancel = vi.fn();
  async function* iterator(): AsyncGenerator<unknown> {
    for (const msg of messages) {
      yield msg;
    }
  }
  const gen = iterator();
  return Object.assign(gen, { close, cancel });
}

// Import mocked SDK after vi.mock setup
import * as mockedSdk from '@anthropic-ai/claude-agent-sdk';

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ClaudeSDKProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('properties', () => {
    it('should have correct name and version', () => {
      expect(provider.name).toBe('claude');
      expect(provider.version).toBe('0.2.19');
    });
  });

  describe('validateConfig', () => {
    it('should return true when ANTHROPIC_API_KEY is set', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      expect(provider.validateConfig()).toBe(true);

      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it('should return false when ANTHROPIC_API_KEY is not set', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      expect(provider.validateConfig()).toBe(false);

      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it('should return false when ANTHROPIC_API_KEY is empty string', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = '';

      expect(provider.validateConfig()).toBe(false);

      process.env.ANTHROPIC_API_KEY = originalKey;
    });
  });

  describe('getInfo', () => {
    it('should return available provider info when API key is set', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      const info = provider.getInfo();

      expect(info.name).toBe('claude');
      expect(info.version).toBe('0.2.19');
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();

      process.env.ANTHROPIC_API_KEY = originalKey;
    });

    it('should return unavailable provider info when API key is missing', () => {
      const originalKey = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;

      const info = provider.getInfo();

      expect(info.name).toBe('claude');
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('ANTHROPIC_API_KEY not set');

      process.env.ANTHROPIC_API_KEY = originalKey;
    });
  });

  describe('dispose', () => {
    it('should prevent queryStream after disposal', () => {
      provider.dispose();

      function* mockInput(): Generator<UserInput> {
        yield { role: 'user', content: 'test' };
      }

      // Wrap sync generator as async
      async function* asyncWrap(): AsyncGenerator<UserInput> {
        yield* mockInput();
      }

      expect(() => provider.queryStream(asyncWrap(), {
        cwd: '/workspace',
        permissionMode: 'bypassPermissions',
        settingSources: ['project'],
      })).toThrow('Provider has been disposed');
    });

    it('should allow multiple dispose calls without error', () => {
      provider.dispose();
      expect(() => provider.dispose()).not.toThrow();
    });
  });

  describe('queryStream', () => {
    const defaultOptions: AgentQueryOptions = {
      cwd: '/workspace',
      permissionMode: 'bypassPermissions',
      settingSources: ['project'],
    };

    it('should return handle and iterator', () => {
      const mockResult = createMockQueryResult([{
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello response' }],
        },
      }]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);

      expect(result.handle).toBeDefined();
      expect(result.handle.close).toBeInstanceOf(Function);
      expect(result.handle.cancel).toBeInstanceOf(Function);
      expect(result.iterator).toBeDefined();
    });

    it('should yield adapted messages from SDK stream', async () => {
      const mockResult = createMockQueryResult([{
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Hello from Claude' }],
        },
      }]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
      expect(messages[0].content).toBe('Hello from Claude');
      expect(messages[0].role).toBe('assistant');
    });

    it('should handle tool_use messages from SDK', async () => {
      const mockResult = createMockQueryResult([{
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } },
          ],
        },
      }]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'List files' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('tool_use');
      expect(messages[0].metadata?.toolName).toBe('Bash');
    });

    it('should handle multiple messages from SDK stream', async () => {
      const mockResult = createMockQueryResult([
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Let me check...' }],
          },
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Here is the result.' }],
          },
        },
      ]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Check' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);
      const collected: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        collected.push(msg);
      }

      expect(collected).toHaveLength(2);
    });

    it('should handle empty SDK stream', async () => {
      const mockResult = createMockQueryResult([]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);
      const messages: AgentMessage[] = [];
      for await (const msg of result.iterator) {
        messages.push(msg);
      }

      expect(messages).toHaveLength(0);
    });

    it('should propagate errors from SDK stream', async () => {
      async function* errorIterator(): AsyncGenerator<never> {
        throw new Error('SDK internal error');
      }
      const close = vi.fn();
      const cancel = vi.fn();
      const gen = errorIterator();
      const mockResult = Object.assign(gen, { close, cancel });
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), {
        ...defaultOptions,
        stderr: vi.fn(),
      });

      await expect((async () => {
        for await (const _ of result.iterator) {
          // consume
        }
      })()).rejects.toThrow('SDK internal error');
    });

    it('should call handle.close to close the stream', () => {
      const mockResult = createMockQueryResult([]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);

      result.handle.close();
      expect(mockResult.close).toHaveBeenCalled();
    });

    it('should call handle.cancel to cancel the stream', () => {
      const mockResult = createMockQueryResult([]);
      vi.mocked(mockedSdk.query).mockReturnValue(mockResult as unknown as ReturnType<typeof mockedSdk.query>);

      async function* mockInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Hello' };
      }

      const result = provider.queryStream(mockInput(), defaultOptions);

      result.handle.cancel();
      expect(mockResult.cancel).toHaveBeenCalled();
    });
  });

  describe('createInlineTool', () => {
    it('should create an inline tool using the SDK tool function', () => {
      const definition = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: { type: 'object' as const, properties: {} },
        handler: vi.fn(),
      };

      provider.createInlineTool(definition);

      expect(mockedSdk.tool).toHaveBeenCalledWith(
        'test-tool',
        'A test tool',
        definition.parameters,
        definition.handler,
      );
    });
  });

  describe('createMcpServer', () => {
    it('should create inline MCP server with tools', () => {
      provider.createMcpServer({
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools: [{
          name: 'test-tool',
          description: 'A test tool',
          parameters: { type: 'object' as const, properties: {} },
          handler: vi.fn(),
        }],
      });

      expect(mockedSdk.createSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-server',
          version: '1.0.0',
        }),
      );
    });

    it('should create inline MCP server with no tools', () => {
      provider.createMcpServer({
        type: 'inline',
        name: 'empty-server',
        version: '1.0.0',
      });

      expect(mockedSdk.createSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'empty-server',
          version: '1.0.0',
          tools: [],
        }),
      );
    });

    it('should throw error for stdio MCP server type', () => {
      expect(() => provider.createMcpServer({
        type: 'stdio',
        command: 'node',
        args: ['server.js'],
      })).toThrow('stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer');
    });
  });
});
