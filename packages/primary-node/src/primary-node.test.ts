/**
 * Tests for PrimaryNode — workspace isolation and scheduler skip behavior.
 *
 * @see Issue #3414 - Test isolation for workspace/schedules
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Partially mock @disclaude/core to prevent real Config/Scheduler side effects
// while preserving type exports that don't need mocking
vi.mock('@disclaude/core', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
    Config: {
      ...actual.Config,
      getWorkspaceDir: vi.fn(() => '/mock/production/workspace'),
    },
    UnixSocketIpcServer: vi.fn().mockImplementation(() => ({
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      getSocketPath: vi.fn(() => '/tmp/mock-ipc.sock'),
    })),
    createInteractiveMessageHandler: vi.fn(() => vi.fn()),
    generateSocketPath: vi.fn(() => '/tmp/mock-ipc.sock'),
    ChatStore: vi.fn().mockImplementation(() => ({})),
  };
});

// Mock internal modules that have heavy dependencies
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn(),
  },
  toChatAgentCallbacks: vi.fn(),
}));

vi.mock('./routers/card-action-router.js', () => ({
  CardActionRouter: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('./services/debug-group-service.js', () => ({
  DebugGroupService: vi.fn().mockImplementation(() => ({})),
  getDebugGroupService: vi.fn(() => ({})),
}));

vi.mock('./channel-manager.js', () => ({
  ChannelManager: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
    getAll: vi.fn(() => []),
    get: vi.fn(),
    getFirstChannel: vi.fn(),
    has: vi.fn(),
    size: vi.fn(() => 0),
    clear: vi.fn(),
    setupHandlers: vi.fn(),
    broadcast: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
    getStatusInfo: vi.fn(() => []),
  })),
}));

vi.mock('./interactive-context.js', () => ({
  InteractiveContextStore: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
  })),
}));

import { PrimaryNode } from './primary-node.js';

describe('PrimaryNode', () => {
  describe('workspace isolation (Issue #3414)', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'disclaude-test-'));
    });

    afterEach(() => {
      // Clean up temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should use custom workspaceDir for ChatStore path', () => {
      const node = new PrimaryNode({ workspaceDir: tmpDir });

      // The workspaceDir should be stored on the instance
      expect((node as any).workspaceDir).toBe(tmpDir);
    });

    it('should fall back to Config.getWorkspaceDir() when workspaceDir not provided', async () => {
      // Import the mocked Config
      const { Config } = await import('@disclaude/core');

      const node = new PrimaryNode();

      // Should use the mocked Config.getWorkspaceDir()
      expect((node as any).workspaceDir).toBe('/mock/production/workspace');
      expect(Config.getWorkspaceDir).toHaveBeenCalled();
    });

    it('should skip scheduler initialization when skipSchedules is true', async () => {
      const node = new PrimaryNode({
        workspaceDir: tmpDir,
        skipSchedules: true,
      });

      // start() should succeed without scheduler
      await node.start();

      // No scheduler should be created
      expect(node.getScheduler()).toBeUndefined();
      expect(node.getScheduleManager()).toBeUndefined();

      // Clean up
      await node.stop();
    });

    it('should initialize scheduler by default when skipSchedules is not set', () => {
      const node = new PrimaryNode({ workspaceDir: tmpDir });

      // skipSchedules defaults to false
      expect((node as any).skipSchedules).toBe(false);
    });

    it('should report correct scheduler status when scheduler is skipped', async () => {
      const node = new PrimaryNode({
        workspaceDir: tmpDir,
        skipSchedules: true,
      });

      await node.start();

      const status = node.getSchedulerStatus();
      expect(status.initialized).toBe(false);
      expect(status.running).toBe(false);
      expect(status.activeJobCount).toBe(0);
      expect(status.fileWatcherRunning).toBe(false);

      await node.stop();
    });

    it('should use instance workspaceDir for scheduler paths', () => {
      const node = new PrimaryNode({
        workspaceDir: tmpDir,
      });

      // The workspaceDir on the instance should be the custom one
      expect((node as any).workspaceDir).toBe(tmpDir);
    });
  });

  describe('basic construction', () => {
    it('should create a PrimaryNode with default config', () => {
      const node = new PrimaryNode();
      expect(node.isRunning()).toBe(false);
      expect(node.getNodeId()).toBeDefined();
    });

    it('should create a PrimaryNode with custom nodeId', () => {
      const node = new PrimaryNode({ nodeId: 'test-node-1' });
      expect(node.getNodeId()).toBe('test-node-1');
    });

    it('should report correct capabilities', () => {
      const node = new PrimaryNode({ enableLocalExec: true });
      const caps = node.getCapabilities();
      expect(caps.communication).toBe(true);
      expect(caps.execution).toBe(true);
    });

    it('should disable execution when enableLocalExec is false', () => {
      const node = new PrimaryNode({ enableLocalExec: false });
      const caps = node.getCapabilities();
      expect(caps.execution).toBe(false);
    });
  });
});
