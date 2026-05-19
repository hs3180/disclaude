/**
 * Unit tests for WorkBuddyManager.
 *
 * Uses vi.fn() to mock global fetch since nock doesn't intercept
 * Node.js native fetch (undici-based).
 *
 * @module tests/unit/workbuddy/workbuddy-manager
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkBuddyManager } from '@disclaude/core';
import type { WorkBuddyConfig } from '@disclaude/core';

function mockResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(typeof data === 'string' ? data : JSON.stringify(data)),
  } as Response;
}

describe('WorkBuddyManager', () => {
  const config: WorkBuddyConfig = {
    timeout: 5000,
    projects: {
      'my-miniprogram': {
        url: 'http://192.168.1.100:8765',
        cwd: '/Users/dev/my-miniprogram',
        chatId: 'oc_test123',
        apiKey: 'secret-key',
        tools: ['wechat-devtools'],
      },
      'another-project': {
        url: 'http://192.168.1.101:8765',
        cwd: '/Users/dev/another',
      },
    },
  };

  let manager: WorkBuddyManager;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    manager = new WorkBuddyManager(config);
  });

  describe('constructor', () => {
    it('should initialize with no config', () => {
      const emptyManager = new WorkBuddyManager(undefined);
      expect(emptyManager.isConfigured()).toBe(false);
      expect(emptyManager.listInstances()).toHaveLength(0);
    });

    it('should initialize with empty projects', () => {
      const emptyManager = new WorkBuddyManager({ projects: {} });
      expect(emptyManager.isConfigured()).toBe(false);
    });

    it('should initialize clients for all configured projects', () => {
      expect(manager.isConfigured()).toBe(true);
      expect(manager.listInstances()).toHaveLength(2);
    });
  });

  describe('listInstances', () => {
    it('should list all configured instances', () => {
      const instances = manager.listInstances();
      expect(instances).toHaveLength(2);

      const names = instances.map((i) => i.name).sort();
      expect(names).toEqual(['another-project', 'my-miniprogram']);
    });

    it('should include correct instance properties', () => {
      const instance = manager.getInstance('my-miniprogram')!;
      expect(instance.name).toBe('my-miniprogram');
      expect(instance.url).toBe('http://192.168.1.100:8765');
      expect(instance.chatId).toBe('oc_test123');
      expect(instance.status).toBe('unknown');
      expect(instance.tools).toEqual(['wechat-devtools']);
    });
  });

  describe('findByChatId', () => {
    it('should find instance by chatId', () => {
      const instance = manager.findByChatId('oc_test123');
      expect(instance).toBeDefined();
      expect(instance!.name).toBe('my-miniprogram');
    });

    it('should return undefined for unknown chatId', () => {
      const instance = manager.findByChatId('oc_nonexistent');
      expect(instance).toBeUndefined();
    });
  });

  describe('getProjectConfig', () => {
    it('should return config for existing project', () => {
      const projectConfig = manager.getProjectConfig('my-miniprogram');
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.url).toBe('http://192.168.1.100:8765');
      expect(projectConfig!.cwd).toBe('/Users/dev/my-miniprogram');
    });

    it('should return undefined for unknown project', () => {
      const projectConfig = manager.getProjectConfig('nonexistent');
      expect(projectConfig).toBeUndefined();
    });
  });

  describe('execute', () => {
    it('should execute command on a named instance', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        success: true,
        stdout: 'Preview generated',
        exitCode: 0,
      }));

      const result = await manager.execute('my-miniprogram', {
        command: 'preview',
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Preview generated');
    });

    it('should return error for unknown project', async () => {
      const result = await manager.execute('nonexistent', {
        command: 'preview',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('healthCheck', () => {
    it('should return unhealthy for unknown project', async () => {
      const health = await manager.healthCheck('nonexistent');
      expect(health.healthy).toBe(false);
    });

    it('should check health and update status', async () => {
      mockFetch.mockResolvedValueOnce(mockResponse({
        version: '1.0.0',
        cwd: '/Users/dev/my-miniprogram',
        tools: ['wechat-devtools'],
        uptime: 3600,
      }));

      const health = await manager.healthCheck('my-miniprogram');

      expect(health.healthy).toBe(true);
      expect(health.version).toBe('1.0.0');

      const instance = manager.getInstance('my-miniprogram')!;
      expect(instance.status).toBe('online');
      expect(instance.lastChecked).toBeDefined();
    });

    it('should update status to offline on health check failure', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      await manager.healthCheck('my-miniprogram');

      const instance = manager.getInstance('my-miniprogram')!;
      expect(instance.status).toBe('offline');
    });
  });

  describe('healthCheckAll', () => {
    it('should check health of all instances', async () => {
      mockFetch
        .mockResolvedValueOnce(mockResponse({ version: '1.0.0' }))
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const results = await manager.healthCheckAll();

      expect(results['my-miniprogram'].healthy).toBe(true);
      expect(results['another-project'].healthy).toBe(false);
    });
  });
});
