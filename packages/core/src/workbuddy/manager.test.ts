import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkBuddyManager } from './manager.js';
import type { WorkBuddyConfig } from './types.js';

describe('WorkBuddyManager', () => {
  const mockConfig: WorkBuddyConfig = {
    projects: {
      'test-project': {
        cwd: '/tmp/test-project',
        chatId: 'oc_test_chat',
        tools: ['wechat-devtools'],
        env: { TEST_VAR: 'value' },
      },
      'second-project': {
        cwd: '/tmp/second-project',
        chatId: 'oc_second_chat',
      },
    },
  };

  let manager: WorkBuddyManager;

  beforeEach(() => {
    manager = new WorkBuddyManager(mockConfig);
  });

  afterEach(async () => {
    await manager.stopAll();
  });

  describe('constructor', () => {
    it('builds chat routing table from config', () => {
      const routing = manager.getChatRouting();
      expect(routing.get('oc_test_chat')).toBe('test-project');
      expect(routing.get('oc_second_chat')).toBe('second-project');
      expect(routing.has('oc_unknown')).toBe(false);
    });
  });

  describe('getProjectForChat', () => {
    it('returns project name for bound chatId', () => {
      expect(manager.getProjectForChat('oc_test_chat')).toBe('test-project');
    });

    it('returns undefined for unknown chatId', () => {
      expect(manager.getProjectForChat('oc_unknown')).toBeUndefined();
    });
  });

  describe('getStatus', () => {
    it('returns empty array before any processes are started', () => {
      const status = manager.getStatus();
      expect(status).toEqual([]);
    });
  });

  describe('sendCommand', () => {
    it('returns error for unbound chatId', async () => {
      const result = await manager.sendCommand('oc_unknown', {
        type: 'preview',
        payload: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('No WorkBuddy project bound');
    });

    it('returns error when process is not running', async () => {
      const result = await manager.sendCommand('oc_test_chat', {
        type: 'preview',
        payload: {},
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain('not running');
    });
  });

  describe('start', () => {
    it('throws for unknown project', async () => {
      await expect(manager.start('unknown')).rejects.toThrow('not found in config');
    });
  });

  describe('getProcessStatus', () => {
    it('returns undefined for unknown project', () => {
      expect(manager.getProcessStatus('unknown')).toBeUndefined();
    });
  });

  describe('config with empty projects', () => {
    it('handles empty projects gracefully', async () => {
      const emptyManager = new WorkBuddyManager({ projects: {} });
      await emptyManager.startAll();
      expect(emptyManager.getStatus()).toEqual([]);
      expect(emptyManager.getChatRouting().size).toBe(0);
    });
  });
});
