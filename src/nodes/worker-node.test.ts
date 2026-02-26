/**
 * Tests for Worker Node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerNode } from './worker-node.js';
import type { WorkerNodeConfig } from './types.js';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  Config: {
    getWorkspaceDir: () => '/tmp/test-workspace',
    getAgentConfig: () => ({ model: 'test-model' }),
  },
}));

vi.mock('../agents/index.js', () => ({
  AgentFactory: {
    createPilot: vi.fn(() => ({
      processMessage: vi.fn(),
      reset: vi.fn(),
    })),
  },
}));

vi.mock('../schedule/index.js', () => ({
  ScheduleManager: vi.fn(() => ({
    addTask: vi.fn(),
    removeTask: vi.fn(),
  })),
  Scheduler: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
  })),
  ScheduleFileWatcher: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../feishu/task-flow-orchestrator.js', () => ({
  TaskFlowOrchestrator: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
}));

vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn(),
}));

vi.mock('../transport/file-client.js', () => ({
  FileClient: vi.fn(() => ({
    uploadFile: vi.fn(),
    downloadToFile: vi.fn(),
  })),
}));

describe('WorkerNode', () => {
  let workerNode: WorkerNode;
  let config: WorkerNodeConfig;

  beforeEach(() => {
    config = {
      type: 'worker',
      primaryUrl: 'ws://localhost:3001',
      nodeId: 'test-worker-id',
      nodeName: 'Test Worker',
      reconnectInterval: 3000,
    };
  });

  afterEach(async () => {
    if (workerNode) {
      await workerNode.stop();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create WorkerNode with config', () => {
      workerNode = new WorkerNode(config);
      expect(workerNode).toBeDefined();
      expect(workerNode.getNodeId()).toBe('test-worker-id');
      expect(workerNode.getNodeName()).toBe('Test Worker');
    });

    it('should auto-generate nodeId if not provided', () => {
      config.nodeId = undefined;
      workerNode = new WorkerNode(config);
      expect(workerNode.getNodeId()).toBeDefined();
      expect(workerNode.getNodeId()).toMatch(/^worker-/);
    });
  });

  describe('getCapabilities', () => {
    it('should return communication: false', () => {
      workerNode = new WorkerNode(config);
      const capabilities = workerNode.getCapabilities();
      expect(capabilities.communication).toBe(false);
    });

    it('should return execution: true', () => {
      workerNode = new WorkerNode(config);
      const capabilities = workerNode.getCapabilities();
      expect(capabilities.execution).toBe(true);
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      workerNode = new WorkerNode(config);
      expect(workerNode.isRunning()).toBe(false);
    });
  });
});
