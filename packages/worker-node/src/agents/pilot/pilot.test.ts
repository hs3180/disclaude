/**
 * Tests for Pilot agent (packages/worker-node/src/agents/pilot/index.ts)
 *
 * Tests the public API of the Pilot class including lifecycle management,
 * session handling, chatId binding, and error paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock all @disclaude/core dependencies
vi.mock('@disclaude/core', () => ({
  Config: {
    getSessionRestoreConfig: vi.fn(() => ({
      historyDays: 1,
      maxContextLength: 50000,
    })),
    getMcpServersConfig: vi.fn(() => null),
  },
  BaseAgent: vi.fn().mockImplementation(function(this: any) {
    this.createSdkOptions = vi.fn(() => ({ mcpServers: {} }));
    this.createQueryStream = vi.fn(() => ({
      handle: { close: vi.fn(), cancel: vi.fn() },
      iterator: (async function* () { /* empty */ })(),
    }));
    this.queryOnce = vi.fn(() => (async function* () {
      yield { parsed: { type: 'result', content: 'done' } };
    })());
    this.dispose = vi.fn();
    this.logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
  }),
  MessageBuilder: vi.fn().mockImplementation(() => ({
    buildEnhancedContent: vi.fn((input: any) => input.text),
  })),
  MessageChannel: vi.fn().mockImplementation(() => ({
    push: vi.fn(),
    close: vi.fn(),
    generator: vi.fn(() => (async function* () { /* empty */ })()),
  })),
  RestartManager: vi.fn().mockImplementation(() => ({
    recordSuccess: vi.fn(),
    shouldRestart: vi.fn(() => ({ allowed: false, reason: 'max_restarts_exceeded', restartCount: 3 })),
    reset: vi.fn(),
    clearAll: vi.fn(),
  })),
  ConversationOrchestrator: vi.fn().mockImplementation(() => ({
    setThreadRoot: vi.fn(),
    getThreadRoot: vi.fn(() => 'thread-root-123'),
    deleteThreadRoot: vi.fn(),
    clearAll: vi.fn(),
  })),
}));

vi.mock('@disclaude/mcp-server', () => ({
  createChannelMcpServer: vi.fn(() => ({ type: 'inline' })),
}));

import { Pilot } from './index.js';
import { MessageChannel } from '@disclaude/core';

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
  getCapabilities: vi.fn(),
  getChatHistory: vi.fn().mockResolvedValue(undefined),
});

describe('Pilot', () => {
  let pilot: InstanceType<typeof Pilot>;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    vi.clearAllMocks();
    callbacks = createMockCallbacks();
    pilot = new Pilot({
      chatId: 'oc_test_chat',
      callbacks,
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    });
  });

  describe('constructor', () => {
    it('should create a Pilot with bound chatId', () => {
      expect(pilot.getChatId()).toBe('oc_test_chat');
    });

    it('should have type "chat"', () => {
      expect(pilot.type).toBe('chat');
    });

    it('should have name "Pilot"', () => {
      expect(pilot.name).toBe('Pilot');
    });
  });

  describe('getChatId', () => {
    it('should return the bound chatId', () => {
      const p = new Pilot({
        chatId: 'oc_another_chat',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      expect(p.getChatId()).toBe('oc_another_chat');
    });
  });

  describe('start', () => {
    it('should resolve immediately (no-op)', async () => {
      await expect(pilot.start()).resolves.toBeUndefined();
    });
  });

  describe('hasActiveSession / getActiveSessionCount', () => {
    it('should return false and 0 initially', () => {
      expect(pilot.hasActiveSession()).toBe(false);
      expect(pilot.getActiveSessionCount()).toBe(0);
    });
  });

  describe('stop', () => {
    it('should return false when no active query', () => {
      expect(pilot.stop()).toBe(false);
    });

    it('should return false for wrong chatId', () => {
      expect(pilot.stop('oc_wrong')).toBe(false);
    });
  });

  describe('reset', () => {
    it('should clear session state', () => {
      pilot.reset();
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should ignore reset for wrong chatId', () => {
      pilot.reset();
      pilot.reset('oc_wrong');
      expect(pilot.getChatId()).toBe('oc_test_chat');
    });

    it('should clear history state', () => {
      pilot.reset();
      pilot.reset();
      pilot.reset();
    });
  });

  describe('processMessage', () => {
    it('should ignore messages for wrong chatId', () => {
      pilot.processMessage('oc_wrong', 'hello', 'msg_1');
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should start a session when processing first message', () => {
      pilot.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(pilot.hasActiveSession()).toBe(true);
    });

    it('should push message to channel after session starts', () => {
      pilot.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(MessageChannel).toHaveBeenCalled();
    });
  });

  describe('executeOnce', () => {
    it('should throw when chatId does not match bound chatId', async () => {
      await expect(
        pilot.executeOnce('oc_wrong', 'hello', 'msg_1')
      ).rejects.toThrow('cannot execute for oc_wrong');
    });

    it('should complete successfully for matching chatId', async () => {
      await expect(
        pilot.executeOnce('oc_test_chat', 'hello', 'msg_1')
      ).resolves.toBeUndefined();
    });
  });

  describe('handleInput', () => {
    it('should skip messages for wrong chatId', async () => {
      const messages = [
        { role: 'user' as const, content: 'hello', metadata: { chatId: 'oc_wrong' } },
      ];
      const gen = async function* () {
        for (const msg of messages) {yield msg;}
      };

      const results = [];
      for await (const result of pilot.handleInput(gen() as AsyncGenerator<any>)) {
        results.push(result);
      }

      expect(results.length).toBe(0);
    });

    it('should yield response for matching chatId', async () => {
      const messages = [
        { role: 'user' as const, content: 'hello', metadata: { chatId: 'oc_test_chat' } },
      ];
      const gen = async function* () {
        for (const msg of messages) {yield msg;}
      };

      const results = [];
      for await (const result of pilot.handleInput(gen() as AsyncGenerator<any>)) {
        results.push(result);
      }

      expect(results.length).toBe(1);
      expect(results[0].role).toBe('assistant');
    });
  });

  describe('dispose', () => {
    it('should call dispose without throwing', () => {
      expect(() => pilot.dispose()).not.toThrow();
    });
  });

  describe('shutdown', () => {
    it('should complete shutdown without throwing', async () => {
      await expect(pilot.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('session lifecycle', () => {
    it('should allow reset after processMessage', () => {
      pilot.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(pilot.hasActiveSession()).toBe(true);

      pilot.reset();
      expect(pilot.hasActiveSession()).toBe(false);
    });

    it('should allow new session after reset', () => {
      pilot.processMessage('oc_test_chat', 'first', 'msg_1');
      expect(pilot.hasActiveSession()).toBe(true);

      pilot.reset();
      expect(pilot.hasActiveSession()).toBe(false);

      pilot.processMessage('oc_test_chat', 'second', 'msg_2');
      expect(pilot.hasActiveSession()).toBe(true);
    });

    it('should handle multiple resets without error', () => {
      pilot.reset();
      pilot.reset();
      pilot.reset();
      expect(pilot.hasActiveSession()).toBe(false);
    });
  });

  describe('history loading', () => {
    it('should call getChatHistory callback if available during session start', () => {
      pilot.processMessage('oc_test_chat', 'hello', 'msg_1');
      expect(callbacks.getChatHistory).toHaveBeenCalled();
    });

    it('should not throw when getChatHistory callback is not provided', () => {
      const noHistoryCallbacks = {
        ...callbacks,
        getChatHistory: undefined,
      };
      const p = new Pilot({
        chatId: 'oc_test',
        callbacks: noHistoryCallbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
      });
      p.processMessage('oc_test', 'hello', 'msg_1');
      expect(p.hasActiveSession()).toBe(true);
    });
  });

  describe('cwd override (Issue #1506)', () => {
    it('should accept cwd in config', () => {
      const p = new Pilot({
        chatId: 'oc_test_cwd',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        cwd: '/path/to/project',
      });
      expect(p.getChatId()).toBe('oc_test_cwd');
    });

    it('should pass cwd to createSdkOptions in executeOnce', async () => {
      const cwdPilot = new Pilot({
        chatId: 'oc_cwd_test',
        callbacks,
        apiKey: 'key',
        model: 'model',
        provider: 'anthropic',
        cwd: '/custom/project/dir',
      });

      await cwdPilot.executeOnce('oc_cwd_test', 'hello', 'msg_1');

      // createSdkOptions should have been called with cwd
      const baseAgentMock = cwdPilot as any;
      expect(baseAgentMock.createSdkOptions).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/custom/project/dir' })
      );
    });

    it('should not pass cwd when not configured', async () => {
      await pilot.executeOnce('oc_test_chat', 'hello', 'msg_2');

      const baseAgentMock = pilot as any;
      const lastCall = baseAgentMock.createSdkOptions.mock.calls[
        baseAgentMock.createSdkOptions.mock.calls.length - 1
      ];
      expect(lastCall[0].cwd).toBeUndefined();
    });
  });
});
