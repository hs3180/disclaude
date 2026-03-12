/**
 * Tests for Worker Node.
 *
 * Issue #1041: Tests use dependency injection to provide mock dependencies.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkerNode, type WorkerNodeOptions } from '@disclaude/worker-node';
import type { WorkerNodeConfig } from './types.js';
import { createLogger } from '../utils/logger.js';
import type { ChatAgent, PilotCallbacks, TaskFlowOrchestratorInterface, MessageCallbacks } from '@disclaude/worker-node';
import type { Logger } from 'pino';

const logger = createLogger('test-worker');

// Mock dependencies
const mockChatAgent: ChatAgent = {
  type: 'chat',
  name: 'MockChatAgent',
  processMessage: vi.fn(),
  executeOnce: vi.fn(),
  reset: vi.fn(),
  dispose: vi.fn(),
};

const mockDependencies = {
  getWorkspaceDir: () => '/tmp/test-workspace',
  createChatAgent: vi.fn((_chatId: string, _callbacks: PilotCallbacks) => mockChatAgent),
  createScheduleAgent: vi.fn((_chatId: string, _callbacks: PilotCallbacks) => ({ ...mockChatAgent })),
  createTaskFlowOrchestrator: vi.fn((_callbacks: MessageCallbacks, _logger: Logger): TaskFlowOrchestratorInterface => ({
    start: vi.fn(),
    stop: vi.fn(),
  })),
  generateInteractionPrompt: vi.fn(() => 'Mock prompt'),
  logger,
};

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
      workerNode.stop();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create WorkerNode with config', () => {
      const options: WorkerNodeOptions = {
        config,
        dependencies: mockDependencies,
      };
      workerNode = new WorkerNode(options);
      expect(workerNode).toBeDefined();
      expect(workerNode.getNodeId()).toBe('test-worker-id');
      expect(workerNode.getNodeName()).toBe('Test Worker');
    });

    it('should auto-generate nodeId if not provided', () => {
      config.nodeId = undefined;
      const options: WorkerNodeOptions = {
        config,
        dependencies: mockDependencies,
      };
      workerNode = new WorkerNode(options);
      expect(workerNode.getNodeId()).toBeDefined();
      expect(workerNode.getNodeId()).toMatch(/^worker-/);
    });
  });

  describe('getCapabilities', () => {
    it('should return communication: false', () => {
      const options: WorkerNodeOptions = {
        config,
        dependencies: mockDependencies,
      };
      workerNode = new WorkerNode(options);
      const capabilities = workerNode.getCapabilities();
      expect(capabilities.communication).toBe(false);
    });

    it('should return execution: true', () => {
      const options: WorkerNodeOptions = {
        config,
        dependencies: mockDependencies,
      };
      workerNode = new WorkerNode(options);
      const capabilities = workerNode.getCapabilities();
      expect(capabilities.execution).toBe(true);
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      const options: WorkerNodeOptions = {
        config,
        dependencies: mockDependencies,
      };
      workerNode = new WorkerNode(options);
      expect(workerNode.isRunning()).toBe(false);
    });
  });
});
