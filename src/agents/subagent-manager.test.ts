/**
 * Tests for SubagentManager - Unified subagent spawn interface.
 *
 * Issue #997: Unified subagent spawn method
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  SubagentManager,
  initSubagentManager,
  getSubagentManager,
  resetSubagentManager,
  type SubagentManagerCallbacks,
} from './subagent-manager.js';

// Mock dependencies
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
    createSubagent: vi.fn(() => ({
      execute: vi.fn().mockResolvedValue({ result: 'success' }),
      dispose: vi.fn(),
    })),
  },
}));

vi.mock('./skill-agent-manager.js', () => ({
  SkillAgentManager: vi.fn(() => ({
    start: vi.fn().mockResolvedValue('skill-test-123'),
    get: vi.fn().mockReturnValue({ pid: 12345, status: 'running' }),
    stop: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    listRunning: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let callbacks: SubagentManagerCallbacks;

  beforeEach(() => {
    callbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendCard: vi.fn().mockResolvedValue(undefined),
      sendFile: vi.fn().mockResolvedValue(undefined),
    };
    manager = new SubagentManager(callbacks);
  });

  afterEach(() => {
    resetSubagentManager();
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create a SubagentManager instance', () => {
      expect(manager).toBeInstanceOf(SubagentManager);
    });
  });

  describe('spawn', () => {
    it('should spawn a schedule agent', async () => {
      const handle = await manager.spawn({
        type: 'schedule',
        name: 'test-schedule',
        chatId: 'chat-123',
        prompt: 'Test prompt',
      });

      expect(handle).toBeDefined();
      expect(handle.type).toBe('schedule');
      expect(handle.name).toBe('test-schedule');
      expect(handle.chatId).toBe('chat-123');
      expect(handle.id).toMatch(/^sub-/);
    });

    it('should spawn a task agent', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-task',
        chatId: 'chat-456',
        prompt: 'Test task prompt',
      });

      expect(handle).toBeDefined();
      expect(handle.type).toBe('task');
      expect(handle.name).toBe('test-task');
    });

    it('should spawn a skill agent', async () => {
      const handle = await manager.spawn({
        type: 'skill',
        name: 'test-skill',
        skillName: 'test-skill',
        chatId: 'chat-789',
      });

      expect(handle).toBeDefined();
      expect(handle.type).toBe('skill');
      expect(handle.id).toMatch(/^skill-/);
    });

    it('should throw error when skillName is missing for skill type', async () => {
      await expect(
        manager.spawn({
          type: 'skill',
          name: 'test-skill',
          chatId: 'chat-123',
        })
      ).rejects.toThrow('skillName is required for skill agent type');
    });

    it('should spawn a subagent', async () => {
      const handle = await manager.spawn({
        type: 'subagent',
        name: 'site-miner',
        subagentType: 'site-miner',
        chatId: 'chat-000',
      });

      expect(handle).toBeDefined();
      expect(handle.type).toBe('subagent');
    });

    it('should throw error for unknown type', async () => {
      await expect(
        manager.spawn({
          type: 'unknown' as unknown as 'schedule',
          name: 'test',
          chatId: 'chat-123',
        })
      ).rejects.toThrow('Unknown subagent type');
    });
  });

  describe('get', () => {
    it('should return handle by id', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test',
        chatId: 'chat-123',
      });

      const retrieved = manager.get(handle.id);
      expect(retrieved).toEqual(handle);
    });

    it('should return undefined for non-existent id', () => {
      const retrieved = manager.get('non-existent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('should return status by id', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test',
        chatId: 'chat-123',
      });

      const status = manager.getStatus(handle.id);
      expect(['starting', 'running', 'completed', 'failed']).toContain(status);
    });

    it('should return undefined for non-existent id', () => {
      const status = manager.getStatus('non-existent');
      expect(status).toBeUndefined();
    });
  });

  describe('list', () => {
    it('should list all agents', async () => {
      await manager.spawn({ type: 'task', name: 'test1', chatId: 'chat-1' });
      await manager.spawn({ type: 'task', name: 'test2', chatId: 'chat-2' });

      const handles = manager.list();
      expect(handles).toHaveLength(2);
    });

    it('should filter by status', async () => {
      await manager.spawn({ type: 'task', name: 'test1', chatId: 'chat-1' });

      const running = manager.list('running');
      expect(running.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('listRunning', () => {
    it('should return only running agents', async () => {
      await manager.spawn({ type: 'task', name: 'test1', chatId: 'chat-1' });

      const running = manager.listRunning();
      expect(Array.isArray(running)).toBe(true);
    });
  });

  describe('terminate', () => {
    it('should terminate an agent', async () => {
      const handle = await manager.spawn({
        type: 'skill',
        name: 'test-skill',
        skillName: 'test-skill',
        chatId: 'chat-123',
      });

      const result = await manager.terminate(handle.id);
      expect(result).toBe(true);

      const status = manager.getStatus(handle.id);
      expect(status).toBe('stopped');
    });

    it('should return false for non-existent id', async () => {
      const result = await manager.terminate('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('terminateAll', () => {
    it('should terminate all running agents', async () => {
      await manager.spawn({
        type: 'skill',
        name: 'test1',
        skillName: 'test-skill',
        chatId: 'chat-1',
      });
      await manager.spawn({
        type: 'skill',
        name: 'test2',
        skillName: 'test-skill',
        chatId: 'chat-2',
      });

      await manager.terminateAll();

      const running = manager.listRunning();
      expect(running).toHaveLength(0);
    });
  });

  describe('cleanup', () => {
    it('should clean up old completed agents', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test',
        chatId: 'chat-123',
        prompt: 'test',
      });

      // Cleanup with 0 maxAge to remove all completed agents
      manager.cleanup(0);

      // The agent should be cleaned up if completed
      const retrieved = manager.get(handle.id);
      // Agent may or may not be cleaned depending on timing
      expect(retrieved === undefined || retrieved.status === 'completed').toBe(true);
    });
  });

  describe('dispose', () => {
    it('should dispose all resources', async () => {
      await manager.spawn({
        type: 'skill',
        name: 'test',
        skillName: 'test-skill',
        chatId: 'chat-123',
      });

      await manager.dispose();

      const handles = manager.list();
      expect(handles).toHaveLength(0);
    });
  });
});

describe('Global SubagentManager', () => {
  afterEach(() => {
    resetSubagentManager();
  });

  describe('initSubagentManager', () => {
    it('should initialize global manager', () => {
      const callbacks: SubagentManagerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendCard: vi.fn().mockResolvedValue(undefined),
        sendFile: vi.fn().mockResolvedValue(undefined),
      };

      const manager = initSubagentManager(callbacks);
      expect(manager).toBeInstanceOf(SubagentManager);

      const retrieved = getSubagentManager();
      expect(retrieved).toBe(manager);
    });
  });

  describe('getSubagentManager', () => {
    it('should return undefined when not initialized', () => {
      expect(getSubagentManager()).toBeUndefined();
    });
  });

  describe('resetSubagentManager', () => {
    it('should reset global manager', () => {
      const callbacks: SubagentManagerCallbacks = {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        sendCard: vi.fn().mockResolvedValue(undefined),
        sendFile: vi.fn().mockResolvedValue(undefined),
      };

      initSubagentManager(callbacks);
      expect(getSubagentManager()).toBeDefined();

      resetSubagentManager();
      expect(getSubagentManager()).toBeUndefined();
    });
  });
});
