/**
 * Tests for SubagentManager (packages/worker-node/src/agents/subagent-manager.ts)
 *
 * Tests the unified subagent spawning interface including cwd propagation.
 * Issue #1506: Verify cwd option is correctly passed through the agent creation chain.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Pilot that simulates agent execution
const { mockExecuteOnce } = vi.hoisted(() => ({
  mockExecuteOnce: vi.fn().mockResolvedValue(undefined),
}));

const { mockPilotConstructor } = vi.hoisted(() => ({
  mockPilotConstructor: vi.fn().mockImplementation(function(this: any) {
    this.executeOnce = mockExecuteOnce;
    this.dispose = vi.fn();
  }),
}));

vi.mock('./pilot/index.js', () => ({
  Pilot: mockPilotConstructor,
}));

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  Config: {
    getAgentConfig: vi.fn(() => ({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
      apiBaseUrl: 'https://api.example.com',
    })),
  },
}));

import { SubagentManager, resetSubagentManager } from './subagent-manager.js';

const createMockCallbacks = () => ({
  sendMessage: vi.fn().mockResolvedValue(undefined),
  sendCard: vi.fn().mockResolvedValue(undefined),
  sendFile: vi.fn().mockResolvedValue(undefined),
  onDone: vi.fn().mockResolvedValue(undefined),
});

describe('SubagentManager', () => {
  let manager: SubagentManager;
  let callbacks: ReturnType<typeof createMockCallbacks>;

  beforeEach(() => {
    resetSubagentManager();
    manager = new SubagentManager();
    callbacks = createMockCallbacks();
    vi.clearAllMocks();
    mockExecuteOnce.mockResolvedValue(undefined);
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('spawn with cwd option (Issue #1506)', () => {
    it('should store cwd in the handle', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-agent',
        prompt: 'test task',
        chatId: 'oc_test',
        callbacks,
        cwd: '/path/to/project',
      });

      expect(handle.cwd).toBe('/path/to/project');
    });

    it('should not set cwd when not provided', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'test-agent',
        prompt: 'test task',
        chatId: 'oc_test',
        callbacks,
      });

      expect(handle.cwd).toBeUndefined();
    });

    it('should pass cwd to Pilot when spawning task agent', async () => {
      await manager.spawn({
        type: 'task',
        name: 'test-agent',
        prompt: 'test task',
        chatId: 'oc_test',
        callbacks,
        cwd: '/custom/project',
      });

      // Pilot should have been constructed with cwd
      expect(mockPilotConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/custom/project' })
      );
    });

    it('should pass cwd to Pilot when spawning schedule agent', async () => {
      await manager.spawn({
        type: 'schedule',
        name: 'test-schedule',
        prompt: 'scheduled task',
        chatId: 'oc_test',
        callbacks,
        cwd: '/schedule/project',
      });

      expect(mockPilotConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/schedule/project' })
      );
    });

    it('should not pass cwd to Pilot when not specified', async () => {
      await manager.spawn({
        type: 'task',
        name: 'test-agent',
        prompt: 'test task',
        chatId: 'oc_test',
        callbacks,
      });

      // cwd should not be present in the Pilot config when not specified
      const [pilotConfig] = mockPilotConstructor.mock.calls[0];
      expect(pilotConfig.cwd).toBeUndefined();
    });
  });

  describe('lifecycle', () => {
    it('should list running subagents', async () => {
      // Spawn a long-running task
      mockExecuteOnce.mockImplementation(() => new Promise(() => {}));
      const handle = manager.spawn({
        type: 'task',
        name: 'long-task',
        prompt: 'long running task',
        chatId: 'oc_test',
        callbacks,
      });

      // Note: spawn is async but we don't await to test the handle
      // The handle should be created immediately
      const allHandles = manager.list();
      expect(allHandles.length).toBe(1);
    });

    it('should terminate subagents', async () => {
      const handle = await manager.spawn({
        type: 'task',
        name: 'terminable',
        prompt: 'task',
        chatId: 'oc_test',
        callbacks,
      });

      const result = manager.terminate(handle.id);
      expect(result).toBe(true);
    });

    it('should return false when terminating unknown subagent', () => {
      const result = manager.terminate('unknown-id');
      expect(result).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('should clean up completed subagents', async () => {
      await manager.spawn({
        type: 'task',
        name: 'completed-task',
        prompt: 'task',
        chatId: 'oc_test',
        callbacks,
      });

      // Force completion time to be in the past
      const handles = manager.list();
      for (const h of handles) {
        (h as any).completedAt = new Date(Date.now() - 7200000); // 2 hours ago
      }

      manager.cleanup(3600000); // 1 hour max age
      expect(manager.list().length).toBe(0);
    });
  });
});
