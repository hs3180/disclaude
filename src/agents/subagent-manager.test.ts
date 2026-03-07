/**
 * Tests for SubagentManager.
 *
 * Issue #997: Unified subagent spawning interface.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubagentManager,
  getSubagentManager,
  initSubagentManager,
  resetSubagentManager,
  type SubagentOptions,
  type SubagentEventCallbacks,
} from './subagent-manager.js';

// Mock AgentFactory
vi.mock('./factory.js', () => ({
  AgentFactory: {
    createScheduleAgent: vi.fn(() => ({
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    })),
    createTaskAgent: vi.fn(() => ({
      executeOnce: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
    })),
    createSkillAgent: vi.fn(() => ({
      execute: vi.fn().mockImplementation(async function* () {
        yield { content: 'Test output' };
      }),
      dispose: vi.fn(),
    })),
  },
}));

describe('SubagentManager', () => {
  let manager: SubagentManager;
  const mockCallbacks = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    manager = new SubagentManager();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await manager.dispose();
  });

  describe('constructor', () => {
    it('should create a manager with default config', () => {
      expect(manager).toBeDefined();
    });

    it('should accept custom config', () => {
      const customManager = new SubagentManager({
        defaultTimeout: 60000,
        maxConcurrent: 5,
      });
      expect(customManager).toBeDefined();
    });
  });

  describe('spawn', () => {
    it('should spawn a schedule agent', async () => {
      const options: SubagentOptions = {
        type: 'schedule',
        name: 'Test Schedule Agent',
        prompt: 'Test prompt',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);

      expect(handle).toBeDefined();
      expect(handle.type).toBe('schedule');
      expect(handle.name).toBe('Test Schedule Agent');
      expect(handle.status).toBe('running');
      expect(handle.chatId).toBe('chat-123');
    });

    it('should spawn a task agent', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'Test Task Agent',
        prompt: 'Test prompt',
        chatId: 'chat-456',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);

      expect(handle).toBeDefined();
      expect(handle.type).toBe('task');
      expect(handle.name).toBe('Test Task Agent');
    });

    it('should spawn a skill agent with skillName', async () => {
      const options: SubagentOptions = {
        type: 'skill',
        name: 'Test Skill Agent',
        prompt: 'Test prompt',
        chatId: 'chat-789',
        callbacks: mockCallbacks,
        skillName: 'evaluator',
      };

      const handle = await manager.spawn(options);

      expect(handle).toBeDefined();
      expect(handle.type).toBe('skill');
    });

    it('should throw error for skill agent without skillName', async () => {
      const options: SubagentOptions = {
        type: 'skill',
        name: 'Invalid Skill Agent',
        prompt: 'Test prompt',
        chatId: 'chat-000',
        callbacks: mockCallbacks,
        // skillName is missing
      };

      await expect(manager.spawn(options)).rejects.toThrow('skillName is required');
    });

    it('should call onStart callback', async () => {
      const onStart = vi.fn();
      const managerWithCallbacks = new SubagentManager({
        callbacks: { onStart } as SubagentEventCallbacks,
      });

      const options: SubagentOptions = {
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      await managerWithCallbacks.spawn(options);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(onStart).toHaveBeenCalled();

      await managerWithCallbacks.dispose();
    });
  });

  describe('get', () => {
    it('should return handle by ID', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);
      const retrieved = manager.get(handle.id);

      expect(retrieved).toEqual(handle);
    });

    it('should return undefined for unknown ID', () => {
      const result = manager.get('unknown-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('should return status by ID', async () => {
      const options: SubagentOptions = {
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-123',
        callbacks: mockCallbacks,
      };

      const handle = await manager.spawn(options);
      const status = manager.getStatus(handle.id);

      expect(status).toBe('running');
    });
  });

  describe('list', () => {
    it('should list all handles', async () => {
      await manager.spawn({
        type: 'task',
        name: 'Test 1',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      await manager.spawn({
        type: 'task',
        name: 'Test 2',
        prompt: 'Test',
        chatId: 'chat-2',
        callbacks: mockCallbacks,
      });

      const handles = manager.list();
      expect(handles).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await manager.spawn({
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      const running = manager.list('running');
      const completed = manager.list('completed');

      expect(running).toHaveLength(1);
      expect(completed).toHaveLength(0);
    });
  });

  describe('listRunning', () => {
    it('should return only running handles', async () => {
      await manager.spawn({
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      const running = manager.listRunning();
      expect(running).toHaveLength(1);
      expect(running[0].status).toBe('running');
    });
  });

  describe('terminate', () => {
    it('should terminate a running subagent', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      const result = await manager.terminate(handle.id);

      expect(result).toBe(true);
      expect(handle.status).toBe('stopped');
      expect(handle.completedAt).toBeDefined();
    });

    it('should return false for unknown ID', async () => {
      const result = await manager.terminate('unknown-id');
      expect(result).toBe(false);
    });
  });

  describe('terminateAll', () => {
    it('should terminate all running subagents', async () => {
      await manager.spawn({
        type: 'task',
        name: 'Test 1',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      await manager.spawn({
        type: 'task',
        name: 'Test 2',
        prompt: 'Test',
        chatId: 'chat-2',
        callbacks: mockCallbacks,
      });

      await manager.terminateAll();

      const running = manager.listRunning();
      expect(running).toHaveLength(0);
    });
  });

  describe('cleanup', () => {
    it('should remove old completed handles', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'Test',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      // Manually set as completed with old timestamp
      handle.status = 'completed';
      handle.completedAt = new Date(Date.now() - 7200000); // 2 hours ago

      manager.cleanup(3600000); // 1 hour max age

      const result = manager.get(handle.id);
      expect(result).toBeUndefined();
    });
  });

  describe('maxConcurrent limit', () => {
    it('should reject when max concurrent reached', async () => {
      const limitedManager = new SubagentManager({ maxConcurrent: 1 });

      await limitedManager.spawn({
        type: 'task',
        name: 'Test 1',
        prompt: 'Test',
        chatId: 'chat-1',
        callbacks: mockCallbacks,
      });

      await expect(
        limitedManager.spawn({
          type: 'task',
          name: 'Test 2',
          prompt: 'Test',
          chatId: 'chat-2',
          callbacks: mockCallbacks,
        })
      ).rejects.toThrow('Maximum concurrent subagents reached');

      await limitedManager.dispose();
    });
  });
});

describe('Global SubagentManager', () => {
  beforeEach(() => {
    resetSubagentManager();
  });

  afterEach(() => {
    resetSubagentManager();
  });

  it('should return undefined before initialization', () => {
    expect(getSubagentManager()).toBeUndefined();
  });

  it('should return instance after initialization', () => {
    const manager = initSubagentManager();
    expect(getSubagentManager()).toBe(manager);
  });

  it('should accept config on initialization', () => {
    const manager = initSubagentManager({ maxConcurrent: 5 });
    expect(manager).toBeDefined();
  });

  it('should reset to undefined', () => {
    initSubagentManager();
    resetSubagentManager();
    expect(getSubagentManager()).toBeUndefined();
  });
});
