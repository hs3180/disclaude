/**
 * Tests for BaseAgent query execution functions.
 *
 * Tests extracted from base-agent.ts (Issue #2345 Phase 2):
 * - executeQueryOnce: one-shot query via ACP session
 * - createStreamQuery: streaming conversation query
 * - formatMessage: parsed message to AgentMessage conversion
 * - handleIteratorError: error handling and wrapping
 *
 * Issue #1617 Phase 2: Agent layer testing.
 */

import { describe, it, expect, vi, type Mock } from 'vitest';
import {
  executeQueryOnce,
  createStreamQuery,
  formatMessage,
  handleIteratorError,
  type QueryContext,
} from './base-agent-query.js';
import type { AgentQueryOptions, AgentMessage as SdkAgentMessage, StreamingUserMessage } from '../sdk/index.js';
import type { Logger } from '../utils/logger.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock AcpClient for testing */
function createMockAcpClient() {
  return {
    state: 'disconnected' as string,
    connect: vi.fn(() => {
      return Promise.resolve({ protocolVersion: 1 });
    }),
    disconnect: vi.fn(() => Promise.resolve()),
    createSession: vi.fn((_cwd: string, _options?: unknown) => ({
      sessionId: 'test-session-id',
      model: 'claude-3-5-sonnet',
    })),
    sendPrompt: vi.fn() as Mock,
    cancelPrompt: vi.fn(async (_sessionId: string) => {}),
  };
}

/** Create a mock logger */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as unknown as Logger;
}

/** Create a QueryContext with mock dependencies */
function createQueryContext(overrides?: Partial<QueryContext>): QueryContext {
  const acpClient = createMockAcpClient() as unknown as QueryContext['acpClient'];
  // Default sendPrompt: empty generator
  (acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {});

  return {
    acpClient,
    logger: createMockLogger(),
    provider: 'anthropic',
    ensureClientConnected: vi.fn(async () => {}),
    getWorkspaceDir: vi.fn(() => '/workspace/test'),
    ...overrides,
  };
}

/** Default query options for tests */
const defaultOptions: AgentQueryOptions = {
  cwd: '/workspace/test',
  settingSources: ['project'],
};

/** Create a mock SdkAgentMessage */
function createMockMessage(overrides?: Partial<SdkAgentMessage>): SdkAgentMessage {
  return {
    type: 'text',
    content: 'Hello from agent',
    role: 'assistant',
    ...overrides,
  };
}

// ============================================================================
// executeQueryOnce
// ============================================================================

describe('executeQueryOnce', () => {
  it('should yield messages from ACP session', async () => {
    const messages = [
      createMockMessage({ type: 'text', content: 'First message' }),
      createMockMessage({ type: 'text', content: 'Second message' }),
    ];

    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      for (const msg of messages) {
        yield msg;
      }
    });

    const results = [];
    for await (const item of executeQueryOnce(ctx, 'test prompt', defaultOptions)) {
      results.push(item);
    }

    expect(results).toHaveLength(2);
    expect(results[0].parsed.content).toBe('First message');
    expect(results[1].parsed.content).toBe('Second message');
  });

  it('should create session with correct workspace directory', async () => {
    const ctx = createQueryContext();

    await (async () => {
      for await (const _ of executeQueryOnce(ctx, 'test', defaultOptions)) {
        break;
      }
    })();

    expect(ctx.acpClient.createSession).toHaveBeenCalledWith(
      '/workspace/test',
      expect.any(Object),
    );
  });

  it('should ensure client is connected before creating session', async () => {
    const ctx = createQueryContext();

    await (async () => {
      for await (const _ of executeQueryOnce(ctx, 'test', defaultOptions)) {
        break;
      }
    })();

    expect(ctx.ensureClientConnected).toHaveBeenCalled();
  });

  it('should accept string input', async () => {
    const ctx = createQueryContext();

    await (async () => {
      for await (const _ of executeQueryOnce(ctx, 'Hello world', defaultOptions)) {
        break;
      }
    })();

    expect(ctx.acpClient.sendPrompt).toHaveBeenCalledWith(
      'test-session-id',
      [{ type: 'text', text: 'Hello world' }],
    );
  });

  it('should stringify array input', async () => {
    const ctx = createQueryContext();
    const input = [{ role: 'user', content: 'Hello' }];

    await (async () => {
      for await (const _ of executeQueryOnce(ctx, input, defaultOptions)) {
        break;
      }
    })();

    expect(ctx.acpClient.sendPrompt).toHaveBeenCalledWith(
      'test-session-id',
      [{ type: 'text', text: JSON.stringify(input) }],
    );
  });

  it('should convert messages to legacy format', async () => {
    const sdkMessage = createMockMessage({
      type: 'tool_use',
      content: 'Using tool',
      metadata: {
        toolName: 'read_file',
        toolInput: { path: '/test.txt' },
        elapsedMs: 100,
        costUsd: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      },
    });

    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield sdkMessage;
    });

    const results = [];
    for await (const item of executeQueryOnce(ctx, 'test', defaultOptions)) {
      results.push(item);
    }

    expect(results[0].parsed.type).toBe('tool_use');
    expect(results[0].parsed.metadata?.toolName).toBe('read_file');
    expect(results[0].parsed.metadata?.tokens).toBe(75);
    expect(results[0].raw).toBe(sdkMessage);
  });

  it('should handle empty response (no messages)', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {});

    const results = [];
    for await (const item of executeQueryOnce(ctx, 'test', defaultOptions)) {
      results.push(item);
    }

    expect(results).toHaveLength(0);
  });

  it('should log debug messages for each received message', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage({ type: 'text', content: 'response' });
    });

    for await (const _ of executeQueryOnce(ctx, 'test', defaultOptions)) {
      // consume
    }

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        messageType: 'text',
      }),
      'ACP message received',
    );
  });

  it('should log session completion in finally block', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage();
    });

    for await (const _ of executeQueryOnce(ctx, 'test', defaultOptions)) {
      // consume
    }

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'test-session-id' }),
      'queryOnce session completed',
    );
  });

  it('should still log session completion when no messages are yielded', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {});

    for await (const _ of executeQueryOnce(ctx, 'test', defaultOptions)) {
      // empty
    }

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'test-session-id' }),
      'queryOnce session completed',
    );
  });
});

// ============================================================================
// createStreamQuery
// ============================================================================

describe('createStreamQuery', () => {
  /** Create an async generator that yields user messages */
  async function* createInputGenerator(messages: string[]) {
    for (const text of messages) {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: text },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };
    }
  }

  it('should return handle and iterator', () => {
    const ctx = createQueryContext();
    const input = createInputGenerator(['hello']);
    const result = createStreamQuery(ctx, input, defaultOptions);

    expect(result.handle).toBeDefined();
    expect(result.iterator).toBeDefined();
    expect(result.handle.close).toBeInstanceOf(Function);
    expect(result.handle.cancel).toBeInstanceOf(Function);
  });

  it('should yield messages from streaming conversation', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage({ type: 'text', content: 'Agent response' });
    });

    const input = createInputGenerator(['user message']);
    const { iterator } = createStreamQuery(ctx, input, defaultOptions);

    const results = [];
    for await (const item of iterator) {
      results.push(item);
    }

    expect(results).toHaveLength(1);
    expect(results[0].parsed.content).toBe('Agent response');
  });

  it('should handle multiple input messages in same session', async () => {
    const ctx = createQueryContext();
    let callCount = 0;
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      callCount++;
      yield createMockMessage({ content: `Response ${callCount}` });
    });

    const input = createInputGenerator(['msg1', 'msg2', 'msg3']);
    const { iterator } = createStreamQuery(ctx, input, defaultOptions);

    const results = [];
    for await (const item of iterator) {
      results.push(item);
    }

    expect(results).toHaveLength(3);
    expect(ctx.acpClient.createSession).toHaveBeenCalledTimes(1);
  });

  it('should create session lazily (only when iterator is consumed)', () => {
    const ctx = createQueryContext();
    const input = createInputGenerator(['hello']);

    createStreamQuery(ctx, input, defaultOptions);

    // Session should NOT be created yet (lazy initialization)
    expect(ctx.acpClient.createSession).not.toHaveBeenCalled();
  });

  it('should expose sessionId on handle after session creation', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage();
    });

    const input = createInputGenerator(['hello']);
    const { handle, iterator } = createStreamQuery(ctx, input, defaultOptions);

    // Before consuming, sessionId is undefined
    expect(handle.sessionId).toBeUndefined();

    // Consume iterator to trigger session creation
    for await (const _ of iterator) {
      break;
    }

    expect(handle.sessionId).toBe('test-session-id');
  });

  it('should stop yielding when handle.close() is called', async () => {
    const ctx = createQueryContext();
    let promptCallCount = 0;
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      promptCallCount++;
      yield createMockMessage({ content: `Response ${promptCallCount}` });
    });

    // Create input that yields 3 messages
    const input = createInputGenerator(['msg1', 'msg2', 'msg3']);
    const { handle, iterator } = createStreamQuery(ctx, input, defaultOptions);

    const results = [];
    let count = 0;
    for await (const item of iterator) {
      results.push(item);
      count++;
      if (count >= 1) {
        handle.close();
      }
    }

    // Should stop after first message due to close
    expect(results.length).toBeLessThanOrEqual(1);
  });

  it('should cancel prompt on ACP client when handle.cancel() is called', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage();
    });

    const input = createInputGenerator(['msg1', 'msg2']);
    const { handle, iterator } = createStreamQuery(ctx, input, defaultOptions);

    // Consume to trigger session creation
    for await (const _item of iterator) {
      handle.cancel();
      break;
    }

    expect(ctx.acpClient.cancelPrompt).toHaveBeenCalledWith('test-session-id');
  });

  it('should handle cancel before session is created', () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage();
    });

    const input = createInputGenerator(['msg1']);
    const { handle } = createStreamQuery(ctx, input, defaultOptions);

    // Cancel before consuming iterator (session not created yet)
    handle.cancel();

    // Should NOT throw, and cancelPrompt should not be called yet
    expect(ctx.acpClient.cancelPrompt).not.toHaveBeenCalled();
  });

  it('should set pendingCancel when cancel is called before session creation', async () => {
    const ctx = createQueryContext();
    // Delay session creation slightly
    let resolveSessionCreation: (value: unknown) => void;
    const sessionCreationPromise = new Promise((resolve) => {
      resolveSessionCreation = resolve;
    });

    (ctx.acpClient as unknown as { createSession: Mock }).createSession.mockImplementation(async () => {
      await sessionCreationPromise;
      return { sessionId: 'delayed-session', model: 'claude-3-5-sonnet' };
    });
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {});

    const input = createInputGenerator(['msg1']);
    const { handle, iterator } = createStreamQuery(ctx, input, defaultOptions);

    // Start consuming (will block on session creation)
    const consumePromise = (async () => {
      for await (const _ of iterator) { /* consume */ }
    })();

    // Give the iterator time to start creating the session
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Cancel before session is ready
    handle.cancel();

    // Now resolve session creation
    resolveSessionCreation!(undefined);

    await consumePromise;

    // Cancel should be called once session is created
    expect(ctx.acpClient.cancelPrompt).toHaveBeenCalledWith('delayed-session');
  });

  it('should ensure client is connected before creating session', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage();
    });

    const input = createInputGenerator(['hello']);
    const { iterator } = createStreamQuery(ctx, input, defaultOptions);

    for await (const _ of iterator) {
      break;
    }

    expect(ctx.ensureClientConnected).toHaveBeenCalled();
  });

  it('should convert string message content correctly', async () => {
    const ctx = createQueryContext();
    let receivedPrompt: unknown;
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* (_sid: string, prompt: unknown) {
      receivedPrompt = prompt;
      yield createMockMessage();
    });

    const input = createInputGenerator(['Hello World']);
    const { iterator } = createStreamQuery(ctx, input, defaultOptions);

    for await (const _ of iterator) {
      break;
    }

    expect(receivedPrompt).toEqual([{ type: 'text', text: 'Hello World' }]);
  });

  it('should stringify non-string message content', async () => {
    const ctx = createQueryContext();
    let receivedPrompt: unknown;
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* (_sid: string, prompt: unknown) {
      receivedPrompt = prompt;
      yield createMockMessage();
    });

    // Create input with array content (non-string)
    async function* arrayContentInput() {
      yield {
        type: 'user' as const,
        message: {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: 'image description' }],
        },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };
    }

    const { iterator } = createStreamQuery(ctx, arrayContentInput(), defaultOptions);

    for await (const _ of iterator) {
      break;
    }

    expect(receivedPrompt).toEqual([
      { type: 'text', text: JSON.stringify([{ type: 'text', text: 'image description' }]) },
    ]);
  });

  it('should handle empty content gracefully', async () => {
    const ctx = createQueryContext();
    let receivedPrompt: unknown;
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* (_sid: string, prompt: unknown) {
      receivedPrompt = prompt;
      yield createMockMessage();
    });

    async function* emptyContentInput() {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content: undefined },
        parent_tool_use_id: null,
        session_id: 'test-session',
      };
    }

    const { iterator } = createStreamQuery(ctx, emptyContentInput() as AsyncGenerator<StreamingUserMessage>, defaultOptions);

    for await (const _ of iterator) {
      break;
    }

    expect(receivedPrompt).toEqual([{ type: 'text', text: '""' }]);
  });

  it('should log debug for each received message', async () => {
    const ctx = createQueryContext();
    (ctx.acpClient as unknown as { sendPrompt: Mock }).sendPrompt.mockImplementation(async function* () {
      yield createMockMessage({ type: 'text', content: 'response' });
    });

    const input = createInputGenerator(['hello']);
    const { iterator } = createStreamQuery(ctx, input, defaultOptions);

    for await (const _ of iterator) {
      // consume
    }

    expect(ctx.logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        messageType: 'text',
      }),
      'ACP message received',
    );
  });
});

// ============================================================================
// formatMessage
// ============================================================================

describe('formatMessage', () => {
  it('should convert parsed message to AgentMessage format', () => {
    const parsed = {
      type: 'text',
      content: 'Hello world',
      metadata: { toolName: 'test_tool' },
    };

    const result = formatMessage(parsed);

    expect(result).toEqual({
      content: 'Hello world',
      role: 'assistant',
      messageType: 'text',
      metadata: { toolName: 'test_tool' },
    });
  });

  it('should handle parsed message without metadata', () => {
    const parsed = {
      type: 'result',
      content: 'Task done',
    };

    const result = formatMessage(parsed);

    expect(result).toEqual({
      content: 'Task done',
      role: 'assistant',
      messageType: 'result',
      metadata: undefined,
    });
  });

  it('should preserve error type', () => {
    const parsed = {
      type: 'error',
      content: 'Something went wrong',
    };

    const result = formatMessage(parsed);

    expect(result.messageType).toBe('error');
    expect(result.content).toBe('Something went wrong');
  });

  it('should handle empty content', () => {
    const parsed = {
      type: 'text',
      content: '',
    };

    const result = formatMessage(parsed);

    expect(result.content).toBe('');
  });

  it('should handle complex metadata', () => {
    const parsed = {
      type: 'tool_result',
      content: 'Tool output',
      metadata: {
        toolName: 'read_file',
        toolInput: { path: '/test.txt' },
        toolOutput: 'file contents',
        elapsed: 200,
        cost: 0.005,
        tokens: 150,
      },
    };

    const result = formatMessage(parsed);

    expect(result.metadata).toEqual(parsed.metadata);
  });
});

// ============================================================================
// handleIteratorError
// ============================================================================

describe('handleIteratorError', () => {
  it('should return error AgentMessage with Error instance', () => {
    const logger = createMockLogger();
    const error = new Error('Something broke');

    const result = handleIteratorError('TestAgent', logger, error, 'query');

    expect(result.role).toBe('assistant');
    expect(result.messageType).toBe('error');
    expect(result.content).toBe('❌ Error: Something broke');
  });

  it('should handle non-Error thrown values', () => {
    const logger = createMockLogger();
    const error = 'string error message';

    const result = handleIteratorError('TestAgent', logger, error, 'execution');

    expect(result.messageType).toBe('error');
    expect(result.content).toBe('❌ Error: string error message');
  });

  it('should handle numeric error values', () => {
    const logger = createMockLogger();
    const error = 42;

    const result = handleIteratorError('TestAgent', logger, error, 'stream');

    expect(result.content).toBe('❌ Error: 42');
  });

  it('should handle null/undefined error values', () => {
    const logger = createMockLogger();

    const result = handleIteratorError('TestAgent', logger, null, 'query');

    expect(result.content).toBe('❌ Error: null');
  });

  it('should log error with formatted message', () => {
    const logger = createMockLogger();
    const error = new Error('test error');

    handleIteratorError('TestAgent', logger, error, 'query');

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      'query failed',
    );
  });

  it('should include agent name in error context', () => {
    const logger = createMockLogger();
    const error = new Error('test');

    handleIteratorError('MyCustomAgent', logger, error, 'processing');

    // The error should be logged - verify the call was made
    expect(logger.error).toHaveBeenCalledTimes(1);
    // The logged object should contain formatted error info
    const { calls } = (logger.error as ReturnType<typeof vi.fn>).mock;
    expect(calls[0][0]).toHaveProperty('err');
  });

  it('should handle undefined error', () => {
    const logger = createMockLogger();

    const result = handleIteratorError('TestAgent', logger, undefined, 'query');

    expect(result.content).toBe('❌ Error: undefined');
    expect(result.messageType).toBe('error');
  });

  it('should handle object error', () => {
    const logger = createMockLogger();
    const error = { code: 'ERR_TIMEOUT', message: 'Request timed out' };

    const result = handleIteratorError('TestAgent', logger, error, 'request');

    expect(result.content).toBe('❌ Error: [object Object]');
    expect(result.messageType).toBe('error');
  });

  it('should use provided operation name in log message', () => {
    const logger = createMockLogger();
    const error = new Error('test');

    handleIteratorError('Agent', logger, error, 'custom-operation');

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(Object),
      'custom-operation failed',
    );
  });

  it('should create AppError with SDK category and retryable flag', () => {
    const logger = createMockLogger();
    const error = new Error('connection lost');

    handleIteratorError('MyAgent', logger, error, 'query');

    // Verify error was logged with formatted error info
    const { calls } = (logger.error as ReturnType<typeof vi.fn>).mock;
    const [[loggedArg]] = calls;
    expect(loggedArg).toHaveProperty('err');
    // The err field is a Record from formatError(AppError), containing message
    const errObj = loggedArg.err as Record<string, unknown>;
    expect(errObj.message).toContain('MyAgent query failed');
    expect(errObj.category).toBe('SDK');
    expect(errObj.retryable).toBe(true);
  });

  it('should wrap non-Error cause inside AppError', () => {
    const logger = createMockLogger();
    const error = 'plain string error';

    const result = handleIteratorError('Agent', logger, error, 'test');

    // Should still log the error properly
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(result.content).toBe('❌ Error: plain string error');
  });
});

// ============================================================================
// formatMessage - sessionId
// ============================================================================

describe('formatMessage - sessionId handling', () => {
  it('should not include sessionId in AgentMessage output', () => {
    const parsed = {
      type: 'result',
      content: 'Done',
      sessionId: 'session-abc-123',
    };

    const result = formatMessage(parsed);

    // formatMessage produces { content, role, messageType, metadata }
    // sessionId is NOT mapped to the output AgentMessage
    expect(result).toEqual({
      content: 'Done',
      role: 'assistant',
      messageType: 'result',
      metadata: undefined,
    });
  });

  it('should preserve sessionId when it is in metadata', () => {
    const parsed = {
      type: 'tool_result',
      content: 'output',
      metadata: { sessionId: 'session-in-metadata' },
    };

    const result = formatMessage(parsed);

    expect(result.metadata?.sessionId).toBe('session-in-metadata');
  });
});
