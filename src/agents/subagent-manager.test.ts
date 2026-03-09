/**
 * Tests for SubagentManager.
 *
 * Issue #997: Unified subagent spawning interface.
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  SubagentManager,
  resetSubagentManager,
  initSubagentManager,
  getSubagentManager,
  type SubagentOptions,
} from './subagent-manager.js';
import type { ChatAgent } from './types.js';
import { AgentFactory } from './factory.js';

// Mock dependencies
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createScheduleAgent: vi.fn(),
    createTaskAgent: vi.fn(),
  },
}));

vi.mock('../skills/index.js', () => ({
  findSkill: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

const mockCallbacks = {
  sendMessage: vi.fn(),
  sendCard: vi.fn(),
  sendFile: vi.fn(),
};

const mockAgent = {
  executeOnce: vi.fn(),
  dispose: vi.fn(),
};

describe('SubagentManager', () => {
  let manager: SubagentManager;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSubagentManager();
    manager = new SubagentManager();

    // Setup default mocks
    vi.mocked(AgentFactory.createScheduleAgent).mockReturnValue(mockAgent as unknown as ChatAgent);
    vi.mocked(AgentFactory.createTaskAgent).mockReturnValue(mockAgent as unknown as ChatAgent);
    mockAgent.executeOnce.mockResolvedValue(undefined);
    mockAgent.dispose.mockReturnValue(undefined);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('spawn', () => {
    it('should spawn a schedule agent', async () => {
      const options: SubagentOptions = {
        type: 'schedule',
        name: 'test-schedule',
        prompt: 'Test prompt',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);

      expect(handle.type).toBe('schedule');
      expect(handle.name).toBe('test-schedule');
      expect(handle.chatId).toBe('chat-123');
      expect(handle.status).toBe('completed');
      expect(AgentFactory.createScheduleAgent).toHaveBeenCalledWith(
        'chat-123',
        mockCallbacks
      );
      expect(mockAgent.executeOnce).toHaveBeenCalled();
    });

    it('should spawn a task agent', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-456',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);

      expect(handle.type).toBe('task');
      expect(handle.name).toBe('test-task');
      expect(handle.chatId).toBe('chat-456');
      expect(handle.status).toBe('completed');
      expect(AgentFactory.createTaskAgent).toHaveBeenCalledWith(
        'chat-456',
        mockCallbacks
      );
      expect(mockAgent.executeOnce).toHaveBeenCalled();
    });

    it('should track failed agents', async () => {
      mockAgent.executeOnce.mockRejectedValue(new Error('Test error'));

      const options: SubagentOptions = {
        type: 'schedule',
        name: 'failing-schedule',
        prompt: 'Test prompt',
        chatId: 'chat-789',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);

      expect(handle.status).toBe('failed');
      expect(handle.error).toBe('Test error');
    });
  });

  describe('list', () => {
    it('should list all handles', async () => {
      await manager.spawn({
        type: 'schedule',
        name: 'schedule-1',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      await manager.spawn({
        type: 'task',
        name: 'task-1',
        prompt: 'Test',
        chatId: 'chat-2',
        callbacks: mockCallbacks,
      });

      const handles = manager.list();
      expect(handles).toHaveLength(2);
    });

    it('should filter by status', async () => {
      mockAgent.executeOnce.mockRejectedValueOnce(new Error('Fail'));

      await manager.spawn({
        type: 'schedule',
        name: 'failed-schedule',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      await manager.spawn({
        type: 'task',
        name: 'task-1',
        prompt: 'Test',
        chatId: 'chat-2',
        callbacks: mockCallbacks,
      });

      const failed = manager.list('failed');
      const completed = manager.list('completed');

      expect(failed).toHaveLength(1);
      expect(completed).toHaveLength(1);
    });
  });

  describe('terminate', () => {
    it('should return false for non-existent subagent', () => {
      const result = manager.terminate('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('onStatusChange', () => {
    it('should notify status changes', async () => {
      const callback = vi.fn();
      manager.onStatusChange(callback);

      await manager.spawn({
        type: 'schedule',
        name: 'test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      // Should be called for: running, completed
      // (starting is not notified for schedule agents since they immediately run)
      expect(callback).toHaveBeenCalledTimes(2);
    });

    it('should allow unsubscribing', async () => {
      const callback = vi.fn();
      const unsubscribe = manager.onStatusChange(callback);
      unsubscribe();

      await manager.spawn({
        type: 'schedule',
        name: 'test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('cleanup', () => {
    it('should remove old completed handles', async () => {
      await manager.spawn({
        type: 'schedule',
        name: 'test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      // Cleanup with negative max age (remove all completed immediately)
      manager.cleanup(-1);

      const handles = manager.list();
      expect(handles).toHaveLength(0);
    });
  });

  describe('dispose', () => {
    it('should clean up all resources', async () => {
      await manager.spawn({
        type: 'schedule',
        name: 'test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      manager.dispose();

      const handles = manager.list();
      expect(handles).toHaveLength(0);
    });
  });
});

describe('Global singleton', () => {
  beforeEach(() => {
    resetSubagentManager();
  });

  afterEach(() => {
    resetSubagentManager();
  });

  it('should initialize and get global manager', () => {
    const manager = initSubagentManager();
    expect(getSubagentManager()).toBe(manager);
  });

  it('should return undefined before initialization', () => {
    expect(getSubagentManager()).toBeUndefined();
  });

  it('should reset global manager', () => {
    initSubagentManager();
    resetSubagentManager();
    expect(getSubagentManager()).toBeUndefined();
  });
});
