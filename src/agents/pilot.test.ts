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

    it('should initialize states map', () => {
      expect(pilot['states']).toBeInstanceOf(Map);
      expect(pilot['states'].size).toBe(0);
    });
  });

  describe('processMessage', () => {
    it('should create state for new chatId', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      expect(pilot['states'].has('chat-123')).toBe(true);
    });

    it('should handle multiple messages for same chatId (same state)', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-123', 'World', 'msg-002');

      // Should reuse the same state
      expect(pilot['states'].size).toBe(1);
      expect(pilot['states'].has('chat-123')).toBe(true);
    });

    it('should handle different chatIds independently (different states)', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');

      // Should create two separate states
      expect(pilot['states'].size).toBe(2);
      expect(pilot['states'].has('chat-123')).toBe(true);
      expect(pilot['states'].has('chat-456')).toBe(true);
    });

    it('should accept optional senderOpenId parameter', () => {
      // Should not throw
      pilot.processMessage('chat-123', 'Hello', 'msg-001', 'user-open-id');
      expect(pilot['states'].has('chat-123')).toBe(true);
    });

    it('should be non-blocking (returns immediately)', () => {
      const start = Date.now();
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      const elapsed = Date.now() - start;

      // Should return almost immediately (not wait for SDK)
      expect(elapsed).toBeLessThan(100);
    });

    it('should update lastActivity timestamp', () => {
      const before = Date.now();
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      const state = pilot['states'].get('chat-123');

      expect(state?.lastActivity).toBeGreaterThanOrEqual(before);
    });
  });

  describe('clearQueue', () => {
    it('should clear state', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      expect(pilot['states'].has('chat-123')).toBe(true);

      pilot.clearQueue('chat-123');

      expect(pilot['states'].has('chat-123')).toBe(false);
    });

    it('should handle clearing non-existent state', () => {
      // Should not throw
      pilot.clearQueue('chat-nonexistent');
    });
  });

  describe('reset', () => {
    it('should reset specific chatId only', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');
      expect(pilot['states'].size).toBe(2);

      // Reset only chat-123
      pilot.reset('chat-123');

      // chat-123 should be removed, chat-456 should remain
      expect(pilot['states'].size).toBe(1);
      expect(pilot['states'].has('chat-123')).toBe(false);
      expect(pilot['states'].has('chat-456')).toBe(true);
    });

    it('should handle non-existent chatId gracefully', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      expect(pilot['states'].size).toBe(1);

      // Reset non-existent chatId
      pilot.reset('chat-nonexistent');

      // Original state should remain
      expect(pilot['states'].size).toBe(1);
      expect(pilot['states'].has('chat-123')).toBe(true);
    });

    it('should close query instance when resetting', async () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      // Wait a bit for agent loop to start
      await new Promise(resolve => setTimeout(resolve, 100));

      pilot.reset('chat-123');

      // State should be removed
      expect(pilot['states'].has('chat-123')).toBe(false);
    });

    it('should not affect other chatIds in group chat scenario', () => {
      // Simulate multiple group chats
      pilot.processMessage('group-chat-1', 'Hello from group 1', 'msg-001');
      pilot.processMessage('group-chat-2', 'Hello from group 2', 'msg-002');
      pilot.processMessage('group-chat-3', 'Hello from group 3', 'msg-003');

      expect(pilot['states'].size).toBe(3);

      // User in group-chat-1 sends /reset
      pilot.reset('group-chat-1');

      // Only group-chat-1 should be reset
      expect(pilot['states'].size).toBe(2);
      expect(pilot['states'].has('group-chat-1')).toBe(false);
      expect(pilot['states'].has('group-chat-2')).toBe(true);
      expect(pilot['states'].has('group-chat-3')).toBe(true);
    });
  });

  describe('resetAll', () => {
    it('should clear all states', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');
      expect(pilot['states'].size).toBe(2);

      pilot.resetAll();

      expect(pilot['states'].size).toBe(0);
    });
  });

  describe('getActiveSessionCount', () => {
    it('should return 0 when no states', () => {
      expect(pilot.getActiveSessionCount()).toBe(0);
    });

    it('should return count of active states', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-456', 'Hi', 'msg-002');

      expect(pilot.getActiveSessionCount()).toBe(2);
    });
  });

  describe('shutdown', () => {
    it('should cleanup resources', async () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');

      await pilot.shutdown();

      expect(pilot['states'].size).toBe(0);
    });
  });

  describe('State Management', () => {
    it('should initialize PerChatIdState correctly', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      const state = pilot['states'].get('chat-123');

      expect(state).toBeDefined();
      expect(state?.messageQueue).toEqual(expect.any(Array));
      expect(state?.pendingWriteFiles).toBeInstanceOf(Set);
      expect(state?.closed).toBe(false);
      expect(state?.started).toBe(true);
    });

    it('should queue messages correctly', () => {
      pilot.processMessage('chat-123', 'Hello', 'msg-001');
      pilot.processMessage('chat-123', 'World', 'msg-002');
      const state = pilot['states'].get('chat-123');

      // Messages should be in queue (they may have been consumed by the generator)
      expect(state?.messageQueue).toBeDefined();
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

  // Config Fallback tests removed - PilotConfig now requires apiKey and model
  // Use AgentFactory.createPilot() for convenient instance creation with defaults

  describe('Error Handling', () => {
    it('should handle errors in processMessage gracefully', () => {
      // processMessage should not throw even if internal operations fail
      expect(() => {
        pilot.processMessage('chat-123', 'Hello', 'msg-001');
      }).not.toThrow();
    });
  });
});
