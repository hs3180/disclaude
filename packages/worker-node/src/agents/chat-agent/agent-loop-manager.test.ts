/**
 * Tests for AgentLoopManager (packages/worker-node/src/agents/chat-agent/agent-loop-manager.ts)
 *
 * Tests the agent loop lifecycle: start, message pushing, query cancellation,
 * session close, shutdown, MCP server building, iterator processing, and
 * restart/circuit-breaker logic.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';

// All mock data must be defined inside vi.mock factories to avoid hoisting issues.

vi.mock('@disclaude/core', () => {
  const mockConfig = {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null as any),
  };

  const mockMessageChannel = {
    push: vi.fn(() => true),
    close: vi.fn(),
    generator: vi.fn(() => (async function* () { /* empty */ })()),
  };

  return {
    Config: mockConfig,
    MessageChannel: vi.fn(() => ({ ...mockMessageChannel })),
    RestartManager: vi.fn(),
    ConversationOrchestrator: vi.fn(),
  };
});

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline-mcp' })),
}));

import { AgentLoopManager, type LoopContext } from './agent-loop-manager.js';
import { MessageChannel, Config } from '@disclaude/core';

// --- Re-export mocks for test access ---
const mockConfig = Config as unknown as {
  getSessionRestoreConfig: Mock;
  getMcpServersConfig: Mock;
};

// --- Helpers ---

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  } as any;
}

function createMockCallbacks() {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    onDone: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn() as any,
    getChatHistory: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockHistoryLoader() {
  return {
    isHistoryLoaded: vi.fn(() => false),
    isFirstMessageHistoryLoaded: vi.fn(() => false),
    loadPersistedHistory: vi.fn().mockResolvedValue(undefined),
    loadFirstMessageHistory: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockRestartManager() {
  return {
    recordSuccess: vi.fn(),
    shouldRestart: vi.fn(() => ({
      allowed: false,
      reason: 'max_restarts_exceeded' as const,
      restartCount: 3,
      circuitOpen: true,
    })),
    reset: vi.fn(),
    clearAll: vi.fn(),
  } as any;
}

function createMockConversationOrchestrator() {
  return {
    getThreadRoot: vi.fn(() => 'thread-root-123'),
    setThreadRoot: vi.fn(),
    deleteThreadRoot: vi.fn(),
    clearAll: vi.fn(),
  } as any;
}

function createLoopContext(overrides?: Record<string, any>): LoopContext {
  const mockHandle = { close: vi.fn(), cancel: vi.fn() };
  const emptyIterator = (async function* () { /* empty */ })();

  const ctx: LoopContext = {
    chatId: 'oc_test_chat',
    callbacks: createMockCallbacks(),
    historyLoader: createMockHistoryLoader(),
    conversationOrchestrator: createMockConversationOrchestrator(),
    restartManager: createMockRestartManager(),
    logger: createMockLogger(),
    createSdkOptions: vi.fn(() => ({ mcpServers: {} })) as any,
    createQueryStream: vi.fn(() => ({
      handle: mockHandle,
      iterator: emptyIterator,
    })) as any,
  };

  if (overrides) {
    Object.assign(ctx, overrides);
  }

  return ctx;
}

// --- Access the shared mock channel for push/close control ---
function getMockChannelFromLastCall(): { push: Mock; close: Mock } {
  return (MessageChannel as Mock).mock.results.at(-1)?.value ?? { push: vi.fn(), close: vi.fn() };
}

// --- Tests ---

describe('AgentLoopManager', () => {
  let manager: AgentLoopManager;
  let ctx: LoopContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.getMcpServersConfig.mockReturnValue(null as any);
    ctx = createLoopContext();
    manager = new AgentLoopManager(ctx);
  });

  // =========================================================================
  // Constructor & Initial State
  // =========================================================================

  describe('initial state', () => {
    it('should not be active after construction', () => {
      expect(manager.isActive()).toBe(false);
    });

    it('should have zero active session count', () => {
      expect(manager.getActiveSessionCount()).toBe(0);
    });

    it('should have no channel', () => {
      expect(manager.getChannel()).toBeUndefined();
    });

    it('should have no query handle', () => {
      expect(manager.getQueryHandle()).toBeUndefined();
    });
  });

  // =========================================================================
  // startLoop()
  // =========================================================================

  describe('startLoop()', () => {
    it('should set session to active', () => {
      manager.startLoop();
      expect(manager.isActive()).toBe(true);
    });

    it('should create a MessageChannel', () => {
      manager.startLoop();
      expect(MessageChannel).toHaveBeenCalled();
      expect(manager.getChannel()).toBeDefined();
    });

    it('should set the session count to 1', () => {
      manager.startLoop();
      expect(manager.getActiveSessionCount()).toBe(1);
    });

    it('should call createSdkOptions with disallowedTools and mcpServers', () => {
      manager.startLoop();
      expect(ctx.createSdkOptions).toHaveBeenCalledWith({
        disallowedTools: ['EnterPlanMode'],
        mcpServers: expect.any(Object),
      });
    });

    it('should call createQueryStream with channel generator and options', () => {
      manager.startLoop();
      expect(ctx.createQueryStream).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ mcpServers: expect.any(Object) }),
      );
    });

    it('should store the query handle', () => {
      manager.startLoop();
      expect(manager.getQueryHandle()).toBeDefined();
    });

    it('should trigger persisted history loading when not loaded', () => {
      manager.startLoop();
      expect(ctx.historyLoader.loadPersistedHistory).toHaveBeenCalledWith(
        ctx.callbacks,
        expect.objectContaining({ historyDays: 1, maxContextLength: 50000 }),
      );
    });

    it('should not trigger persisted history loading when already loaded', () => {
      (ctx.historyLoader.isHistoryLoaded as Mock).mockReturnValue(true);
      manager.startLoop();
      expect(ctx.historyLoader.loadPersistedHistory).not.toHaveBeenCalled();
    });

    it('should trigger first message history loading when not loaded and getChatHistory exists', () => {
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).toHaveBeenCalledWith(ctx.callbacks);
    });

    it('should not trigger first message history loading when already loaded', () => {
      (ctx.historyLoader.isFirstMessageHistoryLoaded as Mock).mockReturnValue(true);
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).not.toHaveBeenCalled();
    });

    it('should not trigger first message history when getChatHistory is absent', () => {
      ctx.callbacks.getChatHistory = undefined;
      manager.startLoop();
      expect(ctx.historyLoader.loadFirstMessageHistory).not.toHaveBeenCalled();
    });

    it('should handle history loading errors gracefully', () => {
      (ctx.historyLoader.loadPersistedHistory as Mock).mockRejectedValue(new Error('disk full'));
      expect(() => manager.startLoop()).not.toThrow();
    });

    it('should log info about SDK query start', () => {
      manager.startLoop();
      expect(ctx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test_chat' }),
        'Starting SDK query with message channel',
      );
    });
  });

  // =========================================================================
  // tryPushMessage()
  // =========================================================================

  describe('tryPushMessage()', () => {
    it('should return false when no channel exists', () => {
      const result = manager.tryPushMessage(
        { type: 'text', text: 'hello' } as any,
        'oc_test',
        'msg-1',
      );
      expect(result).toBe(false);
    });

    it('should return true when channel accepts message', () => {
      manager.startLoop();
      const result = manager.tryPushMessage(
        { type: 'text', text: 'hello' } as any,
        'oc_test',
        'msg-1',
      );
      expect(result).toBe(true);
    });

    it('should return false when channel rejects message', () => {
      manager.startLoop();
      // Make the channel's push return false
      const mockChannel = getMockChannelFromLastCall();
      mockChannel.push.mockReturnValue(false);

      const result = manager.tryPushMessage(
        { type: 'text', text: 'hello' } as any,
        'oc_test',
        'msg-1',
      );
      expect(result).toBe(false);
    });

    it('should log error when no channel available', () => {
      manager.tryPushMessage({ type: 'text', text: 'hello' } as any, 'oc_test', 'msg-1');
      expect(ctx.logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test', messageId: 'msg-1' }),
        'tryPushMessage: no channel available',
      );
    });

    it('should log warning when push is rejected', () => {
      manager.startLoop();
      const mockChannel = getMockChannelFromLastCall();
      mockChannel.push.mockReturnValue(false);

      manager.tryPushMessage({ type: 'text', text: 'hello' } as any, 'oc_test', 'msg-1');
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'oc_test', messageId: 'msg-1' }),
        'tryPushMessage: push rejected, channel is closed',
      );
    });
  });

  // =========================================================================
  // cancelQuery()
  // =========================================================================

  describe('cancelQuery()', () => {
    it('should return false when no query handle', () => {
      expect(manager.cancelQuery()).toBe(false);
    });

    it('should return true and cancel when query handle exists', () => {
      manager.startLoop();
      const result = manager.cancelQuery();
      expect(result).toBe(true);
    });

    it('should clear query handle after cancellation', () => {
      manager.startLoop();
      manager.cancelQuery();
      expect(manager.getQueryHandle()).toBeUndefined();
    });
  });

  // =========================================================================
  // markInactive()
  // =========================================================================

  describe('markInactive()', () => {
    it('should mark session as inactive', () => {
      manager.startLoop();
      expect(manager.isActive()).toBe(true);
      manager.markInactive();
      expect(manager.isActive()).toBe(false);
    });
  });

  // =========================================================================
  // closeSession()
  // =========================================================================

  describe('closeSession()', () => {
    it('should mark session as inactive', () => {
      manager.startLoop();
      manager.closeSession();
      expect(manager.isActive()).toBe(false);
    });

    it('should clear channel', () => {
      manager.startLoop();
      manager.closeSession();
      expect(manager.getChannel()).toBeUndefined();
    });

    it('should clear query handle', () => {
      manager.startLoop();
      manager.closeSession();
      expect(manager.getQueryHandle()).toBeUndefined();
    });

    it('should close the channel', () => {
      manager.startLoop();
      const mockChannel = getMockChannelFromLastCall();
      manager.closeSession();
      expect(mockChannel.close).toHaveBeenCalled();
    });

    it('should be safe to call when no session is active', () => {
      expect(() => manager.closeSession()).not.toThrow();
    });
  });

  // =========================================================================
  // shutdown()
  // =========================================================================

  describe('shutdown()', () => {
    it('should mark session as inactive', () => {
      manager.startLoop();
      manager.shutdown();
      expect(manager.isActive()).toBe(false);
    });

    it('should clear channel and query handle', () => {
      manager.startLoop();
      manager.shutdown();
      expect(manager.getChannel()).toBeUndefined();
      expect(manager.getQueryHandle()).toBeUndefined();
    });

    it('should close the channel', () => {
      manager.startLoop();
      const mockChannel = getMockChannelFromLastCall();
      manager.shutdown();
      expect(mockChannel.close).toHaveBeenCalled();
    });

    it('should be safe to call when already shut down', () => {
      expect(() => manager.shutdown()).not.toThrow();
    });
  });

  // =========================================================================
  // MCP Server Building (buildMcpServers)
  // =========================================================================

  describe('MCP server configuration', () => {
    it('should include channel-mcp when capabilities do not restrict it', () => {
      ctx.callbacks.getCapabilities = vi.fn(() => ({
        supportedMcpTools: ['send_text', 'other_tool'],
      })) as any;
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({ 'channel-mcp': expect.anything() }),
        }),
      );
    });

    it('should include channel-mcp when capabilities are undefined', () => {
      ctx.callbacks.getCapabilities = vi.fn(() => undefined) as any;
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({ 'channel-mcp': expect.anything() }),
        }),
      );
    });

    it('should include channel-mcp when capabilities include context tools', () => {
      ctx.callbacks.getCapabilities = vi.fn(() => ({
        supportedMcpTools: ['send_card', 'send_file'],
      })) as any;
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({ 'channel-mcp': expect.anything() }),
        }),
      );
    });

    it('should NOT include channel-mcp when capabilities exclude all context tools', () => {
      ctx.callbacks.getCapabilities = vi.fn(() => ({
        supportedMcpTools: ['other_tool'],
      })) as any;
      manager.startLoop();

      const { calls } = (ctx.createSdkOptions as Mock).mock;
      const call = calls[0][0] as Record<string, any>;
      expect(call.mcpServers).not.toHaveProperty('channel-mcp');
    });

    it('should include configured MCP servers from Config', () => {
      mockConfig.getMcpServersConfig.mockReturnValue({
        'my-mcp': { command: 'npx', args: ['my-server'], env: { KEY: 'val' } },
      } as any);
      manager.startLoop();

      expect(ctx.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: expect.objectContaining({
            'my-mcp': expect.objectContaining({
              type: 'stdio',
              command: 'npx',
              args: ['my-server'],
              env: { KEY: 'val' },
            }),
          }),
        }),
      );
    });

    it('should handle MCP config without env', () => {
      mockConfig.getMcpServersConfig.mockReturnValue({
        'my-mcp': { command: 'npx', args: ['my-server'] },
      } as any);
      manager.startLoop();

      const { calls } = (ctx.createSdkOptions as Mock).mock;
      const call = calls[0][0] as Record<string, any>;
      const myMcp = call.mcpServers['my-mcp'];
      expect(myMcp).toEqual({
        type: 'stdio',
        command: 'npx',
        args: ['my-server'],
      });
    });
  });

  // =========================================================================
  // Iterator Processing (processIterator)
  // =========================================================================

  describe('processIterator', () => {
    it('should process messages from the iterator', async () => {
      const messages = [
        { parsed: { type: 'assistant', content: 'Hello!' } },
        { parsed: { type: 'result', content: 'Done' } },
      ];

      const iterator = (async function* () {
        for (const msg of messages) {yield msg;}
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith('oc_test_chat', 'Hello!', 'thread-root-123');
      });

      expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith('oc_test_chat', 'Done', 'thread-root-123');
    });

    it('should call onDone callback when result message received', async () => {
      const iterator = (async function* () {
        yield { parsed: { type: 'result', content: 'Done' } };
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.onDone).toHaveBeenCalledWith('oc_test_chat', 'thread-root-123');
      });
    });

    it('should record success on result message', async () => {
      const iterator = (async function* () {
        yield { parsed: { type: 'result', content: 'Done' } };
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.restartManager.recordSuccess).toHaveBeenCalledWith('oc_test_chat');
      });
    });

    it('should handle iterator errors and send error message', async () => {
      const iterator = (async function* () {
        yield { parsed: { type: 'assistant', content: 'msg' } };
        throw new Error('SDK crash');
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test_chat',
          expect.stringContaining('SDK crash'),
          'thread-root-123',
        );
      });
    });

    it('should attempt restart when allowed by restart manager', async () => {
      (ctx.restartManager.shouldRestart as Mock).mockReturnValue({
        allowed: true,
        waitMs: 0,
        restartCount: 1,
        circuitOpen: false,
      });

      let callCount = 0;
      const iterator = (async function* () {
        callCount++;
        if (callCount === 1) {throw new Error('timeout');}
        yield { parsed: { type: 'result', content: 'recovered' } };
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test_chat',
          expect.stringContaining('重新连接'),
          'thread-root-123',
        );
      });
    });

    it('should send max restart message when circuit opens', async () => {
      (ctx.restartManager.shouldRestart as Mock).mockReturnValue({
        allowed: false,
        reason: 'max_restarts_exceeded',
        restartCount: 3,
        circuitOpen: true,
      });

      const iterator = (async function* () {
        throw new Error('fatal');
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test_chat',
          expect.stringContaining('/reset'),
          'thread-root-123',
        );
      });
    });

    it('should send circuit open message with reason', async () => {
      (ctx.restartManager.shouldRestart as Mock).mockReturnValue({
        allowed: false,
        reason: 'circuit_open',
        restartCount: 5,
        circuitOpen: true,
      });

      const iterator = (async function* () {
        throw new Error('overload');
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();

      await vi.waitFor(() => {
        expect(ctx.callbacks.sendMessage).toHaveBeenCalledWith(
          'oc_test_chat',
          expect.stringContaining('circuit_open'),
          'thread-root-123',
        );
      });
    });

    it('should not attempt restart when session was explicitly closed', async () => {
      const iterator = (async function* () {
        // Immediately exits — simulates iterator completing normally
      })();

      const mockHandle = { close: vi.fn(), cancel: vi.fn() };
      ctx.createQueryStream = vi.fn(() => ({ handle: mockHandle, iterator } as any));

      manager.startLoop();
      manager.markInactive();

      await new Promise(r => setTimeout(r, 50));
      expect(ctx.restartManager.shouldRestart).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Edge Cases
  // =========================================================================

  describe('edge cases', () => {
    it('should handle multiple startLoop calls gracefully', () => {
      manager.startLoop();
      expect(() => manager.startLoop()).not.toThrow();
      expect(manager.isActive()).toBe(true);
    });

    it('should handle closeSession then startLoop', () => {
      manager.startLoop();
      manager.closeSession();
      expect(manager.isActive()).toBe(false);

      manager.startLoop();
      expect(manager.isActive()).toBe(true);
    });

    it('should handle shutdown then startLoop', () => {
      manager.startLoop();
      manager.shutdown();
      expect(manager.isActive()).toBe(false);

      manager.startLoop();
      expect(manager.isActive()).toBe(true);
    });

    it('clearQueryHandle should clear handle without closing session', () => {
      manager.startLoop();
      manager.clearQueryHandle();
      expect(manager.getQueryHandle()).toBeUndefined();
      expect(manager.isActive()).toBe(true);
    });

    it('cancelQuery should only cancel once for a given handle', () => {
      manager.startLoop();
      expect(manager.cancelQuery()).toBe(true);
      expect(manager.cancelQuery()).toBe(false);
    });
  });
});
