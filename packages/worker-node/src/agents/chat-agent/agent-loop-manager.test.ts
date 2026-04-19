/**
 * Tests for AgentLoopManager (packages/worker-node/src/agents/chat-agent/agent-loop-manager.ts)
 *
 * Covers: startLoop, tryPushMessage, cancelQuery, closeSession, shutdown,
 * buildMcpServers, processIterator (result handling, error handling, restart logic).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('@disclaude/core', () => ({
  Config: {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null),
  },
  MessageChannel: vi.fn().mockImplementation(() => ({
    push: vi.fn(() => true),
    close: vi.fn(),
    generator: vi.fn(() => (async function* () { /* empty */ })()),
  })),
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

import { AgentLoopManager, type LoopContext } from './agent-loop-manager.js';
import { MessageChannel, Config } from '@disclaude/core';

const createMockLoopContext = (overrides?: Partial<LoopContext>): LoopContext => {
  const callbacks = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn(),
    getChatHistory: vi.fn().mockResolvedValue(undefined),
  };

  const historyLoader = {
    isHistoryLoaded: vi.fn(() => true),
    isFirstMessageHistoryLoaded: vi.fn(() => true),
    loadPersistedHistory: vi.fn().mockResolvedValue(undefined),
    loadFirstMessageHistory: vi.fn().mockResolvedValue(undefined),
  };

  const conversationOrchestrator = {
    setThreadRoot: vi.fn(),
    getThreadRoot: vi.fn(() => 'thread-root-123'),
    deleteThreadRoot: vi.fn(),
    clearAll: vi.fn(),
  };

  const restartManager = {
    recordSuccess: vi.fn(),
    shouldRestart: vi.fn(() => ({
      allowed: false,
      reason: 'max_restarts_exceeded',
      restartCount: 3,
    })),
    reset: vi.fn(),
    clearAll: vi.fn(),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  const handle = {
    close: vi.fn(),
    cancel: vi.fn(),
  };

  return {
    chatId: 'oc_test',
    callbacks,
    historyLoader: historyLoader as any,
    conversationOrchestrator: conversationOrchestrator as any,
    restartManager: restartManager as any,
    logger: logger as any,
    createSdkOptions: vi.fn(() => ({ mcpServers: {} })),
    createQueryStream: vi.fn(() => ({
      handle,
      iterator: (async function* () { /* empty */ })(),
    })),
    ...overrides,
  };
};

describe('AgentLoopManager', () => {
  let ctx: LoopContext;
  let manager: AgentLoopManager;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = createMockLoopContext();
    manager = new AgentLoopManager(ctx);
  });

  // --- State Accessors ---

  describe('isActive', () => {
    it('should return false initially', () => {
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return 0 when not active', () => {
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should return 1 when active', () => {
      manager.startLoop();
      expect(manager.getActiveSessionCount()).toBe(1);
    });
  });

  describe('getQueryHandle', () => {
    it('should return undefined initially', () => {
      expect(manager.getQueryHandle()).toBeUndefined();
    });
  });

  describe('getChannel', () => {
    it('should return undefined initially', () => {
      expect(manager.getChannel()).toBeUndefined();
    });
  });

  // --- Session Control ---

  describe('cancelQuery', () => {
    it('should return false when no query is active', () => {
      expect(manager.cancelQuery()).toBe(false);
    });

    it('should cancel and clear query handle when active', () => {
      manager.startLoop();
      const handle = manager.getQueryHandle();
      expect(handle).toBeDefined();

      const result = manager.cancelQuery();
      expect(result).toBe(true);
      expect(handle!.cancel).toHaveBeenCalled();
      expect(manager.getQueryHandle()).toBeUndefined();
    });
  });

  describe('markInactive', () => {
    it('should mark session as inactive', () => {
      manager.startLoop();
      expect(manager.isActive()).toBe(true);

      manager.markInactive();
      expect(manager.isActive()).toBe(false);
    });
  });

  describe('clearQueryHandle', () => {
    it('should clear the query handle', () => {
      manager.startLoop();
      expect(manager.getQueryHandle()).toBeDefined();

      manager.clearQueryHandle();
      expect(manager.getQueryHandle()).toBeUndefined();
    });
  });

  // --- startLoop ---

  describe('startLoop', () => {
    it('should create a MessageChannel', () => {
      manager.startLoop();
      expect(MessageChannel).toHaveBeenCalled();
    });

    it('should set session active', () => {
      manager.startLoop();
      expect(manager.isActive()).toBe(true);
    });

    it('should create a query handle', () => {
      manager.startLoop();
      expect(manager.getQueryHandle()).toBeDefined();
    });

    it('should call createSdkOptions with disallowedTools', () => {
      manager.startLoop();
      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          disallowedTools: ['EnterPlanMode'],
        }),
      );
    });

    it('should call createQueryStream', () => {
      manager.startLoop();
      expect(ctx.createQueryStream).toHaveBeenCalled();
    });

    it('should trigger background history loading when not loaded', () => {
      vi.mocked(ctx.historyLoader.isHistoryLoaded).mockReturnValue(false);
      manager.startLoop();
      expect(ctx.historyLoader.loadPersistedHistory).toHaveBeenCalled();
    });

    it('should not trigger history loading when already loaded', () => {
      vi.mocked(ctx.historyLoader.isHistoryLoaded).mockReturnValue(true);
      manager.startLoop();
      expect(ctx.historyLoader.loadPersistedHistory).not.toHaveBeenCalled();
    });

    it('should trigger first message history loading when getChatHistory exists', () => {
      vi.mocked(ctx.historyLoader.isFirstMessageHistoryLoaded).mockReturnValue(false);
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).toHaveBeenCalled();
    });

    it('should not trigger first message history loading when already loaded', () => {
      vi.mocked(ctx.historyLoader.isFirstMessageHistoryLoaded).mockReturnValue(true);
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).not.toHaveBeenCalled();
    });

    it('should not trigger first message history when getChatHistory is missing', () => {
      vi.mocked(ctx.historyLoader.isFirstMessageHistoryLoaded).mockReturnValue(false);
      (ctx as any).callbacks.getChatHistory = undefined;
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).not.toHaveBeenCalled();
    });
  });

  // --- tryPushMessage ---

  describe('tryPushMessage', () => {
    it('should return false when no channel exists', () => {
      const result = manager.tryPushMessage(
        { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, session_id: '' },
        'oc_test',
        'msg_1',
      );
      expect(result).toBe(false);
    });

    it('should push message to channel and return true when accepted', () => {
      manager.startLoop();
      const channel = manager.getChannel()!;
      vi.mocked(channel.push).mockReturnValue(true);

      const result = manager.tryPushMessage(
        { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, session_id: '' },
        'oc_test',
        'msg_1',
      );
      expect(result).toBe(true);
      expect(channel.push).toHaveBeenCalled();
    });

    it('should return false when channel rejects push', () => {
      manager.startLoop();
      const channel = manager.getChannel()!;
      vi.mocked(channel.push).mockReturnValue(false);

      const result = manager.tryPushMessage(
        { type: 'user', message: { role: 'user', content: 'hello' }, parent_tool_use_id: null, session_id: '' },
        'oc_test',
        'msg_1',
      );
      expect(result).toBe(false);
    });
  });

  // --- closeSession ---

  describe('closeSession', () => {
    it('should close channel and clear session', () => {
      manager.startLoop();
      const channel = manager.getChannel()!;

      manager.closeSession();

      expect(manager.isActive()).toBe(false);
      expect(manager.getChannel()).toBeUndefined();
      expect(manager.getQueryHandle()).toBeUndefined();
      expect(channel.close).toHaveBeenCalled();
    });

    it('should handle closeSession when not active', () => {
      expect(() => manager.closeSession()).not.toThrow();
    });
  });

  // --- shutdown ---

  describe('shutdown', () => {
    it('should close channel, query handle and deactivate session', () => {
      manager.startLoop();
      const channel = manager.getChannel()!;
      const handle = manager.getQueryHandle()!;

      manager.shutdown();

      expect(manager.isActive()).toBe(false);
      expect(manager.getChannel()).toBeUndefined();
      expect(manager.getQueryHandle()).toBeUndefined();
      expect(channel.close).toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalled();
    });

    it('should handle shutdown when nothing is active', () => {
      expect(() => manager.shutdown()).not.toThrow();
    });
  });

  // --- buildMcpServers (via startLoop) ---

  describe('buildMcpServers', () => {
    it('should include channel MCP when no capabilities specified', () => {
      vi.mocked(ctx.callbacks.getCapabilities).mockReturnValue(undefined);
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({ 'channel-mcp': expect.anything() }),
        }),
      );
    });

    it('should include channel MCP when supportedMcpTools includes send_text', () => {
      vi.mocked(ctx.callbacks.getCapabilities).mockReturnValue({
        supportedMcpTools: ['send_text', 'send_card'],
      });
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({ 'channel-mcp': expect.anything() }),
        }),
      );
    });

    it('should not include channel MCP when supportedMcpTools excludes context tools', () => {
      vi.mocked(ctx.callbacks.getCapabilities).mockReturnValue({
        supportedMcpTools: ['other_tool'],
      });
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: {},
        }),
      );
    });

    it('should include configured MCP servers', () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
        'my-server': { command: 'node', args: ['server.js'], env: { KEY: 'val' } },
      });

      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({
            'channel-mcp': expect.anything(),
            'my-server': { type: 'stdio', command: 'node', args: ['server.js'], env: { KEY: 'val' } },
          }),
        }),
      );
    });

    it('should handle MCP server config without env', () => {
      vi.mocked(Config.getMcpServersConfig).mockReturnValue({
        'simple-server': { command: 'python', args: ['-m', 'server'] },
      });

      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({
            'simple-server': { type: 'stdio', command: 'python', args: ['-m', 'server'] },
          }),
        }),
      );
    });
  });

  // --- processIterator (synchronous verification) ---

  describe('processIterator - result handling', () => {
    it('should handle result type by recording success', async () => {
      const resultPromise = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            yield { parsed: { type: 'result', content: 'done' } };
            resolve();
          })(),
        });
      });

      manager.startLoop();
      await resultPromise;

      expect(ctx.restartManager.recordSuccess).toHaveBeenCalledWith('oc_test');
    });

    it('should call onDone callback on result type', async () => {
      const resultPromise = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            yield { parsed: { type: 'result', content: 'done' } };
            resolve();
          })(),
        });
      });

      manager.startLoop();
      await resultPromise;

      expect(ctx.callbacks.onDone).toHaveBeenCalledWith('oc_test', 'thread-root-123');
    });

    it('should send content messages via callback', async () => {
      const done = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            yield { parsed: { type: 'text', content: 'Hello world' } };
            yield { parsed: { type: 'result', content: 'done' } };
            resolve();
          })(),
        });
      });

      manager.startLoop();
      await done;

      expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith('oc_test', 'Hello world', 'thread-root-123');
    });

    it('should skip sending when content is falsy', async () => {
      const done = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            yield { parsed: { type: 'text', content: undefined } };
            yield { parsed: { type: 'result', content: 'done' } };
            resolve();
          })(),
        });
      });

      manager.startLoop();
      await done;

      // Should not call sendMessage with undefined content
      const {calls} = vi.mocked(ctx.callbacks.sendMessage).mock;
      const undefinedContentCalls = calls.filter(c => c[1] === undefined);
      expect(undefinedContentCalls.length).toBe(0);
    });
  });

  describe('processIterator - error handling', () => {
    it('should handle iterator error and send error message', async () => {
      const done = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            resolve();
            throw new Error('Iterator crashed');
          })(),
        });
      });

      manager.startLoop();
      await done;
      // Allow the catch handler to execute
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('Session error'),
        'thread-root-123',
      );
      expect(ctx.callbacks.onDone).toHaveBeenCalledWith('oc_test', 'thread-root-123');
    });

    it('should handle restart blocked by circuit breaker', async () => {
      const done = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            // Empty iterator - ends without error
            resolve();
          })(),
        });
      });

      vi.mocked(ctx.restartManager.shouldRestart).mockReturnValue({
        allowed: false,
        reason: 'max_restarts_exceeded',
        restartCount: 3,
      } as any);

      manager.startLoop();
      await done;
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('多次异常中断'),
        'thread-root-123',
      );
    });

    it('should handle restart blocked for non-max reason', async () => {
      const done = new Promise<void>((resolve) => {
        vi.mocked(ctx.createQueryStream).mockReturnValue({
          handle: { close: vi.fn(), cancel: vi.fn() },
          iterator: (async function* () {
            resolve();
          })(),
        });
      });

      vi.mocked(ctx.restartManager.shouldRestart).mockReturnValue({
        allowed: false,
        reason: 'circuit_open',
        restartCount: 1,
      } as any);

      manager.startLoop();
      await done;
      await new Promise((r) => setTimeout(r, 10));

      expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
        'oc_test',
        expect.stringContaining('circuit_open'),
        'thread-root-123',
      );
    });

  });
});
