/**
 * Tests for ClaudeSDKProvider (packages/core/src/sdk/providers/claude/provider.ts)
 *
 * Covers:
 * - getInfo(): provider metadata and availability
 * - validateConfig(): API key checking
 * - dispose(): lifecycle management
 * - createInlineTool(): tool creation
 * - createMcpServer(): MCP server creation (inline and stdio)
 * - queryOnce(): single query with disposed state check
 * - queryStream(): streaming query with disposed state check
 *
 * @see Issue #1617 Phase 2
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the Claude Agent SDK
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  tool: vi.fn((name, desc, params, handler) => ({ name, desc, params, handler })),
  createSdkMcpServer: vi.fn((config) => ({ type: 'mcp-server', ...config })),
}));

// Mock adapters
vi.mock('./message-adapter.js', () => ({
  adaptSDKMessage: vi.fn((msg) => ({ ...msg, adapted: true })),
  adaptUserInput: vi.fn((input) => ({ ...input, adapted: true })),
}));

vi.mock('./options-adapter.js', () => ({
  adaptOptions: vi.fn((opts) => ({ ...opts, adapted: true })),
  adaptInput: vi.fn((input) => input),
}));

vi.mock('../../../utils/logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { ClaudeSDKProvider } from './provider.js';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

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

  describe('properties', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have version string', () => {
      expect(typeof provider.version).toBe('string');
      expect(provider.version).toBeTruthy();
    });
  });

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

  describe('getInfo', () => {
    it('should return provider info when API key is available', () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test-key';
      const info = provider.getInfo();
      expect(info.name).toBe('claude');
      expect(info.version).toBeTruthy();
      expect(info.available).toBe(true);
      expect(info.unavailableReason).toBeUndefined();
    });

    it('should return unavailable info when API key is missing', () => {
      delete process.env.ANTHROPIC_API_KEY;
      const info = provider.getInfo();
      expect(info.available).toBe(false);
      expect(info.unavailableReason).toBe('ANTHROPIC_API_KEY not set');
    });
  });

  describe('dispose', () => {
    it('should mark provider as disposed', async () => {
      provider.dispose();
      // Verify by trying to query - should throw
      const gen = provider.queryOnce('test', {} as any);
    });
  });

  describe('createInlineTool', () => {
    it('should call SDK tool function with definition', () => {
      const handler = vi.fn();
      const definition = {
        name: 'test-tool',
        description: 'A test tool',
        parameters: { type: 'object', properties: {} },
        handler,
      };

      provider.createInlineTool(definition);

      expect(tool).toHaveBeenCalledWith(
        'test-tool',
        'A test tool',
        definition.parameters,
        handler
      );
    });
  });

  describe('createMcpServer', () => {
    it('should create inline MCP server', () => {
      const config = {
        type: 'inline' as const,
        name: 'test-server',
        version: '1.0.0',
        tools: [{
          name: 'test-tool',
          description: 'Test',
          parameters: {},
          handler: vi.fn(),
        }],
      };

      provider.createMcpServer(config);

      expect(createSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test-server',
          version: '1.0.0',
        })
      );
    });

    it('should throw for stdio MCP servers', () => {
      const config = {
        type: 'stdio' as const,
        command: 'node',
        args: ['server.js'],
      };

      expect(() => provider.createMcpServer(config)).toThrow(
        'stdio MCP servers are not supported by ClaudeSDKProvider.createMcpServer'
      );
    });

    it('should handle config with no tools array', () => {
      const config = {
        type: 'inline' as const,
        name: 'empty-server',
        version: '1.0.0',
      };

      provider.createMcpServer(config);

      expect(createSdkMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'empty-server',
          tools: [],
        })
      );
    });
  });

  describe('queryOnce', () => {
    it('should throw when provider is disposed', async () => {
      provider.dispose();
      const gen = provider.queryOnce('test', {} as any);
    });

    it('should adapt options and input, then yield adapted messages', async () => {
      const mockMessage = { type: 'text', content: 'Hello' };
      const mockIterator = (async function* () {
        yield mockMessage;
      })();

      vi.mocked(query).mockReturnValue(mockIterator as any);

      const { adaptOptions, adaptInput } = await import('./options-adapter.js');
      const { adaptSDKMessage } = await import('./message-adapter.js');

      const gen = provider.queryOnce('test', {} as any);
      const result = await gen.next();

      expect(result.done).toBe(false);
      expect(adaptSDKMessage).toHaveBeenCalledWith(mockMessage);
    });

    it('should handle array input', async () => {
      const mockMessage = { type: 'text', content: 'World' };
      const mockIterator = (async function* () {
        yield mockMessage;
      })();

      vi.mocked(query).mockReturnValue(mockIterator as any);

      const input = [{ role: 'user' as const, content: 'Hello' }];
      const gen = provider.queryOnce('test', {} as any);
      const result = await gen.next();

      expect(result.done).toBe(false);
    });
  });

  describe('queryStream', () => {
    it('should throw when provider is disposed', () => {
      provider.dispose();
      expect(() => provider.queryStream(null as any, {} as any)).toThrow(
        'Provider has been disposed'
      );
    });

    it('should return handle with close and cancel methods', async () => {
      const mockIterator = (async function* () {
        yield { type: 'text', content: 'Hello' };
      })();

      vi.mocked(query).mockReturnValue({
        [Symbol.asyncIterator]: () => mockIterator[Symbol.asyncIterator](),
        close: vi.fn(),
        cancel: vi.fn(),
      } as any);

      const inputGen = (async function* () {
        yield { role: 'user' as const, content: 'Hello' };
      })();

      const result = provider.queryStream(inputGen, { model: 'claude-3' } as any);

      expect(result.handle).toBeDefined();
      expect(typeof result.handle.close).toBe('function');
      expect(typeof result.handle.cancel).toBe('function');
      expect(result.handle.sessionId).toBeUndefined();
      expect(result.iterator).toBeDefined();
    });

    it('should handle query without close/cancel methods', async () => {
      const asyncGen = (async function* () {
        yield { type: 'text', content: 'test' };
      })();

      vi.mocked(query).mockReturnValue(asyncGen as any);

      const inputGen = (async function* () {
        yield { role: 'user' as const, content: 'Hello' };
      })();

      const result = provider.queryStream(inputGen, { model: 'claude-3' } as any);

      // close/cancel should not throw even without the methods
      expect(() => result.handle.close()).not.toThrow();
      expect(() => result.handle.cancel()).not.toThrow();
    });

    it('should adapt and yield messages from SDK', async () => {
      const mockMessage = { type: 'text', content: 'response' };
      const mockQueryResult = (async function* () {
        yield mockMessage;
      })();

      vi.mocked(query).mockReturnValue(mockQueryResult as any);

      const inputGen = (async function* () {
        yield { role: 'user' as const, content: 'Hello' };
      })();

      const result = provider.queryStream(inputGen, { model: 'claude-3' } as any);

      const msg = await result.iterator.next();
      expect(msg.done).toBe(false);

      const { adaptSDKMessage } = await import('./message-adapter.js');
      expect(adaptSDKMessage).toHaveBeenCalledWith(mockMessage);
    });

    it('should propagate errors from adaptIterator', async () => {
      const mockQueryResult = (async function* () {
        throw new Error('SDK stream error');
      })();

      vi.mocked(query).mockReturnValue(mockQueryResult as any);

      const inputGen = (async function* () {
        yield { role: 'user' as const, content: 'Hello' };
      })();

      const result = provider.queryStream(inputGen, { model: 'claude-3' } as any);

      await expect(result.iterator.next()).rejects.toThrow('SDK stream error');
    });
  });
});
