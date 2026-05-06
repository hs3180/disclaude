/**
 * P2 Integration test: WebSocket reconnection message continuity.
 *
 * Verifies that the WsConnectionManager correctly handles disconnection
 * and reconnection scenarios, and that IPC messaging continues to work
 * after the connection recovers.
 *
 * Test approach:
 *   1. Set up IPC client/server with mock handlers (same as other integration tests)
 *   2. Verify IPC messaging works before simulated disconnect
 *   3. Simulate a WsConnectionManager reconnection cycle with mocked SDK
 *   4. Verify IPC messaging still works after reconnection completes
 *
 * This validates the "no message loss after reconnect" requirement by
 * confirming that the IPC transport layer is unaffected by WebSocket
 * state transitions (they operate on independent connections).
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npx vitest --run tests/integration/feishu
 *
 * @see Issue #1626
 * @see Issue #1351 — WsConnectionManager initial implementation
 * @see Issue #2905 — SDK event-driven reconnection (replaced custom health check)
 * @see Issue #2259 — MaxListeners leak fix & DNS pre-check
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  UnixSocketIpcServer,
  UnixSocketIpcClient,
  createInteractiveMessageHandler,
  type ChannelHandlersContainer,
} from '@disclaude/primary-node';
import {
  WsConnectionManager,
  calculateReconnectDelay,
} from '../../../packages/primary-node/src/channels/feishu/ws-connection-manager.js';
import type { WsConnectionState } from '../../../packages/primary-node/src/channels/feishu/ws-connection-manager.js';
import { describeIfFeishu, generateSocketPath, cleanupSocket } from './helpers.js';

// ─── Mock WSClient factory ────────────────────────────────────────────

interface MockWSClient {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  removeAllListeners?: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

function createMockWSClient(shouldFail = false): MockWSClient {
  return {
    start: vi.fn().mockResolvedValue(shouldFail ? false : undefined),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
  };
}

/** Create a mock EventDispatcher for WsConnectionManager */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockEventDispatcher(): any {
  return { register: vi.fn().mockReturnThis() };
}

/**
 * Helper to find an event listener registered on a mock WSClient.
 */
function findEventListener(
  mockClient: MockWSClient,
  eventType: string,
): ((...args: unknown[]) => void) | undefined {
  const onCalls = mockClient.on.mock.calls as Array<[string, ...unknown[]]>;
  return onCalls.find((call) => call[0] === eventType)?.[1] as
    | ((...args: unknown[]) => void)
    | undefined;
}

/** Create a WsConnectionManager with mocked SDK and configurable reconnect */
function createTestWsManager(overrides: {
  wsClient?: MockWSClient;
  maxAttempts?: number;
} = {}): { manager: WsConnectionManager; mockClient: MockWSClient } {
  const mockClient = overrides.wsClient ?? createMockWSClient();

  const manager = new WsConnectionManager({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    reconnectMaxAttempts: overrides.maxAttempts ?? -1,
    reconnectBaseDelayMs: 50,
    reconnectMaxDelayMs: 500,
    dnsCheckHost: '',
  });

  // Monkey-patch the larkSDK reference to use mock
  (manager as unknown as {
    larkSDK: { WSClient: ReturnType<typeof vi.fn>; LoggerLevel: { info: string } };
  }).larkSDK = {
    WSClient: vi.fn().mockReturnValue(mockClient),
    LoggerLevel: { info: 'info' },
  };

  return { manager, mockClient };
}

describeIfFeishu('WebSocket reconnection message continuity', () => {
  let ipcServer: UnixSocketIpcServer;
  let ipcClient: UnixSocketIpcClient;
  let socketPath: string;
  let capturedMessages: Array<{ chatId: string; text: string }>;

  beforeEach(async () => {
    vi.useFakeTimers();
    socketPath = generateSocketPath();
    capturedMessages = [];

    // Set up IPC transport (simulates the Agent ↔ Feishu bot communication)
    const container: ChannelHandlersContainer = {
      handlers: {
        sendMessage: async (chatId, text) => {
          capturedMessages.push({ chatId, text });
        },
        sendCard: async () => {},
        sendInteractive: async () => ({ messageId: 'om_reconnect_test' }),
        uploadFile: async () => ({ fileKey: 'fk', fileType: 'file', fileName: 'f', fileSize: 0 }),
      },
    };

    const handler = createInteractiveMessageHandler(() => {}, container);
    ipcServer = new UnixSocketIpcServer(handler, { socketPath });
    ipcClient = new UnixSocketIpcClient({ socketPath, timeout: 5000 });

    await ipcServer.start();
    await ipcClient.connect();
  });

  afterEach(async () => {
    vi.useRealTimers();
    try {
      await ipcClient.disconnect();
      await ipcServer.stop();
    } finally {
      cleanupSocket(socketPath);
    }
  });

  it('should send messages before and after simulated WebSocket reconnection', async () => {
    // Step 1: Create WsConnectionManager with mocked SDK
    const { manager, mockClient } = createTestWsManager({ maxAttempts: 3 });
    const stateChanges: WsConnectionState[] = [];
    manager.on('stateChange', (state) => stateChanges.push(state));

    const mockDispatcher = createMockEventDispatcher();

    // Step 2: Start the WebSocket connection
    await manager.start(mockDispatcher);
    expect(manager.state).toBe('connected');

    // Step 3: Send IPC messages while connected
    const result1 = await ipcClient.sendMessage('oc_chat_pre', 'Message before disconnect');
    expect(result1.success).toBe(true);

    // Step 4: Simulate WebSocket disconnect (SDK close event)
    const closeListener = findEventListener(mockClient, 'close');
    expect(closeListener).toBeDefined();
    if (closeListener) {
      closeListener(1000, 'simulated network interruption');
    }

    // Verify manager entered reconnecting state
    expect(manager.state).toBe('reconnecting');
    expect(stateChanges).toContain('reconnecting');

    // Step 5: Wait for reconnect to complete
    await vi.advanceTimersByTimeAsync(1000);

    // Verify manager reconnected
    expect(manager.state).toBe('connected');
    expect(stateChanges.filter((s) => s === 'connected').length).toBeGreaterThanOrEqual(2);

    // Step 6: Send IPC messages after reconnection — should still work
    const result2 = await ipcClient.sendMessage('oc_chat_post', 'Message after reconnect');
    expect(result2.success).toBe(true);

    // Verify both pre- and post-reconnect messages were captured
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].text).toBe('Message before disconnect');
    expect(capturedMessages[1].text).toBe('Message after reconnect');

    await manager.stop();
  });

  it('should handle multiple reconnection cycles without IPC degradation', async () => {
    const { manager, mockClient } = createTestWsManager({ maxAttempts: -1 });
    const reconnectedEvents: number[] = [];
    manager.on('reconnected', (attempt) => reconnectedEvents.push(attempt));

    await manager.start(createMockEventDispatcher());
    expect(manager.state).toBe('connected');

    // First cycle: disconnect → reconnect → send message
    let closeListener = findEventListener(mockClient, 'close');
    expect(closeListener).toBeDefined();
    if (closeListener) closeListener(1000, 'first disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.state).toBe('connected');

    const result1 = await ipcClient.sendMessage('oc_cycle_1', 'After first reconnect');
    expect(result1.success).toBe(true);

    // Second cycle: disconnect → reconnect → send message
    closeListener = findEventListener(mockClient, 'close');
    expect(closeListener).toBeDefined();
    if (closeListener) closeListener(1000, 'second disconnect');
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.state).toBe('connected');

    const result2 = await ipcClient.sendMessage('oc_cycle_2', 'After second reconnect');
    expect(result2.success).toBe(true);

    // Verify both messages captured
    expect(capturedMessages).toHaveLength(2);
    expect(reconnectedEvents.length).toBeGreaterThanOrEqual(2);

    await manager.stop();
  });

  it('should report correct metrics during and after reconnection', async () => {
    const { manager, mockClient } = createTestWsManager({ maxAttempts: 3 });

    await manager.start(createMockEventDispatcher());

    // Before disconnect
    const metricsBefore = manager.getMetrics();
    expect(metricsBefore.isConnected).toBe(true);
    expect(metricsBefore.state).toBe('connected');

    // Trigger disconnect
    const closeListener = findEventListener(mockClient, 'close');
    expect(closeListener).toBeDefined();
    if (closeListener) closeListener(1000, 'test');

    // During reconnect
    const metricsDuring = manager.getMetrics();
    expect(metricsDuring.isConnected).toBe(false);
    expect(metricsDuring.state).toBe('reconnecting');

    // Wait for reconnect
    await vi.advanceTimersByTimeAsync(1000);

    // After reconnect
    const metricsAfter = manager.getMetrics();
    expect(metricsAfter.isConnected).toBe(true);
    expect(metricsAfter.state).toBe('connected');

    await manager.stop();
  });

  it('should stop cleanly even during reconnection', async () => {
    const { manager, mockClient } = createTestWsManager({ maxAttempts: -1 });

    await manager.start(createMockEventDispatcher());

    // Trigger disconnect (enters reconnecting state)
    const closeListener = findEventListener(mockClient, 'close');
    expect(closeListener).toBeDefined();
    if (closeListener) closeListener(1000, 'test');

    expect(manager.state).toBe('reconnecting');

    // Stop while reconnecting — should clean up gracefully
    await manager.stop();
    expect(manager.state).toBe('stopped');

    // IPC should still function independently
    const result = await ipcClient.sendMessage('oc_stop_test', 'IPC works after WS stop');
    expect(result.success).toBe(true);
    expect(capturedMessages).toHaveLength(1);
    expect(capturedMessages[0].text).toBe('IPC works after WS stop');
  });
});

describeIfFeishu('calculateReconnectDelay backoff behavior', () => {
  it('should produce monotonically increasing delays', () => {
    const delays = Array.from({ length: 10 }, (_, i) =>
      calculateReconnectDelay(i, 50, 5000, 0),
    );

    // Without jitter, delays should be strictly increasing until capped
    for (let i = 1; i < delays.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    }
  });

  it('should cap at maximum delay', () => {
    const delay = calculateReconnectDelay(100, 50, 5000, 0);
    expect(delay).toBe(5000);
  });
});
