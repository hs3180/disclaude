/**
 * Tests for PrimaryNode (packages/primary-node/src/primary-node.ts)
 *
 * Issue #1617 Phase 4: Unit tests for the central orchestration class.
 *
 * Tests cover:
 * 1. Constructor — service initialization and config defaults
 * 2. Getters — capabilities, nodeId, running state, service accessors
 * 3. start() / stop() — lifecycle management
 * 4. initScheduler() — scheduler wiring with all 5 steps
 * 5. getSchedulerStatus() — health monitoring
 * 6. IPC server — start/stop and env variable management
 * 7. Channel delegation — register/unregister/get
 * 8. registerFeishuHandlers() — Feishu API handler registration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks
// ============================================================================

const mockIpcServer = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  getSocketPath: vi.fn().mockReturnValue('/tmp/test-socket.sock'),
};

const mockScheduler = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  getActiveJobs: vi.fn().mockReturnValue([]),
  isRunning: vi.fn().mockReturnValue(true),
};

const mockScheduleManager = {
  // ScheduleManager methods (not directly called in tests, but constructed)
};

const mockScheduleFileWatcher = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(),
  isRunning: vi.fn().mockReturnValue(true),
};

const mockCooldownManager = {
  // CooldownManager methods
};

const mockChatStore = {
  // ChatStore methods
};

vi.mock('@disclaude/core', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    level: 'info',
  }),
  Config: {
    getWorkspaceDir: vi.fn().mockReturnValue('/workspace'),
    getAgentConfig: vi.fn().mockReturnValue({
      apiKey: 'test-key',
      model: 'test-model',
      provider: 'anthropic',
    }),
  },
  UnixSocketIpcServer: vi.fn().mockImplementation(() => mockIpcServer),
  createInteractiveMessageHandler: vi.fn().mockReturnValue('mock-handler'),
  generateSocketPath: vi.fn().mockReturnValue('/tmp/test-socket.sock'),
  Scheduler: vi.fn().mockImplementation(() => mockScheduler),
  ScheduleManager: vi.fn().mockImplementation(() => mockScheduleManager),
  ScheduleFileWatcher: vi.fn().mockImplementation(() => mockScheduleFileWatcher),
  CooldownManager: vi.fn().mockImplementation(() => mockCooldownManager),
  ChatStore: vi.fn().mockImplementation(() => mockChatStore),
  createScheduleExecutor: vi.fn().mockReturnValue('mock-executor'),
}));

vi.mock('./agents/factory.js', () => ({
  AgentFactory: {
    createAgent: vi.fn().mockReturnValue({ dispose: vi.fn() }),
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
    register: vi.fn(),
    unregister: vi.fn(),
  })),
}));

vi.mock('./services/debug-group-service.js', () => ({
  DebugGroupService: vi.fn().mockImplementation(() => ({
    setDebugGroup: vi.fn(),
  })),
  getDebugGroupService: vi.fn().mockReturnValue({
    setDebugGroup: vi.fn(),
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
    };
  }),
}));

vi.mock('./interactive-context.js', () => ({
  InteractiveContextStore: vi.fn().mockImplementation(() => ({
    register: vi.fn(),
  })),
}));

// Import after mocks
import { PrimaryNode } from './primary-node.js';
import { Config, Scheduler, ScheduleManager, ScheduleFileWatcher, CooldownManager, ChatStore, UnixSocketIpcServer, createScheduleExecutor, createInteractiveMessageHandler, type IChannel } from '@disclaude/core';
import { AgentFactory, toChatAgentCallbacks } from './agents/factory.js';

// ============================================================================
// Helpers
// ============================================================================

/** Create a mock channel for testing */
function createMockChannel(id = 'test-channel'): IChannel {
  return {
    id,
    name: `Channel-${id}`,
    status: 'stopped',
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onControl: vi.fn(),
  } as unknown as IChannel;
}

// ============================================================================
// Tests
// ============================================================================

describe('PrimaryNode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset env
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
  });

  afterEach(() => {
    delete process.env.DISCLAUDE_WORKER_IPC_SOCKET;
  });

  // ==========================================================================
  // Constructor
  // ==========================================================================

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const node = new PrimaryNode();

      expect(node.getNodeId()).toMatch(/^primary-\d+-[a-z0-9]+$/);
      expect(node.isRunning()).toBe(false);
      expect(node.getCapabilities()).toEqual({
        communication: true,
        execution: true,
      });
    });

    it('should use custom nodeId when provided', () => {
      const node = new PrimaryNode({ nodeId: 'custom-node-1' });
      expect(node.getNodeId()).toBe('custom-node-1');
    });

    it('should use custom port when provided', () => {
      const node = new PrimaryNode({ port: 8080 });
      // Port is stored internally; verify it doesn't throw
      expect(node).toBeDefined();
    });

    it('should use custom host when provided', () => {
      const node = new PrimaryNode({ host: '127.0.0.1' });
      expect(node).toBeDefined();
    });

    it('should set localExecEnabled to true by default', () => {
      const node = new PrimaryNode();
      expect(node.getCapabilities().execution).toBe(true);
    });

    it('should disable local execution when enableLocalExec is false', () => {
      const node = new PrimaryNode({ enableLocalExec: false });
      expect(node.getCapabilities().execution).toBe(false);
    });

    it('should create CardActionRouter instance', () => {
      const node = new PrimaryNode();
      expect(node.getCardActionRouter()).toBeDefined();
    });

    it('should create DebugGroupService instance', () => {
      const node = new PrimaryNode();
      expect(node.getDebugGroupService()).toBeDefined();
    });

    it('should create ChannelManager instance', () => {
      const node = new PrimaryNode();
      expect(node.getChannelManager()).toBeDefined();
    });

    it('should create InteractiveContextStore instance', () => {
      const node = new PrimaryNode();
      expect(node.getInteractiveContextStore()).toBeDefined();
    });

    it('should create ChatStore with workspace-based path', () => {
      vi.mocked(Config.getWorkspaceDir).mockReturnValue('/custom/workspace');
      new PrimaryNode();

      expect(ChatStore).toHaveBeenCalledWith({
        storeDir: expect.stringContaining('/custom/workspace/schedules/.temp-chats'),
      });
    });

    it('should generate unique node IDs for different instances', () => {
      const node1 = new PrimaryNode();
      const node2 = new PrimaryNode();
      expect(node1.getNodeId()).not.toBe(node2.getNodeId());
    });
  });

  // ==========================================================================
  // Getters
  // ==========================================================================

  describe('getCapabilities', () => {
    it('should return communication: true always', () => {
      const node = new PrimaryNode();
      expect(node.getCapabilities().communication).toBe(true);
    });

    it('should reflect localExecEnabled setting', () => {
      const enabled = new PrimaryNode({ enableLocalExec: true });
      const disabled = new PrimaryNode({ enableLocalExec: false });
      expect(enabled.getCapabilities().execution).toBe(true);
      expect(disabled.getCapabilities().execution).toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should return false before start', () => {
      const node = new PrimaryNode();
      expect(node.isRunning()).toBe(false);
    });
  });

  describe('getChatStore', () => {
    it('should return the ChatStore instance', () => {
      const node = new PrimaryNode();
      expect(node.getChatStore()).toBeDefined();
    });
  });

  // ==========================================================================
  // Channel delegation
  // ==========================================================================

  describe('registerChannel', () => {
    it('should delegate to ChannelManager.register', () => {
      const node = new PrimaryNode();
      const channel = createMockChannel('ch-1');
      node.registerChannel(channel);

      expect(node.getChannelManager().register).toHaveBeenCalledWith(channel);
    });
  });

  describe('unregisterChannel', () => {
    it('should delegate to ChannelManager.unregister', () => {
      const node = new PrimaryNode();
      const channel = createMockChannel('ch-1');
      node.registerChannel(channel);
      node.unregisterChannel('ch-1');

      expect(node.getChannelManager().unregister).toHaveBeenCalledWith('ch-1');
    });
  });

  describe('getChannels', () => {
    it('should return empty array when no channels registered', () => {
      const node = new PrimaryNode();
      expect(node.getChannels()).toEqual([]);
    });

    it('should return registered channels', () => {
      const node = new PrimaryNode();
      const ch1 = createMockChannel('ch-1');
      const ch2 = createMockChannel('ch-2');
      node.registerChannel(ch1);
      node.registerChannel(ch2);

      const channels = node.getChannels();
      expect(channels).toHaveLength(2);
    });
  });

  describe('getChannel', () => {
    it('should return undefined for unknown channel', () => {
      const node = new PrimaryNode();
      expect(node.getChannel('unknown')).toBeUndefined();
    });

    it('should return registered channel by ID', () => {
      const node = new PrimaryNode();
      const channel = createMockChannel('ch-1');
      node.registerChannel(channel);

      expect(node.getChannel('ch-1')).toBeDefined();
    });
  });

  // ==========================================================================
  // Lifecycle: start() / stop()
  // ==========================================================================

  describe('start()', () => {
    it('should set running to true', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(node.isRunning()).toBe(true);
    });

    it('should emit "started" event', async () => {
      const node = new PrimaryNode();
      const startedSpy = vi.fn();
      node.on('started', startedSpy);
      await node.start();
      expect(startedSpy).toHaveBeenCalledOnce();
    });

    it('should start IPC server', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(UnixSocketIpcServer).toHaveBeenCalled();
      expect(mockIpcServer.start).toHaveBeenCalled();
    });

    it('should initialize scheduler', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(Scheduler).toHaveBeenCalled();
      expect(mockScheduler.start).toHaveBeenCalled();
    });

    it('should start file watcher', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(ScheduleFileWatcher).toHaveBeenCalled();
      expect(mockScheduleFileWatcher.start).toHaveBeenCalled();
    });

    it('should continue if scheduler initialization fails (Issue #3361)', async () => {
      mockScheduler.start.mockRejectedValueOnce(new Error('Scheduler failed'));
      const node = new PrimaryNode();
      await node.start();
      // PrimaryNode should still be running even if scheduler fails
      expect(node.isRunning()).toBe(true);
    });

    it('should not start again if already running', async () => {
      const node = new PrimaryNode();
      await node.start();
      const callCount = (UnixSocketIpcServer as unknown as vi.Mock).mock.calls.length;
      await node.start();
      // IPC server should not be created again
      expect((UnixSocketIpcServer as unknown as vi.Mock).mock.calls.length).toBe(callCount);
    });
  });

  describe('stop()', () => {
    it('should set running to false', async () => {
      const node = new PrimaryNode();
      await node.start();
      await node.stop();
      expect(node.isRunning()).toBe(false);
    });

    it('should emit "stopped" event', async () => {
      const node = new PrimaryNode();
      await node.start();
      const stoppedSpy = vi.fn();
      node.on('stopped', stoppedSpy);
      await node.stop();
      expect(stoppedSpy).toHaveBeenCalledOnce();
    });

    it('should stop scheduler and file watcher', async () => {
      const node = new PrimaryNode();
      await node.start();
      await node.stop();
      expect(mockScheduleFileWatcher.stop).toHaveBeenCalled();
      expect(mockScheduler.stop).toHaveBeenCalled();
    });

    it('should stop IPC server and clear env variable', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBe('/tmp/test-socket.sock');
      await node.stop();
      expect(mockIpcServer.stop).toHaveBeenCalled();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
    });

    it('should not stop if not running', async () => {
      const node = new PrimaryNode();
      await node.stop();
      // Should not throw
      expect(mockScheduler.stop).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Scheduler initialization
  // ==========================================================================

  describe('initScheduler()', () => {
    it('should create CooldownManager with correct directory', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(CooldownManager).toHaveBeenCalledWith({
        cooldownDir: expect.stringContaining('.cooldown'),
      });
    });

    it('should create ScheduleManager with schedules directory', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(ScheduleManager).toHaveBeenCalledWith({
        schedulesDir: expect.stringContaining('schedules'),
      });
    });

    it('should create schedule executor with agent factory', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(createScheduleExecutor).toHaveBeenCalledWith(
        expect.objectContaining({
          agentFactory: expect.any(Function),
          callbacks: expect.objectContaining({
            sendMessage: expect.any(Function),
          }),
        }),
      );
    });

    it('should create Scheduler with correct dependencies', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(Scheduler).toHaveBeenCalledWith(
        expect.objectContaining({
          cooldownManager: expect.any(Object),
          scheduleManager: expect.any(Object),
          callbacks: expect.objectContaining({
            sendMessage: expect.any(Function),
          }),
          executor: 'mock-executor',
        }),
      );
    });

    it('should create ScheduleFileWatcher with callbacks', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(ScheduleFileWatcher).toHaveBeenCalledWith(
        expect.objectContaining({
          schedulesDir: expect.stringContaining('schedules'),
          onFileAdded: expect.any(Function),
          onFileChanged: expect.any(Function),
          onFileRemoved: expect.any(Function),
        }),
      );
    });

    it('should wire scheduler callbacks to ChannelManager', async () => {
      const mockChannel = createMockChannel('ch-1');
      const node = new PrimaryNode();
      node.registerChannel(mockChannel);
      await node.start();

      // Extract the sendMessage callback from createScheduleExecutor
      // eslint-disable-next-line prefer-destructuring
      const executorCall = vi.mocked(createScheduleExecutor).mock.calls[0][0];
      const {sendMessage} = executorCall.callbacks;

      // Call sendMessage — should route through the channel
      await sendMessage('chat-123', 'hello');

      expect(mockChannel.sendMessage).toHaveBeenCalledWith({
        type: 'text',
        chatId: 'chat-123',
        text: 'hello',
      });
    });

    it('should handle sendMessage when no channel is available', async () => {
      const node = new PrimaryNode();
      await node.start();

      // eslint-disable-next-line prefer-destructuring
      const executorCall = vi.mocked(createScheduleExecutor).mock.calls[0][0];
      const {sendMessage} = executorCall.callbacks;

      // Should not throw when no channel available
      await expect(sendMessage('chat-123', 'hello')).resolves.toBeUndefined();
    });

    it('should wire onFileAdded callback to scheduler.addTask', async () => {
      const node = new PrimaryNode();
      await node.start();

      const watcherConfig = vi.mocked(ScheduleFileWatcher).mock.calls[0][0] as any;
      const task = { id: 'task-1', name: 'Test Task', cron: '* * * * *' };
      watcherConfig.onFileAdded(task);

      expect(mockScheduler.addTask).toHaveBeenCalledWith(task);
    });

    it('should wire onFileChanged callback to scheduler.addTask', async () => {
      const node = new PrimaryNode();
      await node.start();

      const watcherConfig = vi.mocked(ScheduleFileWatcher).mock.calls[0][0] as any;
      const task = { id: 'task-1', name: 'Test Task', cron: '* * * * *' };
      watcherConfig.onFileChanged(task);

      expect(mockScheduler.addTask).toHaveBeenCalledWith(task);
    });

    it('should wire onFileRemoved callback to scheduler.removeTask', async () => {
      const node = new PrimaryNode();
      await node.start();

      const watcherConfig = vi.mocked(ScheduleFileWatcher).mock.calls[0][0] as any;
      watcherConfig.onFileRemoved('task-1');

      expect(mockScheduler.removeTask).toHaveBeenCalledWith('task-1');
    });

    it('should use AgentFactory in executor agentFactory callback', async () => {
      const node = new PrimaryNode();
      await node.start();

      // eslint-disable-next-line prefer-destructuring
      const executorCall = vi.mocked(createScheduleExecutor).mock.calls[0][0];
      const factoryFn = executorCall.agentFactory;

      const mockCallbacks = { sendMessage: vi.fn() };
      factoryFn('chat-123', mockCallbacks, 'custom-model', 'high');

      expect(toChatAgentCallbacks).toHaveBeenCalledWith(mockCallbacks);
      expect(AgentFactory.createAgent).toHaveBeenCalledWith(
        'chat-123',
        expect.any(Object),
        { model: 'custom-model', modelTier: 'high' },
      );
    });
  });

  // ==========================================================================
  // getSchedulerStatus()
  // ==========================================================================

  describe('getSchedulerStatus()', () => {
    it('should return uninitialised status before start', () => {
      const node = new PrimaryNode();
      const status = node.getSchedulerStatus();

      expect(status).toEqual({
        initialized: false,
        running: false,
        activeJobCount: 0,
        activeJobs: [],
        fileWatcherRunning: false,
      });
    });

    it('should return initialised status after start', async () => {
      const node = new PrimaryNode();
      await node.start();
      const status = node.getSchedulerStatus();

      expect(status.initialized).toBe(true);
      expect(status.running).toBe(true);
      expect(status.activeJobCount).toBe(0);
      expect(status.fileWatcherRunning).toBe(true);
    });

    it('should reflect active jobs from scheduler', async () => {
      mockScheduler.getActiveJobs.mockReturnValue([
        { taskId: 'task-1', task: { cron: '* * * * *', name: 'Job 1' } },
        { taskId: 'task-2', task: { cron: '0 * * * *', name: 'Job 2' } },
      ]);

      const node = new PrimaryNode();
      await node.start();
      const status = node.getSchedulerStatus();

      expect(status.activeJobCount).toBe(2);
      expect(status.activeJobs).toEqual([
        { taskId: 'task-1', cron: '* * * * *', name: 'Job 1' },
        { taskId: 'task-2', cron: '0 * * * *', name: 'Job 2' },
      ]);
    });

    it('should show fileWatcherRunning false if watcher not started', async () => {
      mockScheduleFileWatcher.isRunning.mockReturnValue(false);
      const node = new PrimaryNode();
      await node.start();
      const status = node.getSchedulerStatus();

      expect(status.fileWatcherRunning).toBe(false);
    });
  });

  // ==========================================================================
  // IPC Server
  // ==========================================================================

  describe('IPC server', () => {
    it('should set DISCLAUDE_WORKER_IPC_SOCKET env on start', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBe('/tmp/test-socket.sock');
    });

    it('should clear DISCLAUDE_WORKER_IPC_SOCKET env on stop', async () => {
      const node = new PrimaryNode();
      await node.start();
      await node.stop();
      expect(process.env.DISCLAUDE_WORKER_IPC_SOCKET).toBeUndefined();
    });

    it('should create InteractiveContextStore with registerActionPrompts callback', async () => {
      const node = new PrimaryNode();
      await node.start();

      expect(createInteractiveMessageHandler).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ handlers: undefined }),
      );
    });

    it('should not create IPC server if already running', async () => {
      const node = new PrimaryNode();
      await node.start();
      const firstCallCount = (UnixSocketIpcServer as unknown as vi.Mock).mock.calls.length;
      // start() won't re-start because running is true, so call the protected method indirectly
      // by stopping and starting again
      await node.stop();
      await node.start();
      expect((UnixSocketIpcServer as unknown as vi.Mock).mock.calls.length).toBe(firstCallCount + 1);
    });
  });

  // ==========================================================================
  // registerFeishuHandlers()
  // ==========================================================================

  describe('registerFeishuHandlers()', () => {
    it('should store handlers in feishuHandlersContainer', async () => {
      const node = new PrimaryNode();
      await node.start();

      const mockHandlers = {
        sendText: vi.fn(),
        sendCard: vi.fn(),
      } as any;

      node.registerFeishuHandlers(mockHandlers);

      // Verify createInteractiveMessageHandler was called with the container
      // The container now has the handlers set by registerFeishuHandlers
      expect(createInteractiveMessageHandler).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ handlers: mockHandlers }),
      );
    });
  });

  // ==========================================================================
  // Scheduler getters
  // ==========================================================================

  describe('getScheduler()', () => {
    it('should return undefined before start', () => {
      const node = new PrimaryNode();
      expect(node.getScheduler()).toBeUndefined();
    });

    it('should return scheduler instance after start', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(node.getScheduler()).toBeDefined();
    });
  });

  describe('getScheduleManager()', () => {
    it('should return undefined before start', () => {
      const node = new PrimaryNode();
      expect(node.getScheduleManager()).toBeUndefined();
    });

    it('should return schedule manager after start', async () => {
      const node = new PrimaryNode();
      await node.start();
      expect(node.getScheduleManager()).toBeDefined();
    });
  });

  // ==========================================================================
  // Full lifecycle
  // ==========================================================================

  describe('full lifecycle', () => {
    it('should support start → stop → start cycle', async () => {
      const node = new PrimaryNode();

      // First start
      await node.start();
      expect(node.isRunning()).toBe(true);

      // Stop
      await node.stop();
      expect(node.isRunning()).toBe(false);

      // Second start
      await node.start();
      expect(node.isRunning()).toBe(true);
    });
  });
});
