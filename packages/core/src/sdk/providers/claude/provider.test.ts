/**
 * Tests for ClaudeSDKProvider
 *
 * Covers all public methods of the provider including queryOnce, queryStream,
 * createInlineTool, createMcpServer, validateConfig, getInfo, and dispose.
 *
 * Issue #1617: Phase 2 - SDK provider test coverage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeSDKProvider } from './provider.js';
import type { AgentQueryOptions, InlineToolDefinition, McpServerConfig } from '../../types.js';

// Mock the adapter modules to isolate provider logic
const mockAdaptSDKMessage = vi.fn((msg: unknown) => ({
  type: 'text',
  content: `adapted: ${JSON.stringify(msg)}`,
  role: 'assistant' as const,
}));

const mockAdaptOptions = vi.fn((opts: unknown) => ({
  ...(opts as Record<string, unknown>),
  _adapted: true,
}));

const mockAdaptInput = vi.fn((input: unknown) => input);
const mockAdaptUserInput = vi.fn((input: unknown) => ({
  type: 'user',
  message: { role: 'user', content: String(input) },
  parent_tool_use_id: null,
  session_id: '',
}));

vi.mock('./message-adapter.js', () => ({
  adaptSDKMessage: (arg: unknown) => mockAdaptSDKMessage(arg),
  adaptUserInput: (arg: unknown) => mockAdaptUserInput(arg),
}));

vi.mock('./options-adapter.js', () => ({
  adaptOptions: (arg: unknown) => mockAdaptOptions(arg),
  adaptInput: (arg: unknown) => mockAdaptInput(arg),
}));

// Mock logger to suppress output during tests
vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

const baseOptions: AgentQueryOptions = {
  settingSources: ['project'],
};

describe('ClaudeSDKProvider', () => {
  let provider: ClaudeSDKProvider;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    provider = new ClaudeSDKProvider();
    originalApiKey = process.env.ANTHROPIC_API_KEY;
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalApiKey !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalApiKey;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  // ==========================================================================
  // Provider info
  // ==========================================================================

  describe('properties', () => {
    it('should have name "claude"', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have a version string', () => {
      expect(provider.version).toBeTruthy();
      expect(typeof provider.version).toBe('string');
    });
  });

  describe('getInfo', () => {
    it('should return available=true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const info = provider.getInfo();
      expect(info).toEqual({
        name: 'claude',
        version: provider.version,
        available: true,
        unavailableReason: undefined,
      });
    });

    it('should return available=false when ANTHROPIC_API_KEY is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const info = provider.getInfo();
      expect(info).toEqual({
        name: 'claude',
        version: provider.version,
        available: false,
        unavailableReason: 'ANTHROPIC_API_KEY not set',
      });
    });

    it('should return available=false when ANTHROPIC_API_KEY is empty string', () => {
      process.env.ANTHROPIC_API_KEY = '';
      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('ANTHROPIC_API_KEY not set');
    });
  });

  // ==========================================================================
  // validateConfig
  // ==========================================================================

  describe('validateConfig', () => {
    it('should return true when ANTHROPIC_API_KEY is set', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      expect(provider.validateConfig()).toBe(true);
    });

    it('should return false when ANTHROPIC_API_KEY is not set', () => {
      delete process.env.ANTHROPIC_API_KEY;
      expect(provider.validateConfig()).toBe(false);
    });

    it('should return false when ANTHROPIC_API_KEY is empty', () => {
      process.env.ANTHROPIC_API_KEY = '';
      expect(provider.validateConfig()).toBe(false);
    });
  });

  // ==========================================================================
  // dispose
  // ==========================================================================

  describe('dispose', () => {
    it('should prevent queryOnce after disposal', async () => {
      provider.dispose();
      const gen = provider.queryOnce('test', baseOptions);
      await expect(gen.next()).rejects.toThrow('Provider has been disposed');
    });

    it('should prevent queryStream after disposal', () => {
      provider.dispose();

      async function* mockInput() {
        yield { role: 'user' as const, content: 'test' };
      }

      expect(() => provider.queryStream(mockInput(), baseOptions)).toThrow(
        'Provider has been disposed'
      );
    });

    it('should allow dispose to be called multiple times', () => {
      provider.dispose();
      provider.dispose();
    });
  });

  // ==========================================================================
  // queryStream - structure and lifecycle
  // ==========================================================================

  describe('queryStream', () => {
    function createMockInputStream(messages: Array<{ role: 'user'; content: string }>) {
      async function* inputStream() {
        for (const msg of messages) {
          yield msg;
        }
      }
      return inputStream();
    }

    it('should return handle and iterator', () => {
      const inputStream = createMockInputStream([
        { role: 'user', content: 'Hello' },
      ]);

      const result = provider.queryStream(inputStream, baseOptions);

      expect(result).toHaveProperty('handle');
      expect(result).toHaveProperty('iterator');
      expect(result.handle).toHaveProperty('close');
      expect(result.handle).toHaveProperty('cancel');
      expect(result.handle).toHaveProperty('sessionId');
    });

    it('should have undefined sessionId by default', () => {
      const inputStream = createMockInputStream([]);

      const result = provider.queryStream(inputStream, baseOptions);
      expect(result.handle.sessionId).toBeUndefined();
    });

    it('should not throw when close/cancel called on async generator result', () => {
      const inputStream = createMockInputStream([]);

      const result = provider.queryStream(inputStream, baseOptions);

      expect(() => result.handle.close()).not.toThrow();
      expect(() => result.handle.cancel()).not.toThrow();
    });

    it('should throw when called on disposed provider', () => {
      provider.dispose();

      const inputStream = createMockInputStream([]);
      expect(() => provider.queryStream(inputStream, baseOptions)).toThrow(
        'Provider has been disposed'
      );
    });

    it('should return an async iterable iterator', () => {
      const inputStream = createMockInputStream([]);

      const result = provider.queryStream(inputStream, baseOptions);
      expect(typeof result.iterator[Symbol.asyncIterator]).toBe('function');
    });
  });

  // ==========================================================================
  // createInlineTool
  // ==========================================================================

  describe('createInlineTool', () => {
    it('should delegate to SDK tool function and return a result', () => {
      const handler = vi.fn(() => Promise.resolve('result'));
      const definition: InlineToolDefinition = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: {} as InlineToolDefinition['parameters'],
        handler,
      };

      const result = provider.createInlineTool(definition);

      // Verify the result is an SDK tool object
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });
  });

  // ==========================================================================
  // createMcpServer
  // ==========================================================================

  describe('createMcpServer', () => {
    it('should create inline MCP server with tools', () => {
      const handler1 = vi.fn(() => Promise.resolve('result1'));
      const handler2 = vi.fn(() => Promise.resolve('result2'));

      const tools = [
        {
          name: 'tool1',
          description: 'Tool 1',
          parameters: {} as InlineToolDefinition['parameters'],
          handler: handler1,
        },
        {
          name: 'tool2',
          description: 'Tool 2',
          parameters: {} as InlineToolDefinition['parameters'],
          handler: handler2,
        },
      ];

      const config: McpServerConfig = {
        type: 'inline',
        name: 'test-server',
        version: '1.0.0',
        tools,
      };

      const result = provider.createMcpServer(config);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should create inline MCP server without tools', () => {
      const config: McpServerConfig = {
        type: 'inline',
        name: 'empty-server',
        version: '2.0.0',
      };

      const result = provider.createMcpServer(config);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should create inline MCP server with empty tools array', () => {
      const config: McpServerConfig = {
        type: 'inline',
        name: 'no-tools-server',
        version: '3.0.0',
        tools: [],
      };

      const result = provider.createMcpServer(config);

      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    it('should throw for stdio type config', () => {
      const config: McpServerConfig = {
        type: 'stdio',
        name: 'stdio-server',
        command: 'npx',
        args: ['-y', 'my-server'],
      };

      expect(() => provider.createMcpServer(config)).toThrow(
        'stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer'
      );
    });
  });
});
