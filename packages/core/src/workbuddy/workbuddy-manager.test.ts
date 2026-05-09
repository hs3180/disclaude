/**
 * Unit tests for WorkBuddyManager — process lifecycle management.
 *
 * Tests cover:
 * - Configuration loading
 * - Starting a WorkBuddy process (handles ENOENT gracefully)
 * - Stop with graceful shutdown
 * - Stop all processes
 * - Instance state tracking
 * - Status change callbacks
 * - Error handling (missing project, already running)
 * - List operations
 *
 * @see Issue #3442
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkBuddyManager } from './workbuddy-manager.js';
import type { WorkBuddyConfig, WorkBuddyStatus } from './types.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Test Fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-test-'));
  tempDirs.push(dir);
  return dir;
}

function createConfig(): WorkBuddyConfig {
  return {
    projects: {
      'test-project': {
        cwd: createTempDir(),
        tools: ['wechat-devtools'],
        env: {
          TEST_VAR: 'test-value',
        },
      },
      'another-project': {
        cwd: createTempDir(),
        chatId: 'oc_test123',
      },
    },
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('WorkBuddyManager', () => {
  let config: WorkBuddyConfig;
  let manager: WorkBuddyManager;

  beforeEach(() => {
    config = createConfig();
  });

  afterEach(async () => {
    // Ensure all managers are stopped
    if (manager) {
      await manager.stopAll().catch(() => {});
    }
    // Cleanup temp dirs
    for (const dir of tempDirs) {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    tempDirs.length = 0;
  });

  describe('constructor', () => {
    it('should accept valid config', () => {
      manager = new WorkBuddyManager({ config });
      expect(manager.listProjectNames()).toEqual(['test-project', 'another-project']);
    });

    it('should accept empty projects', () => {
      manager = new WorkBuddyManager({ config: { projects: {} } });
      expect(manager.listProjectNames()).toEqual([]);
    });
  });

  describe('listProjectNames', () => {
    it('should return all configured project names', () => {
      manager = new WorkBuddyManager({ config });
      const names = manager.listProjectNames();
      expect(names).toContain('test-project');
      expect(names).toContain('another-project');
    });
  });

  describe('getProjectConfig', () => {
    it('should return config for existing project', () => {
      manager = new WorkBuddyManager({ config });
      const projectConfig = manager.getProjectConfig('test-project');
      expect(projectConfig).toBeDefined();
      expect(projectConfig!.tools).toContain('wechat-devtools');
    });

    it('should return undefined for non-existent project', () => {
      manager = new WorkBuddyManager({ config });
      expect(manager.getProjectConfig('non-existent')).toBeUndefined();
    });
  });

  describe('getInstance', () => {
    it('should return undefined before starting', () => {
      manager = new WorkBuddyManager({ config });
      expect(manager.getInstance('test-project')).toBeUndefined();
    });
  });

  describe('listInstances', () => {
    it('should return empty array before starting', () => {
      manager = new WorkBuddyManager({ config });
      expect(manager.listInstances()).toEqual([]);
    });
  });

  describe('start', () => {
    it('should throw for non-existent project', () => {
      manager = new WorkBuddyManager({ config });
      expect(() => manager.start('non-existent')).toThrow(
        'WorkBuddy project "non-existent" not found in config'
      );
    });

    it('should create and track instance on spawn', () => {
      // Use short shutdown timeout to avoid slow tests when process fails
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });
      const instance = manager.start('test-project');

      expect(instance).toBeDefined();
      expect(instance.projectName).toBe('test-project');
      // Status is either 'ready' or 'error' depending on whether 'claude' CLI is available
      expect(['ready', 'error']).toContain(instance.status);

      const instances = manager.listInstances();
      expect(instances.length).toBeGreaterThanOrEqual(1);
    });

    it('should call onStatusChange callback', () => {
      const statusChanges: Array<{ name: string; status: WorkBuddyStatus }> = [];
      manager = new WorkBuddyManager({
        config,
        shutdownTimeoutMs: 100,
        callbacks: {
          onStatusChange: (name, status) => statusChanges.push({ name, status }),
          onResponse: vi.fn(),
        },
      });

      manager.start('test-project');

      // Should have received at least 'starting' status
      expect(statusChanges.length).toBeGreaterThan(0);
      expect(statusChanges[0]).toEqual({ name: 'test-project', status: 'starting' });
    });

    it('should allow restarting after process errors', () => {
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });

      // First start (likely fails with ENOENT since 'claude' isn't available)
      const inst1 = manager.start('test-project');

      // If the process errored (ENOENT), the process is cleaned up from the map,
      // so we should be able to start again
      if (inst1.status === 'error') {
        const inst2 = manager.start('test-project');
        expect(inst2).toBeDefined();
        expect(inst2.projectName).toBe('test-project');
      }
    });
  });

  describe('stop', () => {
    it('should not throw when stopping non-running project', () => {
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });
      await manager.stop('test-project');
    });

    it('should stop a running process and update status', () => {
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });
      manager.start('test-project');
      await manager.stop('test-project');

      const instance = manager.getInstance('test-project');
      expect(instance?.status).toBe('stopped');
    });
  });

  describe('stopAll', () => {
    it('should stop all running processes', () => {
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });
      manager.start('test-project');
      manager.start('another-project');

      await manager.stopAll();

      const instances = manager.listInstances();
      for (const inst of instances) {
        expect(inst.status).toBe('stopped');
      }
    });
  });

  describe('getInstance returns copies', () => {
    it('should return copies not references', () => {
      manager = new WorkBuddyManager({ config, shutdownTimeoutMs: 100 });
      manager.start('test-project');

      const inst1 = manager.getInstance('test-project');
      const inst2 = manager.getInstance('test-project');

      if (inst1 && inst2) {
        inst1.status = 'error';
        expect(inst2.status).not.toBe('error');
      }
    });
  });
});
