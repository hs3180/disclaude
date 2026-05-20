/**
 * Unit tests for WorkBuddyManager.
 *
 * Tests cover:
 * - Construction and project registration
 * - Instance lookup (by name, by chatId)
 * - Health check (mocked HTTP)
 * - Command execution (mocked HTTP)
 * - Edge cases (no config, empty config, unknown project)
 *
 * @see Issue #3442
 */

import { describe, it, expect, vi } from 'vitest';
import { WorkBuddyManager } from './manager.js';
import type { WorkBuddyManagerOptions, WorkBuddyConfig } from './types.js';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createConfig(): WorkBuddyConfig {
  return {
    projects: {
      'my-miniprogram': {
        cwd: '/Users/dev/my-miniprogram',
        chatId: 'oc_test123',
        endpoint: 'http://localhost:8765',
        tools: ['wechat-devtools'],
        env: { WECHAT_DEVTOOLS_PATH: '/Applications/wechatwebdevtools.app' },
      },
      'another-project': {
        cwd: '/home/user/project2',
        endpoint: 'http://192.168.1.100:9000',
      },
    },
  };
}

function createManager(overrides?: Partial<WorkBuddyManagerOptions>): WorkBuddyManager {
  const options: WorkBuddyManagerOptions = {
    config: createConfig(),
    ...overrides,
  };
  return new WorkBuddyManager(options);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('WorkBuddyManager', () => {
  describe('constructor', () => {
    it('should register projects from config', () => {
      const manager = createManager();
      expect(manager.size).toBe(2);
      expect(manager.getProjectNames()).toEqual(['my-miniprogram', 'another-project']);
    });

    it('should handle empty config gracefully', () => {
      const manager = new WorkBuddyManager({});
      expect(manager.size).toBe(0);
    });

    it('should handle undefined config gracefully', () => {
      const manager = new WorkBuddyManager({ config: undefined });
      expect(manager.size).toBe(0);
    });

    it('should handle config with empty projects', () => {
      const manager = new WorkBuddyManager({ config: { projects: {} } });
      expect(manager.size).toBe(0);
    });
  });

  describe('listInstances', () => {
    it('should list all registered instances', () => {
      const manager = createManager();
      const instances = manager.listInstances();
      expect(instances).toHaveLength(2);
      expect(instances[0].name).toBe('my-miniprogram');
      expect(instances[0].status).toBe('unknown');
      expect(instances[0].config.endpoint).toBe('http://localhost:8765');
      expect(instances[1].name).toBe('another-project');
    });
  });

  describe('getInstance', () => {
    it('should return instance by name', () => {
      const manager = createManager();
      const instance = manager.getInstance('my-miniprogram');
      expect(instance).toBeDefined();
      expect(instance!.name).toBe('my-miniprogram');
      expect(instance!.config.cwd).toBe('/Users/dev/my-miniprogram');
      expect(instance!.config.chatId).toBe('oc_test123');
      expect(instance!.config.tools).toEqual(['wechat-devtools']);
    });

    it('should return undefined for unknown project', () => {
      const manager = createManager();
      expect(manager.getInstance('nonexistent')).toBeUndefined();
    });
  });

  describe('getInstanceByChatId', () => {
    it('should find instance by bound chatId', () => {
      const manager = createManager();
      const instance = manager.getInstanceByChatId('oc_test123');
      expect(instance).toBeDefined();
      expect(instance!.name).toBe('my-miniprogram');
    });

    it('should return undefined for unbound chatId', () => {
      const manager = createManager();
      expect(manager.getInstanceByChatId('oc_unknown')).toBeUndefined();
    });
  });

  describe('findNameForChatId', () => {
    it('should return project name for bound chatId', () => {
      const manager = createManager();
      expect(manager.findNameForChatId('oc_test123')).toBe('my-miniprogram');
    });

    it('should return undefined for unbound chatId', () => {
      const manager = createManager();
      expect(manager.findNameForChatId('oc_unknown')).toBeUndefined();
    });
  });

  describe('checkHealth', () => {
    it('should return error for unknown project', async () => {
      const manager = createManager();
      const result = await manager.checkHealth('nonexistent');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should update status to connected on successful health check', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
      } as Response);

      const result = await manager.checkHealth('my-miniprogram');
      expect(result.ok).toBe(true);
      expect(result.data).toBe('connected');

      const instance = manager.getInstance('my-miniprogram');
      expect(instance!.status).toBe('connected');
      expect(instance!.lastHealthCheck).toBeDefined();
    });

    it('should update status to disconnected on failed health check', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
      } as Response);

      const result = await manager.checkHealth('my-miniprogram');
      expect(result.ok).toBe(true);
      expect(result.data).toBe('disconnected');

      const instance = manager.getInstance('my-miniprogram');
      expect(instance!.status).toBe('disconnected');
    });

    it('should update status to disconnected on network error', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await manager.checkHealth('my-miniprogram');
      expect(result.ok).toBe(true);
      expect(result.data).toBe('disconnected');

      const instance = manager.getInstance('my-miniprogram');
      expect(instance!.status).toBe('disconnected');
      expect(instance!.lastError).toContain('ECONNREFUSED');
    });
  });

  describe('checkAllHealth', () => {
    it('should check health of all instances', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce({ ok: true, status: 200 } as Response)
        .mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const results = await manager.checkAllHealth();
      expect(results['my-miniprogram']).toBe('connected');
      expect(results['another-project']).toBe('disconnected');
    });
  });

  describe('executeCommand', () => {
    it('should return error for unknown project', async () => {
      const manager = createManager();
      const result = await manager.executeCommand('nonexistent', 'preview');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('should execute command successfully', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: true, data: { qrCode: '/tmp/qr.png' } }),
      } as Response);

      const result = await manager.executeCommand('my-miniprogram', 'preview', {
        qrFormat: 'image',
      });

      expect(result.ok).toBe(true);
      expect(result.data.success).toBe(true);
      expect(result.data.data).toEqual({ qrCode: '/tmp/qr.png' });
      expect(result.data.durationMs).toBeGreaterThanOrEqual(0);

      // Verify fetch was called with correct payload
      expect(globalThis.fetch).toHaveBeenCalledWith(
        'http://localhost:8765/command',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    it('should handle command failure response', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ success: false, error: 'Build failed' }),
      } as Response);

      const result = await manager.executeCommand('my-miniprogram', 'upload');
      expect(result.ok).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.error).toBe('Build failed');
    });

    it('should handle HTTP error response', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      } as Response);

      const result = await manager.executeCommand('my-miniprogram', 'preview');
      expect(result.ok).toBe(true);
      expect(result.data.success).toBe(false);
      expect(result.data.error).toContain('500');
    });

    it('should handle network error', async () => {
      const manager = createManager();
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const result = await manager.executeCommand('my-miniprogram', 'preview');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.error).toContain('my-miniprogram');

      // Verify status was updated
      const instance = manager.getInstance('my-miniprogram');
      expect(instance!.status).toBe('disconnected');
    });
  });
});
