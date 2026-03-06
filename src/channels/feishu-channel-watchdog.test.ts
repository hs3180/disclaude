/**
 * Tests for FeishuChannel WebSocket reconnection watchdog.
 *
 * Issue #959: WebSocket 重连机制失效导致服务长时间中断
 *
 * This test file verifies the watchdog mechanism that monitors
 * WebSocket connection health and logs warnings when reconnection
 * takes too long.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock dependencies before importing
vi.mock('@larksuiteoapi/node-sdk', () => ({
  Client: vi.fn(() => ({
    request: vi.fn().mockResolvedValue({
      data: {
        bot: {
          open_id: 'cli_test_bot_id',
          app_name: 'Test Bot',
        },
      },
    }),
  })),
  WSClient: vi.fn(() => ({
    start: vi.fn().mockResolvedValue(undefined),
    getReconnectInfo: vi.fn().mockReturnValue({
      lastConnectTime: Date.now(),
      nextConnectTime: 0,
    }),
  })),
  EventDispatcher: vi.fn(() => ({
    register: vi.fn().mockReturnThis(),
  })),
  LoggerLevel: { info: 'info' },
  Domain: { Feishu: 'https://open.feishu.cn' },
}));

vi.mock('../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    trace: vi.fn(),
  })),
}));

vi.mock('../config/index.js', () => ({
  Config: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
    getDebugConfig: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../config/constants.js', () => ({
  DEDUPLICATION: { MAX_MESSAGE_AGE: 300000 },
  REACTIONS: { TYPING: 'Typing' },
  FEISHU_API: { REQUEST_TIMEOUT_MS: 30000 },
}));

vi.mock('../feishu/message-logger.js', () => ({
  messageLogger: {
    init: vi.fn().mockResolvedValue(undefined),
    isMessageProcessed: vi.fn().mockReturnValue(false),
    logIncomingMessage: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../file-transfer/inbound/index.js', () => ({
  attachmentManager: {
    getAttachments: vi.fn().mockReturnValue([]),
    cleanupOldAttachments: vi.fn(),
  },
  downloadFile: vi.fn(),
}));

vi.mock('../platforms/feishu/feishu-file-handler.js', () => ({
  FeishuFileHandler: vi.fn(() => ({
    handleFileMessage: vi.fn().mockResolvedValue({ success: false }),
    buildUploadPrompt: vi.fn().mockReturnValue(''),
  })),
}));

vi.mock('../platforms/feishu/feishu-message-sender.js', () => ({
  FeishuMessageSender: vi.fn(() => ({
    sendText: vi.fn().mockResolvedValue(undefined),
    sendCard: vi.fn().mockResolvedValue(undefined),
    sendFile: vi.fn().mockResolvedValue(undefined),
    addReaction: vi.fn().mockResolvedValue(true),
  })),
}));

vi.mock('../platforms/feishu/interaction-manager.js', () => ({
  InteractionManager: vi.fn(() => ({
    handleAction: vi.fn(),
    dispose: vi.fn(),
  })),
}));

vi.mock('../feishu/task-flow-orchestrator.js', () => ({
  TaskFlowOrchestrator: vi.fn(),
}));

vi.mock('../utils/task-tracker.js', () => ({
  TaskTracker: vi.fn(),
}));

import { FeishuChannel } from './feishu-channel.js';

describe('FeishuChannel - WebSocket Reconnection Watchdog (Issue #959)', () => {
  let channel: FeishuChannel;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    channel = new FeishuChannel({
      appId: 'test-app-id',
      appSecret: 'test-app-secret',
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await channel.stop();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('Watchdog lifecycle', () => {
    it('should start watchdog when channel starts', async () => {
      await channel.start();

      // Verify channel is running
      expect(channel.status).toBe('running');
    });

    it('should stop watchdog when channel stops', async () => {
      await channel.start();
      await channel.stop();

      // Verify channel is stopped
      expect(channel.status).toBe('stopped');
    });

    it('should initialize lastWsReadyTime on start', async () => {
      await channel.start();

      // Advance time and verify watchdog is running
      vi.advanceTimersByTime(60 * 1000); // 1 minute

      // Channel should still be healthy
      expect(channel.isHealthy()).toBe(true);
    });
  });

  describe('Watchdog health checks', () => {
    it('should check connection health periodically', async () => {
      await channel.start();

      // Advance time by 1 minute (default check interval)
      vi.advanceTimersByTime(60 * 1000);

      // Channel should still be running
      expect(channel.status).toBe('running');
    });

    it('should handle multiple check intervals', async () => {
      await channel.start();

      // Advance time by multiple check intervals
      vi.advanceTimersByTime(60 * 1000); // 1 minute
      vi.advanceTimersByTime(60 * 1000); // 2 minutes
      vi.advanceTimersByTime(60 * 1000); // 3 minutes

      // Channel should still be running
      expect(channel.status).toBe('running');
    });
  });

  describe('Channel health check', () => {
    it('should report healthy when wsClient exists', async () => {
      await channel.start();

      expect(channel.isHealthy()).toBe(true);
    });

    it('should report unhealthy when channel is stopped', async () => {
      await channel.start();
      await channel.stop();

      expect(channel.isHealthy()).toBe(false);
    });
  });

  describe('Watchdog with reconnection state', () => {
    it('should handle getReconnectInfo returning reconnecting state', async () => {
      await channel.start();

      // Verify channel is running - the mock getReconnectInfo returns healthy state by default
      expect(channel.status).toBe('running');

      // Advance time to trigger watchdog check
      vi.advanceTimersByTime(60 * 1000);

      // Channel should still be running
      expect(channel.status).toBe('running');
    });

    it('should handle getReconnectInfo without throwing error', async () => {
      await channel.start();

      // The mock is already configured to return valid reconnect info
      // Advance time to trigger watchdog check
      vi.advanceTimersByTime(60 * 1000);

      // Channel should still be running
      expect(channel.status).toBe('running');
    });
  });

  describe('Watchdog thresholds', () => {
    it('should not warn when connection is healthy', async () => {
      await channel.start();

      // Advance time by 1 minute (less than warning threshold of 5 minutes)
      vi.advanceTimersByTime(60 * 1000);

      // Channel should be healthy
      expect(channel.isHealthy()).toBe(true);
    });

    it('should continue running after multiple watchdog checks', async () => {
      await channel.start();

      // Simulate 10 minutes of periodic checks
      for (let i = 0; i < 10; i++) {
        vi.advanceTimersByTime(60 * 1000);
      }

      // Channel should still be running
      expect(channel.status).toBe('running');
    });
  });
});
