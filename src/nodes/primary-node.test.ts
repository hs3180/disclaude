/**
 * Tests for Primary Node.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrimaryNode } from './primary-node.js';
import type { PrimaryNodeConfig } from './types.js';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getWorkspaceDir: () => '/tmp/test-workspace',
    getAgentConfig: () => ({ model: 'test-model' }),
    getChannelsConfig: () => ({ rest: { port: 3000, enabled: true } }),
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

vi.mock('../channels/feishu-channel.js', () => ({
  FeishuChannel: vi.fn(() => ({
    id: 'feishu',
    name: 'Feishu',
    status: 'running',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    onControl: vi.fn(),
    initTaskFlowOrchestrator: vi.fn(),
    setWelcomeService: vi.fn(),
  })),
}));

vi.mock('../channels/rest-channel.js', () => ({
  RestChannel: vi.fn(() => ({
    id: 'rest',
    name: 'REST',
    status: 'running',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    onControl: vi.fn(),
  })),
}));

vi.mock('../services/file-storage-service.js', () => ({
  FileStorageService: vi.fn(),
}));

vi.mock('../services/file-transfer-api.js', () => ({
  createFileTransferAPIHandler: vi.fn(),
}));

describe('PrimaryNode', () => {
  let primaryNode: PrimaryNode;
  let config: PrimaryNodeConfig;

  beforeEach(() => {
    config = {
      type: 'primary',
      port: 3001,
      host: '0.0.0.0',
      enableLocalExec: true,
      enableRestChannel: false, // Disable REST for tests
    };
  });

  afterEach(async () => {
    if (primaryNode) {
      await primaryNode.stop();
    }
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('should create PrimaryNode with default config', () => {
      primaryNode = new PrimaryNode(config);
      expect(primaryNode).toBeDefined();
      expect(primaryNode.getNodeId()).toBeDefined();
    });

    it('should create PrimaryNode with custom nodeId', () => {
      config.nodeId = 'custom-primary-id';
      primaryNode = new PrimaryNode(config);
      expect(primaryNode.getNodeId()).toBe('custom-primary-id');
    });

    it('should have correct capabilities with local exec enabled', () => {
      primaryNode = new PrimaryNode(config);
      const capabilities = primaryNode.getCapabilities();
      expect(capabilities.communication).toBe(true);
      expect(capabilities.execution).toBe(true);
    });
  });

  describe('getCapabilities', () => {
    it('should return communication: true by default', () => {
      primaryNode = new PrimaryNode(config);
      const capabilities = primaryNode.getCapabilities();
      expect(capabilities.communication).toBe(true);
    });

    it('should return execution: true when local exec is enabled', () => {
      config.enableLocalExec = true;
      primaryNode = new PrimaryNode(config);
      const capabilities = primaryNode.getCapabilities();
      expect(capabilities.execution).toBe(true);
    });
  });

  describe('getExecNodes', () => {
    it('should return empty array before start', () => {
      config.enableLocalExec = true;
      primaryNode = new PrimaryNode(config);
      // Local exec node is registered during start()
      const nodes = primaryNode.getExecNodes();
      expect(nodes.length).toBe(0);
    });

    it('should not include local execution node when disabled', () => {
      config.enableLocalExec = false;
      primaryNode = new PrimaryNode(config);
      const nodes = primaryNode.getExecNodes();
      expect(nodes.length).toBe(0);
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      primaryNode = new PrimaryNode(config);
      expect(primaryNode.isRunning()).toBe(false);
    });
  });
});
