/**
 * Tests for PrimaryNode - Main entry point for the primary node.
 *
 * Issue #1617 Phase 4: Tests for primary-node.ts
 * Covers: constructor, capabilities, channel management, IPC server lifecycle,
 * scheduler initialization (including non-fatal failure), start/stop lifecycle,
 * InputMessageRouter initialization, and scheduler status reporting.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock @disclaude/core before importing PrimaryNode
const mockIpcServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getSocketPath: vi.fn().mockReturnValue('/tmp/test-socket.sock'),
};

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  UnixSocketIpcServer: vi.fn().mockImplementation(() => mockIpcServer),
  createInteractiveMessageHandler: vi.fn().mockReturnValue(() => {}),
  generateSocketPath: vi.fn().mockReturnValue('/tmp/test-socket.sock'),
  Scheduler: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    getActiveJobs: vi.fn().mockReturnValue([]),
    isRunning: vi.fn().mockReturnValue(true),
  })),
  ScheduleManager: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    listByChatId: vi.fn(),
    listEnabled: vi.fn(),
    listAll: vi.fn(),
  })),
  ScheduleFileWatcher: vi.fn().mockImplementation(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    isRunning: vi.fn().mockReturnValue(true),
  })),
  CooldownManager: vi.fn().mockImplementation(() => ({
    isInCooldown: vi.fn(),
    recordExecution: vi.fn(),
    clearCooldown: vi.fn(),
  })),
  Config: {
    getWorkspaceDir: vi.fn().mockReturnValue('/tmp/test-workspace'),
  },
  createScheduleExecutor: vi.fn().mockReturnValue(vi.fn()),
  MessageRouter: vi.fn().mockImplementation(() => ({
    route: vi.fn(),
  })),
}));

// Mock local modules
vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn().mockReturnValue({
      processMessage: vi.fn(),
      dispose: vi.fn(),
    }),
  },
  toChatAgentCallbacks: vi.fn().mockReturnValue({
    sendMessage: vi.fn(),
    sendCard: vi.fn(),
    sendFile: vi.fn(),
    onDone: vi.fn(),
  }),
}));

vi.mock('./routers/card-action-router.js', () => ({
  CardActionRouter: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}));

vi.mock('./services/debug-group-service.js', () => ({
  DebugGroupService: vi.fn(),
  getDebugGroupService: vi.fn().mockReturnValue({
    sendDebugMessage: vi.fn(),
  }),
}));

vi.mock('./channel-manager.js', () => ({
  ChannelManager: vi.fn().mockImplementation(() => {
    const channels = new Map();
    return {
      register: vi.fn((ch) => channels.set(ch.id, ch)),
      unregister: vi.fn((id) => channels.delete(id)),
      get: vi.fn((id) => channels.get(id)),
      getAll: vi.fn(() => Array.from(channels.values())),
      getFirstChannel: vi.fn(() => channels.values().next().value),
      getIds: vi.fn(() => Array.from(channels.keys())),
      has: vi.fn((id) => channels.has(id)),
      size: vi.fn(() => channels.size),
      broadcast: vi.fn(),
      startAll: vi.fn(),
      stopAll: vi.fn(),
      getStatusInfo: vi.fn(),
      clear: vi.fn(),
    };
  }),
}));

vi.mock('./interactive-context.js', () => ({
  InteractiveContextStore: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
    getActionPrompts: vi.fn(),
    unregister: vi.fn(),
    cleanupExpired: vi.fn(),
    clear: vi.fn(),
    size: 0,
  })),
}));

vi.mock('./messaging/agent-pool-handler.js', () => ({
  AgentPoolMessageHandler: vi.fn().mockImplementation(() => ({
    handle: vi.fn(),
  })),
}));

import { PrimaryNode } from './primary-node.js';
import {
  UnixSocketIpcServer,
  Scheduler,
  ScheduleManager,
  ScheduleFileWatcher,
  CooldownManager,
  Config,
  createScheduleExecutor,
} from '@disclaude/core';

describe('PrimaryNode', () => {
  let node: PrimaryNode;

  beforeEach(() => {
    vi.clearAllMocks();
    node = new PrimaryNode();
  });

  afterEach(async () => {
    if (node.isRunning()) {
      await node.stop();
    }
  });

  // =========================================================================
  // Constructor
  // =========================================================================

  describe('constructor', () => {
    it('should apply default options when no config provided', () => {
      const defaultNode = new PrimaryNode();
      expect(defaultNode.getNodeId()).toMatch(/^primary-\d+-[a-z0-9]+$/);
      expect(defaultNode.isRunning()).toBe(false);
      expect(defaultNode.getCapabilities()).toEqual({
        communication: true,
        execution: true,
      });
    });

    it('should apply custom options', () => {
      const customNode = new PrimaryNode({
        nodeId: 'custom-node-1',
        port: 4000,
        host: '127.0.0.1',
        enableLocalExec: false,
      });
      expect(customNode.getNodeId()).toBe('custom-node-1');
      expect(customNode.getCapabilities()).toEqual({
        communication: true,
        execution: false,
      });
    });

    it('should enable local execution by default', () => {
      const nodeNoExec = new PrimaryNode({});
      expect(nodeNoExec.getCapabilities().execution).toBe(true);
    });

    it('should initialize internal services', () => {
      expect(node.getCardActionRouter()).toBeDefined();
      expect(node.getDebugGroupService()).toBeDefined();
      expect(node.getInteractiveContextStore()).toBeDefined();
      expect(node.getChannelManager()).toBeDefined();
    });
  });

  // =========================================================================
  // getCapabilities
  // =========================================================================

  describe('getCapabilities', () => {
    it('should return communication: true always', () => {
      const nodeWithExec = new PrimaryNode({ enableLocalExec: true });
      const nodeWithoutExec = new PrimaryNode({ enableLocalExec: false });
      expect(nodeWithExec.getCapabilities().communication).toBe(true);
      expect(nodeWithoutExec.getCapabilities().communication).toBe(true);
    });

    it('should reflect enableLocalExec setting', () => {
      const nodeWithExec = new PrimaryNode({ enableLocalExec: true });
      const nodeWithoutExec = new PrimaryNode({ enableLocalExec: false });
      expect(nodeWithExec.getCapabilities().execution).toBe(true);
      expect(nodeWithoutExec.getCapabilities().execution).toBe(false);
    });
  });

  // =========================================================================
  // isRunning / getNodeId
  // =========================================================================

  describe('isRunning', () => {
    it('should return false before start', () => {
      expect(node.isRunning()).toBe(false);
    });

    it('should return true after start', async () => {
      await node.start();
      expect(node.isRunning()).toBe(true);
    });

    it('should return false after stop', async () => {
      await node.start();
      await node.stop();
      expect(node.isRunning()).toBe(false);
    });
  });

  describe('getNodeId', () => {
    it('should return the configured node ID', () => {
      const customNode = new PrimaryNode({ nodeId: 'my-node' });
      expect(customNode.getNodeId()).toBe('my-node');
    });

    it('should generate a unique ID when not configured', () => {
      const nodeA = new PrimaryNode();
      const nodeB = new PrimaryNode();
      expect(nodeA.getNodeId()).not.toBe(nodeB.getNodeId());
    });
  });

  // =========================================================================
  // Channel management
  // =========================================================================

  describe('registerChannel / unregisterChannel', () => {
    const mockChannel = {
      id: 'test-channel',
      name: 'Test Channel',
      status: 'stopped',
      start: vi.fn(),
      stop: vi.fn(),
      sendMessage: vi.fn(),
      onMessage: vi.fn(),
      onControl: vi.fn(),
    };

    beforeEach(() => {
      vi.clearAllMocks();
    });

    it('should register a channel', () => {
      node.registerChannel(mockChannel);
      expect(node.getChannels()).toHaveLength(1);
      expect(node.getChannel('test-channel')).toBe(mockChannel);
    });

    it('should unregister a channel by ID', () => {
      node.registerChannel(mockChannel);
      const result = node.unregisterChannel('test-channel');
      expect(result).toBe(true);
      expect(node.getChannels()).toHaveLength(0);
    });

    it('should return false when unregistering non-existent channel', () => {
      const result = node.unregisterChannel('non-existent');
      expect(result).toBe(false);
    });

    it('should return undefined for non-existent channel', () => {
      expect(node.getChannel('non-existent')).toBeUndefined();
    });
  });

  // =========================================================================
  // registerFeishuHandlers
  // =========================================================================

  describe('registerFeishuHandlers', () => {
    it('should accept Feishu API handlers without error', () => {
      const handlers = {
        sendText: vi.fn(),
        sendCard: vi.fn(),
        sendFile: vi.fn(),
      };
      expect(() => node.registerFeishuHandlers(handlers)).not.toThrow();
    });
  });

  // =========================================================================
  // Start / Stop lifecycle
  // =========================================================================

  describe('start', () => {
    it('should start IPC server and scheduler', async () => {
      await node.start();

      expect(UnixSocketIpcServer).toHaveBeenCalled();
      expect(mockIpcServer.start).toHaveBeenCalled();
      expect(Scheduler).toHaveBeenCalled();
      expect(node.isRunning()).toBe(true);
    });

    it('should emit "started" event', async () => {
      const startedSpy = vi.fn();
      node.on('started', startedSpy);
      await node.start();
      expect(startedSpy).toHaveBeenCalledOnce();
    });

    it('should not start again if already running', async () => {
      await node.start();
      const callCount = mockIpcServer.start.mock.calls.length;
      await node.start(); // second start should be no-op
      expect(mockIpcServer.start.mock.calls.length).toBe(callCount);
    });

    it('should continue starting even if scheduler init fails (Issue #3361)', async () => {
      // Make scheduler throw during initialization
      vi.mocked(Scheduler).mockImplementationOnce(() => {
        throw new Error('Scheduler initialization failed');
      });

      await node.start();
      expect(node.isRunning()).toBe(true);
    });
  });

  describe('stop', () => {
    it('should stop IPC server and scheduler', async () => {
      await node.start();
      await node.stop();

      expect(mockIpcServer.stop).toHaveBeenCalled();
      expect(node.isRunning()).toBe(false);
    });

    it('should emit "stopped" event', async () => {
      await node.start();
      const stoppedSpy = vi.fn();
      node.on('stopped', stoppedSpy);
      await node.stop();
      expect(stoppedSpy).toHaveBeenCalledOnce();
    });

    it('should be a no-op if not running', async () => {
      await node.stop(); // should not throw
      expect(node.isRunning()).toBe(false);
    });

    it('should clear DISCLAUDE_WORKER_IPC_SOCKET env var on stop', async () => {
      await node.start();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeDefined();
      await node.stop();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
    });
  });

  // =========================================================================
  // Scheduler initialization
  // =========================================================================

  describe('initScheduler', () => {
    it('should initialize all scheduler components in order', async () => {
      await node.start();

      expect(CooldownManager).toHaveBeenCalled();
      expect(ScheduleManager).toHaveBeenCalled();
      expect(createScheduleExecutor).toHaveBeenCalled();
      expect(Scheduler).toHaveBeenCalled();
      expect(ScheduleFileWatcher).toHaveBeenCalled();
    });

    it('should use Config.getWorkspaceDir for schedules directory', async () => {
      await node.start();

      expect(Config.getWorkspaceDir).toHaveBeenCalled();
    });

    it('should create scheduler with correct dependencies', async () => {
      await node.start();

      // Scheduler should receive scheduleManager, cooldownManager, callbacks, executor
      const schedulerCalls = vi.mocked(Scheduler).mock.calls;
      expect(schedulerCalls.length).toBeGreaterThanOrEqual(1);
      const [lastCall] = schedulerCalls[schedulerCalls.length - 1];
      expect(lastCall).toHaveProperty('scheduleManager');
      expect(lastCall).toHaveProperty('cooldownManager');
      expect(lastCall).toHaveProperty('callbacks');
      expect(lastCall).toHaveProperty('executor');
    });
  });

  describe('stopScheduler', () => {
    it('should stop file watcher and scheduler', async () => {
      await node.start();
      const mockScheduler = vi.mocked(Scheduler).mock.results[0]?.value;
      const mockWatcher = vi.mocked(ScheduleFileWatcher).mock.results[0]?.value;

      await node.stop();

      if (mockWatcher) {
        expect(mockWatcher.stop).toHaveBeenCalled();
      }
      if (mockScheduler) {
        expect(mockScheduler.stop).toHaveBeenCalled();
      }
    });
  });

  // =========================================================================
  // getSchedulerStatus
  // =========================================================================

  describe('getSchedulerStatus', () => {
    it('should return not-initialized status before start', () => {
      const status = node.getSchedulerStatus();
      expect(status).toEqual({
        initialized: false,
        running: false,
        activeJobCount: 0,
        activeJobs: [],
        fileWatcherRunning: false,
      });
    });

    it('should return initialized status after start', async () => {
      await node.start();
      const status = node.getSchedulerStatus();
      expect(status.initialized).toBe(true);
      expect(status.running).toBe(true);
      expect(status.fileWatcherRunning).toBe(true);
      expect(status.activeJobCount).toBe(0);
    });

    it('should reflect active jobs from scheduler', async () => {
      const mockActiveJobs = [
        { taskId: 'task-1', task: { cron: '0 * * * *', name: 'Hourly task' } },
        { taskId: 'task-2', task: { cron: '0 0 * * *', name: 'Daily task' } },
      ];

      vi.mocked(Scheduler).mockImplementationOnce(() => ({
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        addTask: vi.fn(),
        removeTask: vi.fn(),
        getActiveJobs: vi.fn().mockReturnValue(mockActiveJobs),
        isRunning: vi.fn().mockReturnValue(true),
      }) as any);

      const nodeWithJobs = new PrimaryNode();
      await nodeWithJobs.start();
      const status = nodeWithJobs.getSchedulerStatus();

      expect(status.activeJobCount).toBe(2);
      expect(status.activeJobs).toEqual([
        { taskId: 'task-1', cron: '0 * * * *', name: 'Hourly task' },
        { taskId: 'task-2', cron: '0 0 * * *', name: 'Daily task' },
      ]);

      await nodeWithJobs.stop();
    });
  });

  // =========================================================================
  // getScheduler / getScheduleManager / getInputMessageRouter
  // =========================================================================

  describe('getScheduler', () => {
    it('should return undefined before start', () => {
      expect(node.getScheduler()).toBeUndefined();
    });

    it('should return scheduler instance after start', async () => {
      await node.start();
      expect(node.getScheduler()).toBeDefined();
    });
  });

  describe('getScheduleManager', () => {
    it('should return undefined before start', () => {
      expect(node.getScheduleManager()).toBeUndefined();
    });

    it('should return schedule manager after start', async () => {
      await node.start();
      expect(node.getScheduleManager()).toBeDefined();
    });
  });

  describe('getInputMessageRouter', () => {
    it('should return undefined before initInputMessageRouter', () => {
      expect(node.getInputMessageRouter()).toBeUndefined();
    });
  });

  // =========================================================================
  // initInputMessageRouter
  // =========================================================================

  describe('initInputMessageRouter', () => {
    it('should create InputMessageRouter with handler', () => {
      const mockAgentPool = {
        getOrCreateChatAgent: vi.fn(),
      };
      const mockCallbacksFactory = vi.fn().mockReturnValue({
        sendMessage: vi.fn(),
        sendCard: vi.fn(),
        sendFile: vi.fn(),
        onDone: vi.fn(),
      });

      node.initInputMessageRouter(mockAgentPool, mockCallbacksFactory);

      expect(node.getInputMessageRouter()).toBeDefined();
    });

    it('should create InputMessageRouter with systemExecutor when provided', () => {
      const mockAgentPool = {
        getOrCreateChatAgent: vi.fn(),
      };
      const mockCallbacksFactory = vi.fn().mockReturnValue({
        sendMessage: vi.fn(),
        sendCard: vi.fn(),
        sendFile: vi.fn(),
        onDone: vi.fn(),
      });
      const mockSystemExecutor = vi.fn();

      node.initInputMessageRouter(mockAgentPool, mockCallbacksFactory, mockSystemExecutor);

      expect(node.getInputMessageRouter()).toBeDefined();
    });
  });

  // =========================================================================
  // IPC Server
  // =========================================================================

  describe('IPC server', () => {
    it('should set DISCLAUDE_WORKER_IPC_SOCKET env var on start', async () => {
      delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
      await node.start();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBe('/tmp/test-socket.sock');
    });

    it('should clean up env var on stop', async () => {
      await node.start();
      await node.stop();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
    });
  });

  // =========================================================================
  // Event emitter
  // =========================================================================

  describe('event emitter', () => {
    it('should be an EventEmitter', () => {
      expect(typeof node.on).toBe('function');
      expect(typeof node.emit).toBe('function');
    });
  });
});
