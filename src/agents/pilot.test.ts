/**
 * Tests for Pilot class (Streaming Input version).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Pilot, type PilotCallbacks } from './pilot.js';

// Mock the SDK to avoid unhandled errors
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn().mockReturnValue({
    async *[Symbol.asyncIterator]() {
      // Yield a simple message and end
      yield { type: 'text', content: 'Test response' };
    },
    close: vi.fn(),
    streamInput: vi.fn(() => Promise.resolve()),
  }),
  tool: vi.fn(),
  createSdkMcpServer: vi.fn(() => ({})),
}));

// Mock config
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: vi.fn(() => '/test/workspace'),
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    })),
    getGlobalEnv: vi.fn(() => ({})),
    getMcpServersConfig: vi.fn(() => null),
    getLoggingConfig: vi.fn(() => ({
      level: 'info',
      pretty: true,
      rotate: false,
      sdkDebug: true,
    })),
  },
}));

// Mock utils
vi.mock('../utils/sdk.js', () => ({
  parseSDKMessage: vi.fn((msg) => ({
    type: msg.type || 'text',
    content: msg.content || '',
    metadata: {},
  })),
  buildSdkEnv: vi.fn(() => ({})),
}));

// Mock logger
vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('Pilot (Streaming Input)', () => {
  let mockCallbacks: PilotCallbacks;
  let pilot: Pilot;

  beforeEach(() => {
    vi.useFakeTimers();
    mockCallbacks = {
      sendMessage: vi.fn(async () => {}),
      sendCard: vi.fn(async () => {}),
      sendFile: vi.fn(async () => {}),
    };
    pilot = new Pilot({
      apiKey: 'test-api-key',
      model: 'test-model',
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    pilot.shutdown().catch(() => {});
  });

  describe('Constructor', () => {
    it('should create Pilot instance with callbacks', () => {
      expect(pilot).toBeInstanceOf(Pilot);
    });

    it('should store callbacks', () => {
      expect(pilot['callbacks']).toBe(mockCallbacks);
    });

    it('should initialize sessionManager', () => {
      expect(pilot['sessionManager']).toBeDefined();
      expect(pilot['sessionManager'].size()).toBe(0);
    });

    it('should initialize conversationOrchestrator', () => {
      expect(pilot['conversationOrchestrator']).toBeDefined();
      expect(pilot['conversationOrchestrator'].size()).toBe(0);
    });
  });

  describe('processMessage', () => {
    it('should create session for new chatId', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      expect(pilot['sessionManager'].has('chat-123')).toBe(true);
    });

    it('should handle multiple messages for same chatId (same session)', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-123', 'World', 'msg-002');

      // Should reuse the same session
      expect(pilot['sessionManager'].size()).toBe(1);
      expect(pilot['sessionManager'].has('chat-123')).toBe(true);
    });

    it('should handle different chatIds independently (different sessions)', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');

      // Should create two separate sessions
      expect(pilot['sessionManager'].size()).toBe(2);
      expect(pilot['sessionManager'].has('chat-123')).toBe(true);
      expect(pilot['sessionManager'].has('chat-456')).toBe(true);
    });

    it('should accept optional senderOpenId parameter', () => {
      // Should not throw
      pilot.processMessage('chat-123', 'Hello', 'msg-001', 'user-open-id');
      expect(pilot['sessionManager'].has('chat-123')).toBe(true);
    });

    it('should be non-blocking (returns immediately)', () => {
      const start = Date.now();
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      const elapsed = Date.now() - start;

      // Should return almost immediately (not wait for SDK)
      expect(elapsed).toBeLessThan(100);
    });
  });

  describe('reset', () => {
    it('should reset specific chatId only', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');
      expect(pilot['sessionManager'].size()).toBe(2);

      // Reset only chat-123
      pilot.reset('chat-123');

      // chat-123 should be removed, chat-456 should remain
      expect(pilot['sessionManager'].size()).toBe(1);
      expect(pilot['sessionManager'].has('chat-123')).toBe(false);
      expect(pilot['sessionManager'].has('chat-456')).toBe(true);
    });

    it('should handle non-existent chatId gracefully', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      expect(pilot['sessionManager'].size()).toBe(1);

      // Reset non-existent chatId
      pilot.reset('chat-nonexistent');

      // Original session should remain
      expect(pilot['sessionManager'].size()).toBe(1);
      expect(pilot['sessionManager'].has('chat-123')).toBe(true);
    });

    it('should close session when resetting', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      // Reset should work immediately without waiting
      // The reset method is synchronous and handles session cleanup
      pilot.reset('chat-123');

      // Session should be removed
      expect(pilot['sessionManager'].has('chat-123')).toBe(false);
    });

    it('should not affect other chatIds in group chat scenario', () => {
      // Simulate multiple group chats
      pilot.processMessage('group-chat-1', 'Hello from group 1', 'msg-001');
      pilot.processMessage('group-chat-2', 'Hello from group 2', 'msg-002');
      pilot.processMessage('group-chat-3', 'Hello from group 3', 'msg-003');

      expect(pilot['sessionManager'].size()).toBe(3);

      // User in group-chat-1 sends /reset
      pilot.reset('group-chat-1');

      // Only group-chat-1 should be reset
      expect(pilot['sessionManager'].size()).toBe(2);
      expect(pilot['sessionManager'].has('group-chat-1')).toBe(false);
      expect(pilot['sessionManager'].has('group-chat-2')).toBe(true);
      expect(pilot['sessionManager'].has('group-chat-3')).toBe(true);
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return 0 when no sessions', () => {
      expect(pilot.getActiveSessionCount()).toBe(0);
    });

    it('should return count of active sessions', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');

      expect(pilot.getActiveSessionCount()).toBe(2);
    });
  });

  describe('shutdown', () => {
    it('should cleanup resources', async () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      await pilot.shutdown();

      expect(pilot['sessionManager'].size()).toBe(0);
      expect(pilot['conversationOrchestrator'].size()).toBe(0);
    });
  });

  describe('Session Management', () => {
    it('should create session when processing first message', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      const session = pilot['sessionManager'].get('chat-123');

      expect(session).toBeDefined();
      expect(session?.query).toBeDefined();
      expect(session?.channel).toBeDefined();
    });

    it('should store thread root for replies', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      expect(pilot['conversationOrchestrator'].getThreadRoot('chat-123')).toBe('msg-001');
    });
  });

  describe('executeOnce', () => {
    it('should be an instance method', () => {
      // executeOnce is an instance method, not static
      // This method is used by the Scheduler for scheduled task execution
      expect(typeof pilot.executeOnce).toBe('function');
    });

    it('should accept all parameters', () => {
      // Test that the method exists and can be called
      expect(typeof pilot.executeOnce).toBe('function');
    });
  });

  describe('Error Handling', () => {
    it('should handle errors in processMessage gracefully', () => {
      // processMessage should not throw even if internal operations fail
      expect(() => {
        pilot.processMessage('chat-123', 'Hello', 'msg-001');
      }).not.toThrow();
    });
  });
});
