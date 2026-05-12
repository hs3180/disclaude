import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkBuddyManager } from './workbuddy-manager.js';
import type { WorkBuddyConfig, WorkBuddyCommand, WorkBuddyCommandResult } from './types.js';

const mockConfig: WorkBuddyConfig = {
  projects: {
    'my-miniprogram': {
      workingDir: '/Users/dev/my-miniprogram',
      chatId: 'oc_test_chat',
      tools: ['wechat-devtools'],
      env: { WECHAT_DEVTOOLS_PATH: '/Applications/wechatwebdevtools.app' },
    },
  },
};

function createCommand(overrides?: Partial<WorkBuddyCommand>): WorkBuddyCommand {
  return {
    id: 'cmd-1',
    type: 'preview',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function createResult(overrides?: Partial<WorkBuddyCommandResult>): WorkBuddyCommandResult {
  return {
    commandId: 'cmd-1',
    status: 'success',
    completedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('WorkBuddyManager', () => {
  let manager: WorkBuddyManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new WorkBuddyManager({ config: mockConfig });
  });

  afterEach(() => {
    manager.stopHealthChecks();
    vi.useRealTimers();
  });

  describe('register', () => {
    it('should register a WorkBuddy with online status', () => {
      const reg = manager.register('my-miniprogram');
      expect(reg.projectKey).toBe('my-miniprogram');
      expect(reg.status).toBe('online');
      expect(reg.registeredAt).toBeTruthy();
    });

    it('should register with explicit status', () => {
      const reg = manager.register('my-miniprogram', 'busy');
      expect(reg.status).toBe('busy');
    });

    it('should overwrite existing registration', () => {
      manager.register('my-miniprogram', 'online');
      const reg = manager.register('my-miniprogram', 'offline');
      expect(reg.status).toBe('offline');
    });
  });

  describe('deregister', () => {
    it('should remove a registered WorkBuddy', () => {
      manager.register('my-miniprogram');
      expect(manager.deregister('my-miniprogram')).toBe(true);
      expect(manager.getRegistration('my-miniprogram')).toBeUndefined();
    });

    it('should return false for non-existent project', () => {
      expect(manager.deregister('nonexistent')).toBe(false);
    });
  });

  describe('updateStatus', () => {
    it('should update status of a registered WorkBuddy', () => {
      manager.register('my-miniprogram', 'online');
      expect(manager.updateStatus('my-miniprogram', 'busy')).toBe(true);
      expect(manager.getRegistration('my-miniprogram')!.status).toBe('busy');
    });

    it('should return false for non-existent project', () => {
      expect(manager.updateStatus('nonexistent', 'online')).toBe(false);
    });

    it('should update lastHealthCheck timestamp', () => {
      manager.register('my-miniprogram');
      const before = manager.getRegistration('my-miniprogram')!.lastHealthCheck;
      vi.advanceTimersByTime(1000);
      manager.updateStatus('my-miniprogram', 'online');
      const after = manager.getRegistration('my-miniprogram')!.lastHealthCheck;
      expect(after).not.toBe(before);
    });
  });

  describe('getProjectConfig', () => {
    it('should return config for a registered project', () => {
      const config = manager.getProjectConfig('my-miniprogram');
      expect(config?.workingDir).toBe('/Users/dev/my-miniprogram');
      expect(config?.chatId).toBe('oc_test_chat');
    });

    it('should return undefined for unknown project', () => {
      expect(manager.getProjectConfig('nonexistent')).toBeUndefined();
    });

    it('should return undefined when no config is provided', () => {
      const noConfigManager = new WorkBuddyManager({});
      expect(noConfigManager.getProjectConfig('my-miniprogram')).toBeUndefined();
    });
  });

  describe('isAvailable', () => {
    it('should return true for online WorkBuddy', () => {
      manager.register('my-miniprogram', 'online');
      expect(manager.isAvailable('my-miniprogram')).toBe(true);
    });

    it('should return false for offline WorkBuddy', () => {
      manager.register('my-miniprogram', 'offline');
      expect(manager.isAvailable('my-miniprogram')).toBe(false);
    });

    it('should return false for busy WorkBuddy', () => {
      manager.register('my-miniprogram', 'busy');
      expect(manager.isAvailable('my-miniprogram')).toBe(false);
    });

    it('should return false for unregistered project', () => {
      expect(manager.isAvailable('nonexistent')).toBe(false);
    });
  });

  describe('sendCommand', () => {
    it('should throw if WorkBuddy is not registered', async () => {
      await expect(manager.sendCommand('nonexistent', createCommand())).rejects.toThrow(
        'WorkBuddy not registered',
      );
    });

    it('should throw if WorkBuddy is not online', async () => {
      manager.register('my-miniprogram', 'offline');
      await expect(manager.sendCommand('my-miniprogram', createCommand())).rejects.toThrow(
        'WorkBuddy not available',
      );
    });

    it('should throw if no transport is configured', async () => {
      manager.register('my-miniprogram', 'online');
      await expect(manager.sendCommand('my-miniprogram', createCommand())).rejects.toThrow(
        'No transport configured',
      );
    });

    it('should send command via transport and mark as busy', async () => {
      const transport = { sendCommand: vi.fn().mockResolvedValue(undefined) };
      const mgr = new WorkBuddyManager({ config: mockConfig, transport });
      mgr.register('my-miniprogram', 'online');

      await mgr.sendCommand('my-miniprogram', createCommand());

      expect(transport.sendCommand).toHaveBeenCalledWith('my-miniprogram', createCommand());
      expect(mgr.getRegistration('my-miniprogram')!.status).toBe('busy');
      expect(mgr.getRegistration('my-miniprogram')!.activeCommandId).toBe('cmd-1');
    });

    it('should mark as error on transport failure', async () => {
      const transport = { sendCommand: vi.fn().mockRejectedValue(new Error('network')) };
      const mgr = new WorkBuddyManager({ config: mockConfig, transport });
      mgr.register('my-miniprogram', 'online');

      await expect(mgr.sendCommand('my-miniprogram', createCommand())).rejects.toThrow('network');
      expect(mgr.getRegistration('my-miniprogram')!.status).toBe('error');
      expect(mgr.getRegistration('my-miniprogram')!.activeCommandId).toBeUndefined();
    });
  });

  describe('handleResult', () => {
    it('should clear active command and set status to online on success', () => {
      const transport = { sendCommand: vi.fn().mockResolvedValue(undefined) };
      const mgr = new WorkBuddyManager({ config: mockConfig, transport });
      mgr.register('my-miniprogram', 'busy');
      mgr.getRegistration('my-miniprogram')!.activeCommandId = 'cmd-1';

      mgr.handleResult(createResult({ status: 'success' }));

      const reg = mgr.getRegistration('my-miniprogram')!;
      expect(reg.status).toBe('online');
      expect(reg.activeCommandId).toBeUndefined();
    });

    it('should set status to error on error result', () => {
      const mgr = new WorkBuddyManager({ config: mockConfig });
      mgr.register('my-miniprogram', 'busy');
      mgr.getRegistration('my-miniprogram')!.activeCommandId = 'cmd-1';

      mgr.handleResult(createResult({ status: 'error', error: 'Command failed' }));

      expect(mgr.getRegistration('my-miniprogram')!.status).toBe('error');
    });

    it('should handle result for unknown command gracefully', () => {
      const mgr = new WorkBuddyManager({ config: mockConfig });
      // Should not throw
      mgr.handleResult(createResult({ commandId: 'unknown-cmd' }));
    });
  });

  describe('health checks', () => {
    it('should mark stale registrations as offline', () => {
      manager.register('my-miniprogram', 'online');
      manager.startHealthChecks();

      // Advance time well past stale threshold (2x interval = 60s, default 30s interval)
      // The 3rd check at ~90s will see age ~90s > 60s threshold
      vi.advanceTimersByTime(91_000);

      expect(manager.getRegistration('my-miniprogram')!.status).toBe('offline');
    });

    it('should not mark recently checked registrations as offline', () => {
      manager.register('my-miniprogram', 'online');
      manager.startHealthChecks();

      // Advance 15 seconds and update health
      vi.advanceTimersByTime(15_000);
      manager.updateStatus('my-miniprogram', 'online');

      // Advance another 45 seconds (total 60s, but last check was at 15s)
      vi.advanceTimersByTime(45_000);

      expect(manager.getRegistration('my-miniprogram')!.status).toBe('online');
    });

    it('should stop health checks when requested', () => {
      manager.register('my-miniprogram', 'online');
      manager.startHealthChecks();
      manager.stopHealthChecks();

      vi.advanceTimersByTime(120_000);

      expect(manager.getRegistration('my-miniprogram')!.status).toBe('online');
    });
  });

  describe('getAllRegistrations', () => {
    it('should return all registered WorkBuddys', () => {
      manager.register('project-a', 'online');
      manager.register('project-b', 'offline');

      const all = manager.getAllRegistrations();
      expect(all).toHaveLength(2);
      expect(all.map((r) => r.projectKey)).toContain('project-a');
      expect(all.map((r) => r.projectKey)).toContain('project-b');
    });

    it('should return empty array when no registrations', () => {
      expect(manager.getAllRegistrations()).toEqual([]);
    });
  });
});
