/**
 * Unit tests for WorkBuddyManager
 * @see Issue #3442
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkBuddyManager } from './manager.js';
import type { WorkBuddyConfig } from '../config/types.js';
import type { WorkBuddyCallbacks } from './types.js';

// Mock WorkBuddyClient to avoid real HTTP calls
vi.mock('./client.js', () => {
  return {
    WorkBuddyClient: vi.fn().mockImplementation(() => ({
      sendCommand: vi.fn(),
      checkHealth: vi.fn(),
    })),
  };
});

describe('WorkBuddyManager', () => {
  let manager: WorkBuddyManager;
  let mockCallbacks: WorkBuddyCallbacks;
  let config: WorkBuddyConfig;

  beforeEach(() => {
    vi.useFakeTimers();

    mockCallbacks = {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    };

    config = {
      enabled: true,
      projects: {
        'test-project': {
          cwd: 'http://localhost:8080',
          chatId: 'oc_test_chat',
          tools: ['wechat-devtools'],
        },
        'another-project': {
          cwd: 'http://localhost:9090',
          chatId: 'oc_another_chat',
        },
      },
      timeoutMs: 5000,
      healthCheckIntervalMs: 1000,
      authToken: 'test-token',
    };

    manager = new WorkBuddyManager({
      config,
      callbacks: mockCallbacks,
    });
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('start/stop', () => {
    it('should initialize clients for all configured projects', () => {
      manager.start();

      expect(manager.isRunning()).toBe(true);
      expect(manager.getProjectKeys()).toEqual(['test-project', 'another-project']);
    });

    it('should not start twice', () => {
      manager.start();
      manager.start();

      expect(manager.getProjectKeys().length).toBe(2);
    });

    it('should stop cleanly', () => {
      manager.start();
      manager.stop();

      expect(manager.isRunning()).toBe(false);
      expect(manager.getProjectKeys()).toEqual([]);
    });

    it('should handle empty projects config', () => {
      const emptyManager = new WorkBuddyManager({
        config: { enabled: true },
        callbacks: mockCallbacks,
      });

      emptyManager.start();
      expect(emptyManager.getProjectKeys()).toEqual([]);
      emptyManager.stop();
    });
  });

  describe('getProjectConfig', () => {
    it('should return project config for existing project', () => {
      manager.start();

      const projectConfig = manager.getProjectConfig('test-project');
      expect(projectConfig).toEqual({
        cwd: 'http://localhost:8080',
        chatId: 'oc_test_chat',
        tools: ['wechat-devtools'],
      });
    });

    it('should return undefined for unknown project', () => {
      manager.start();

      expect(manager.getProjectConfig('nonexistent')).toBeUndefined();
    });
  });

  describe('sendCommand', () => {
    it('should return error response for unknown project', async () => {
      manager.start();

      const result = await manager.sendCommand('nonexistent', 'execute', 'test');

      expect(result.success).toBe(false);
      expect(result.error).toContain('No WorkBuddy configured');
    });
  });

  describe('getHealthStatus', () => {
    it('should return health status for all projects', () => {
      manager.start();

      const health = manager.getHealthStatus();
      expect(health.size).toBe(2);
      expect(health.get('test-project')?.status).toBe('unknown');
      expect(health.get('another-project')?.status).toBe('unknown');
    });

    it('should return empty map when not started', () => {
      const health = manager.getHealthStatus();
      expect(health.size).toBe(0);
    });
  });
});
