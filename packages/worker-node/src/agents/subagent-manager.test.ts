/**
 * Tests for SubagentManager.
 *
 * @see subagent-manager.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @disclaude/core
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Mock AgentFactory
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createTaskAgent: vi.fn(),
    createScheduleAgent: vi.fn(),
  },
}));

import {
  SubagentManager,
  getSubagentManager,
  initSubagentManager,
  resetSubagentManager,
} from './subagent-manager.js';
import { AgentFactory } from './factory.js';

const mockAgentFactory = vi.mocked(AgentFactory);

function createMockAgent() {
  return {
    executeOnce: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
  };
}

function createMockCallbacks(): any {
  return {
    sendMessage: vi.fn(),
    sendInteractive: vi.fn(),
    onEvent: vi.fn(),
  };
}

describe('SubagentManager', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSubagentManager();
    manager = new SubagentManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('spawn', () => {
    it('should spawn a task agent and track it', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Do something',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      expect(handle.id).toMatch(/^task-/);
      expect(handle.type).toBe('task');
      expect(handle.name).toBe('test-task');
      expect(handle.chatId).toBe('chat-1');
      expect(handle.status).toBe('completed');
      expect(handle.completedAt).toBeDefined();
    });

    it('should spawn a schedule agent and track it', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createScheduleAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'schedule',
        name: 'daily-scan',
        prompt: 'Run daily scan',
        chatId: 'chat-2',
        callbacks: createMockCallbacks(),
        schedule: '0 9 * * *',
      });

      expect(handle.id).toMatch(/^schedule-/);
      expect(handle.type).toBe('schedule');
      expect(handle.schedule).toBe('0 9 * * *');
      expect(handle.status).toBe('completed');
    });

    it('should set status to failed when agent execution throws', async () => {
      const mockAgent = createMockAgent();
      mockAgent.executeOnce.mockRejectedValue(new Error('Agent crashed'));
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'failing-task',
        prompt: 'Crash',
        chatId: 'chat-3',
        callbacks: createMockCallbacks(),
      });

      expect(handle.status).toBe('failed');
      expect(handle.error).toBe('Agent crashed');
    });

    it('should dispose agent after execution', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'cleanup-test',
        prompt: 'Test',
        chatId: 'chat-4',
        callbacks: createMockCallbacks(),
      });

      expect(mockAgent.dispose).toHaveBeenCalled();
    });

    it('should still dispose agent when execution fails', async () => {
      const mockAgent = createMockAgent();
      mockAgent.executeOnce.mockRejectedValue(new Error('fail'));
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'fail-cleanup',
        prompt: 'Fail',
        chatId: 'chat-5',
        callbacks: createMockCallbacks(),
      });

      expect(mockAgent.dispose).toHaveBeenCalled();
    });

    it('should use default isolation mode "none"', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'isolation-test',
        prompt: 'Test',
        chatId: 'chat-6',
        callbacks: createMockCallbacks(),
      });

      expect(handle.isolation).toBe('none');
    });

    it('should notify status callbacks on completion', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const statusCallback = vi.fn();
      manager.onStatusChange(statusCallback);

      await manager.spawn({
        type: 'task',
        name: 'callback-test',
        prompt: 'Test',
        chatId: 'chat-7',
        callbacks: createMockCallbacks(),
      });

      // Should receive: starting (implicitly set), running, completed
      expect(statusCallback).toHaveBeenCalled();
      const {calls} = statusCallback.mock;
      const [lastArgs] = calls[calls.length - 1];
      expect(lastArgs.status).toBe('completed');
    });
  });

  describe('onStatusChange', () => {
    it('should return unsubscribe function', () => {
      const cb = vi.fn();
      const unsub = manager.onStatusChange(cb);

      unsub();
      // Should not be called after unsubscribe
      // (no spawn to trigger it, just verify it doesn't throw)
      expect(() => unsub()).not.toThrow();
    });

    it('should not invoke callback after unsubscribe', async () => {
      const cb = vi.fn();
      const unsub = manager.onStatusChange(cb);

      unsub();

      // Spawn an agent to trigger status change — callback should NOT fire
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'post-unsub-task',
        prompt: 'Test',
        chatId: 'chat-unsub',
        callbacks: createMockCallbacks(),
      });

      expect(cb).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent subagent', () => {
      expect(manager.get('nonexistent')).toBeUndefined();
    });

    it('should return handle after spawn', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'get-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      expect(manager.get(handle.id)).toBe(handle);
    });
  });

  describe('getStatus', () => {
    it('should return undefined for non-existent subagent', () => {
      expect(manager.getStatus('nonexistent')).toBeUndefined();
    });

    it('should return current status', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'status-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      expect(manager.getStatus(handle.id)).toBe('completed');
    });
  });

  describe('list', () => {
    it('should return empty array when no subagents', () => {
      expect(manager.list()).toEqual([]);
    });

    it('should return all subagents', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'task-1',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });
      await manager.spawn({
        type: 'task',
        name: 'task-2',
        prompt: 'Test',
        chatId: 'chat-2',
        callbacks: createMockCallbacks(),
      });

      expect(manager.list()).toHaveLength(2);
    });

    it('should filter by status', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'completed-task',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      expect(manager.list('completed')).toHaveLength(1);
      expect(manager.list('running')).toHaveLength(0);
    });
  });

  describe('listRunning', () => {
    it('should return only running subagents', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'task',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      // Task completed immediately
      expect(manager.listRunning()).toHaveLength(0);
    });
  });

  describe('terminate', () => {
    it('should return false for non-existent subagent', () => {
      expect(manager.terminate('nonexistent')).toBe(false);
    });

    it('should stop a tracked subagent', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'terminate-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      const result = manager.terminate(handle.id);
      expect(result).toBe(true);
      expect(manager.get(handle.id)?.status).toBe('stopped');
    });
  });

  describe('terminateAll', () => {
    it('should terminate all running subagents', () => {
      // This tests the cleanup path - since agents complete immediately,
      // there's nothing running. Just ensure it doesn't throw.
      expect(() => manager.terminateAll()).not.toThrow();
    });
  });

  describe('cleanup', () => {
    it('should remove old completed subagents', async () => {
      vi.useFakeTimers();
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'cleanup-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      // Advance time by 2 hours so the completed subagent exceeds maxAge
      vi.advanceTimersByTime(7200000);

      manager.cleanup(3600000); // 1 hour maxAge

      expect(manager.get(handle.id)).toBeUndefined();
      vi.useRealTimers();
    });

    it('should keep recent subagents', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'keep-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      manager.cleanup(3600000);

      expect(manager.get(handle.id)).toBeDefined();
    });

    it('should use default maxAge of 1 hour', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      const handle = await manager.spawn({
        type: 'task',
        name: 'default-age',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      manager.cleanup();

      // Just completed, should still be there
      expect(manager.get(handle.id)).toBeDefined();
    });
  });

  describe('dispose', () => {
    it('should clear all state', async () => {
      const mockAgent = createMockAgent();
      mockAgentFactory.createTaskAgent.mockReturnValue(mockAgent as any);

      await manager.spawn({
        type: 'task',
        name: 'dispose-test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: createMockCallbacks(),
      });

      manager.dispose();

      expect(manager.list()).toHaveLength(0);
    });
  });

  describe('global singleton', () => {
    it('should initialize and get global manager', () => {
      const mgr = initSubagentManager();
      expect(getSubagentManager()).toBe(mgr);
    });

    it('should reset global manager', () => {
      initSubagentManager();
      resetSubagentManager();
      expect(getSubagentManager()).toBeUndefined();
    });
  });
});
