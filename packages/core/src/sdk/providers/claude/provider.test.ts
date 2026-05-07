/**
 * Tests for Claude SDK Provider.
 *
 * Issue #2920: Tests for StderrCapture, getErrorStderr, isStartupFailure.
 * Issue #1617: Phase 2 - ClaudeSDKProvider class test coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StderrCapture, getErrorStderr, isStartupFailure, attachStderrToError, ClaudeSDKProvider } from './provider.js';
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

// Mock the logger to prevent noise in test output
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
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
  }),
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

  beforeEach(() => {
    vi.clearAllMocks();
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    provider = new ClaudeSDKProvider();
  });

  afterEach(() => {
    if (originalApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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

    it('should pass adapted options to SDK query', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';

      mockQuery.mockReturnValue((async function* () {
        // no messages
      })());

      async function* testInput(): AsyncGenerator<UserInput> {
        yield { role: 'user', content: 'Test' };
      }

      provider.queryStream(testInput(), {
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
        settingSources: ['project'],
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
