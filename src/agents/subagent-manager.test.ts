/**
 * Tests for SubagentManager (Issue #997).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  SubagentManager,
  getSubagentManager,
  resetSubagentManager,
  type SubagentOptions,
} from './subagent-manager.js';

// Mock AgentFactory
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createScheduleAgent: vi.fn(() => ({
      type: 'chat',
      name: 'mock-schedule-agent',
      dispose: vi.fn(),
      executeOnce: vi.fn().mockResolvedValue(undefined),
    })),
    createTaskAgent: vi.fn(() => ({
      type: 'chat',
      name: 'mock-task-agent',
      dispose: vi.fn(),
      executeOnce: vi.fn().mockResolvedValue(undefined),
    })),
    createSkillAgent: vi.fn(() => ({
      type: 'skill',
      name: 'mock-skill-agent',
      dispose: vi.fn(),
      execute: vi.fn().mockImplementation(async function* () {
        yield { content: 'Skill execution result' };
      }),
    })),
  },
}));

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let mockCallbacks: {
    sendMessage: ReturnType<typeof vi.fn>;
    sendCard: ReturnType<typeof vi.fn>;
    sendFile: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSubagentManager();

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };

    manager = new SubagentManager(mockCallbacks);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetSubagentManager();
  });

  describe('constructor', () => {
    it('should create a SubagentManager instance', () => {
      expect(manager).toBeInstanceOf(SubagentManager);
    });
  });

  describe('spawn', () => {
    it('should spawn a task agent', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      };

      const handle = await manager.spawn(options);

      expect(handle.id).toBeDefined();
      expect(handle.type).toBe('task');
      expect(handle.name).toBe('test-task');
      expect(handle.status).toBe('running');
      expect(handle.chatId).toBe('chat-123');
      expect(handle.createdAt).toBeInstanceOf(Date);
    });

    it('should spawn a schedule agent', async () => {
      const options: SubagentOptions = {
        type: 'schedule',
        name: 'test-schedule',
        prompt: 'Scheduled task prompt',
        chatId: 'chat-456',
      };

      const handle = await manager.spawn(options);

      expect(handle.type).toBe('schedule');
      expect(handle.name).toBe('test-schedule');
    });

    it('should spawn a skill agent with skillName', async () => {
      const options: SubagentOptions = {
        type: 'skill',
        name: 'test-skill',
        prompt: 'Skill task prompt',
        chatId: 'chat-789',
        skillName: 'evaluator',
      };

      const handle = await manager.spawn(options);

      expect(handle.type).toBe('skill');
      expect(handle.name).toBe('test-skill');
    });

    it('should throw error when skillName is missing for skill type', async () => {
      const options: SubagentOptions = {
        type: 'skill',
        name: 'test-skill',
        prompt: 'Skill task prompt',
        chatId: 'chat-789',
      };

      await expect(manager.spawn(options)).rejects.toThrow(
        'skillName is required for skill type subagents'
      );
    });

    it('should call onProgress callback', async () => {
      const onProgress = vi.fn();
      const options: SubagentOptions = {
        type: 'task',
        name: 'progress-test',
        prompt: 'Test prompt',
        chatId: 'chat-123',
        onProgress,
      };

      await manager.spawn(options);

      // Wait for async execution to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(onProgress).toHaveBeenCalled();
    });

    it('should track progress messages', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'progress-test',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      };

      const handle = await manager.spawn(options);

      // Wait for async execution to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      const updatedHandle = manager.get(handle.id);
      expect(updatedHandle?.progress.length).toBeGreaterThan(0);
    });
  });

  describe('list', () => {
    it('should return empty array when no subagents', () => {
      expect(manager.list()).toEqual([]);
    });

    it('should return all spawned subagents', async () => {
      await manager.spawn({
        type: 'task',
        name: 'task-1',
        prompt: 'Prompt 1',
        chatId: 'chat-1',
      });

      await manager.spawn({
        type: 'schedule',
        name: 'schedule-1',
        prompt: 'Prompt 2',
        chatId: 'chat-2',
      });

      const list = manager.list();
      expect(list).toHaveLength(2);
      expect(list.map((h) => h.name)).toContain('task-1');
      expect(list.map((h) => h.name)).toContain('schedule-1');
    });
  });

  describe('get', () => {
    it('should return undefined for unknown id', () => {
      expect(manager.get('unknown-id')).toBeUndefined();
    });

    it('should return handle for known id', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      const retrieved = manager.get(handle.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(handle.id);
      expect(retrieved?.name).toBe(handle.name);
      expect(retrieved?.type).toBe(handle.type);
    });
  });

  describe('terminate', () => {
    it('should return false for unknown id', async () => {
      const result = await manager.terminate('unknown-id');
      expect(result).toBe(false);
    });

    it('should terminate a running subagent', async () => {
      // Create a slow mock that won't complete immediately
      const { AgentFactory } = await import('./factory.js');
      vi.mocked(AgentFactory.createTaskAgent).mockReturnValueOnce({
        type: 'chat',
        name: 'slow-task-agent',
        dispose: vi.fn(),
        executeOnce: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 10000))),
      } as unknown as ReturnType<typeof AgentFactory.createTaskAgent>);

      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      expect(handle.status).toBe('running');

      const result = await manager.terminate(handle.id);
      expect(result).toBe(true);

      const terminated = manager.get(handle.id);
      expect(terminated?.status).toBe('terminated');
      expect(terminated?.error).toBe('Terminated by user');
    });

    it('should accept a reason for termination', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      await manager.terminate(handle.id, 'Timeout exceeded');

      const terminated = manager.get(handle.id);
      expect(terminated?.error).toBe('Timeout exceeded');
    });

    it('should return false for already completed subagent', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      // Manually mark as completed
      const list = manager.list();
      const internalRecord = (manager as unknown as { subagents: Map<string, { status: string }> }).subagents.get(handle.id);
      if (internalRecord) {
        internalRecord.status = 'completed';
      }

      const result = await manager.terminate(handle.id);
      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should remove old completed records', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      // Manually mark as completed with old timestamp
      const internalRecord = (manager as unknown as { subagents: Map<string, { status: string; completedAt: Date }> }).subagents.get(handle.id);
      if (internalRecord) {
        internalRecord.status = 'completed';
        internalRecord.completedAt = new Date(Date.now() - 7200000); // 2 hours ago
      }

      manager.cleanup(3600000); // 1 hour max age

      expect(manager.get(handle.id)).toBeUndefined();
    });

    it('should keep recent records', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        prompt: 'Test prompt',
        chatId: 'chat-123',
      });

      // Manually mark as completed with recent timestamp
      const internalRecord = (manager as unknown as { subagents: Map<string, { status: string; completedAt: Date }> }).subagents.get(handle.id);
      if (internalRecord) {
        internalRecord.status = 'completed';
        internalRecord.completedAt = new Date(Date.now() - 1800000); // 30 minutes ago
      }

      manager.cleanup(3600000); // 1 hour max age

      expect(manager.get(handle.id)).toBeDefined();
    });
  });
});

describe('getSubagentManager', () => {
  beforeEach(() => {
    resetSubagentManager();
  });

  afterEach(() => {
    resetSubagentManager();
  });

  it('should throw error when callbacks not provided on first call', () => {
    expect(() => getSubagentManager()).toThrow('Callbacks required for first initialization');
  });

  it('should create manager with callbacks', () => {
    const callbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    };

    const manager = getSubagentManager(callbacks);
    expect(manager).toBeInstanceOf(SubagentManager);
  });

  it('should return same instance on subsequent calls', () => {
    const callbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    };

    const manager1 = getSubagentManager(callbacks);
    const manager2 = getSubagentManager();

    expect(manager1).toBe(manager2);
  });
});

describe('resetSubagentManager', () => {
  it('should reset the singleton instance', () => {
    const callbacks = {
      sendMessage: vi.fn(),
      sendCard: vi.fn(),
      sendFile: vi.fn(),
    };

    const manager1 = getSubagentManager(callbacks);
    resetSubagentManager();

    expect(() => getSubagentManager()).toThrow('Callbacks required for first initialization');
  });
});
