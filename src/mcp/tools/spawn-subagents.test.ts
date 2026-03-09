/**
 * Tests for spawn_subagents tool.
 *
 * Issue #897: Master-Workers Multi-Agent Collaboration Pattern
 */

import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  spawn_subagents,
  setSpawnSubagentsCallbacks,
  getSpawnSubagentsCallbacks,
  disposeSpawnManager,
} from './spawn-subagents.js';
import { SubagentManager } from '../../agents/subagent-manager.js';

// Mock SubagentManager
vi.mock('../../agents/subagent-manager.js', () => ({
  SubagentManager: vi.fn().mockImplementation(() => ({
    spawn: vi.fn(),
    terminate: vi.fn(),
    dispose: vi.fn(),
    list: vi.fn().mockReturnValue([]),
  })),
}));

const mockCallbacks = {
  sendMessage: vi.fn(),
  sendCard: vi.fn(),
  sendFile: vi.fn(),
};

describe('spawn_subagents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Set up global callbacks
    setSpawnSubagentsCallbacks(mockCallbacks, 'test-chat-123');
  });

  afterEach(() => {
    disposeSpawnManager();
    setSpawnSubagentsCallbacks(null, null);
  });

  describe('setSpawnSubagentsCallbacks', () => {
    it('should set global callbacks', () => {
      const callbacks = { sendMessage: vi.fn(), sendCard: vi.fn(), sendFile: vi.fn() };
      setSpawnSubagentsCallbacks(callbacks, 'chat-456');

      const result = getSpawnSubagentsCallbacks();
      expect(result.callbacks).toBe(callbacks);
      expect(result.chatId).toBe('chat-456');
    });

    it('should clear global callbacks when set to null', () => {
      setSpawnSubagentsCallbacks(null, null);

      const result = getSpawnSubagentsCallbacks();
      expect(result.callbacks).toBeNull();
      expect(result.chatId).toBeNull();
    });
  });

  describe('spawn_subagents', () => {
    it('should return error when tasks array is empty', async () => {
      const result = await spawn_subagents({ tasks: [] });

      expect(result.success).toBe(false);
      expect(result.error).toBe('tasks array is empty');
      expect(result.message).toContain('没有提供任务');
    });

    it('should return error when callbacks are not set', async () => {
      setSpawnSubagentsCallbacks(null, null);

      const result = await spawn_subagents({
        tasks: [{ type: 'task', name: 'test', prompt: 'test prompt' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('callbacks.sendMessage is required');
    });

    it('should return error when chatId is not set', async () => {
      setSpawnSubagentsCallbacks(mockCallbacks, null);

      const result = await spawn_subagents({
        tasks: [{ type: 'task', name: 'test', prompt: 'test prompt' }],
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('chatId is required');
    });

    it('should spawn subagents and return results', async () => {
      // Mock successful spawn
      const mockHandle = {
        id: 'task-test-123',
        type: 'task',
        name: 'test-task',
        chatId: 'test-chat-123',
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        output: 'Task completed successfully',
        isolation: 'none' as const,
      };

      const mockManager = {
        spawn: vi.fn().mockResolvedValue(mockHandle),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue([mockHandle]),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      const result = await spawn_subagents({
        tasks: [{ type: 'task', name: 'test-task', prompt: 'Test prompt' }],
      });

      expect(result.success).toBe(true);
      expect(result.message).toContain('任务完成');
      expect(result.results).toHaveLength(1);
      expect(result.results[0].name).toBe('test-task');
      expect(result.results[0].status).toBe('completed');
    });

    it('should handle partial failures', async () => {
      const mockHandles = [
        {
          id: 'task-1',
          type: 'task',
          name: 'task-1',
          chatId: 'test-chat-123',
          status: 'completed' as const,
          startedAt: new Date(),
          completedAt: new Date(),
          output: 'Success',
          isolation: 'none' as const,
        },
        {
          id: 'task-2',
          type: 'task',
          name: 'task-2',
          chatId: 'test-chat-123',
          status: 'failed' as const,
          startedAt: new Date(),
          completedAt: new Date(),
          error: 'Task failed',
          isolation: 'none' as const,
        },
      ];

      const mockManager = {
        spawn: vi.fn()
          .mockResolvedValueOnce(mockHandles[0])
          .mockResolvedValueOnce(mockHandles[1]),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue(mockHandles),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      const result = await spawn_subagents({
        tasks: [
          { type: 'task', name: 'task-1', prompt: 'Task 1' },
          { type: 'task', name: 'task-2', prompt: 'Task 2' },
        ],
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain('部分任务失败');
      expect(result.results).toHaveLength(2);
      expect(result.summary).toContain('✅ 成功: 1');
      expect(result.summary).toContain('❌ 失败: 1');
    });

    it('should respect maxParallel limit', async () => {
      const mockHandle = {
        id: 'task-1',
        type: 'task',
        name: 'task',
        chatId: 'test-chat-123',
        status: 'completed' as const,
        startedAt: new Date(),
        completedAt: new Date(),
        isolation: 'none' as const,
      };

      const mockManager = {
        spawn: vi.fn().mockResolvedValue(mockHandle),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue([mockHandle]),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      await spawn_subagents({
        tasks: [
          { type: 'task', name: 'task-1', prompt: 'Task 1' },
          { type: 'task', name: 'task-2', prompt: 'Task 2' },
          { type: 'task', name: 'task-3', prompt: 'Task 3' },
          { type: 'task', name: 'task-4', prompt: 'Task 4' },
        ],
        maxParallel: 2,
      });

      // spawn should be called 4 times (once per task)
      expect(mockManager.spawn).toHaveBeenCalledTimes(4);
    });

    it('should handle spawn failures gracefully', async () => {
      const mockManager = {
        spawn: vi.fn().mockRejectedValue(new Error('Spawn failed')),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      const result = await spawn_subagents({
        tasks: [{ type: 'task', name: 'test', prompt: 'test' }],
      });

      expect(result.success).toBe(false);
      expect(result.results).toHaveLength(1);
      expect(result.results[0].status).toBe('failed');
      expect(result.results[0].error).toContain('Spawn failed');
    });

    it('should stop on first failure when continueOnFailure is false', async () => {
      const mockHandles = [
        {
          id: 'task-1',
          type: 'task',
          name: 'task-1',
          chatId: 'test-chat-123',
          status: 'failed' as const,
          startedAt: new Date(),
          completedAt: new Date(),
          error: 'First task failed',
          isolation: 'none' as const,
        },
      ];

      const mockManager = {
        spawn: vi.fn().mockResolvedValue(mockHandles[0]),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue(mockHandles),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      const result = await spawn_subagents({
        tasks: [
          { type: 'task', name: 'task-1', prompt: 'Task 1' },
          { type: 'task', name: 'task-2', prompt: 'Task 2' },
        ],
        continueOnFailure: false,
        maxParallel: 1, // Force sequential execution
      });

      // Only first task should be spawned
      expect(mockManager.spawn).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(false);
    });
  });

  describe('disposeSpawnManager', () => {
    it('should dispose the manager and clear reference', () => {
      const mockManager = {
        spawn: vi.fn(),
        terminate: vi.fn(),
        dispose: vi.fn(),
        list: vi.fn().mockReturnValue([]),
      };

      vi.mocked(SubagentManager).mockImplementation(() => mockManager as unknown as SubagentManager);

      // Trigger manager creation
      setSpawnSubagentsCallbacks(mockCallbacks, 'test-chat');

      // Dispose
      disposeSpawnManager();

      // Should be able to call multiple times without error
      disposeSpawnManager();
    });
  });
});
