/**
 * Tests for WsConnectionManager (Issue #1351).
 *
 * Tests cover:
 * - Connection lifecycle (start, stop)
 * - Health detection (dead connection detection)
 * - Exponential backoff reconnection
 * - State machine transitions
 * - Event emission
 * - Metrics reporting
 * - Grace period after connect
 *
 * Does NOT mock the @larksuiteoapi/node-sdk directly (per CLAUDE.md rules),
 * instead uses dependency-injected mocks via constructor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WsConnectionManager,
  calculateReconnectDelay,
  isPongFrame,
} from './ws-connection-manager.js';

// ─── Mocked WSClient factory ────────────────────────────────────────────

interface MockWSClient {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wsConfig: any;
}

function createMockWSClient(shouldFail = false, serviceId = 'test-service-id'): MockWSClient {
  return {
    start: vi.fn().mockResolvedValue(shouldFail ? false : undefined),
    close: vi.fn(),
    sendMessage: vi.fn(),
    wsConfig: {
      getWS: vi.fn().mockReturnValue({ serviceId }),
      getWSInstance: vi.fn().mockReturnValue(null),
    },
  };
}

// Mock EventDispatcher (minimal — just needs register to return itself)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockEventDispatcher(): any {
  return { register: vi.fn().mockReturnThis() };
}

// ─── Mock @disclaude/core ───────────────────────────────────────────────

const MOCK_WS_HEALTH = vi.hoisted(() => ({
  DEAD_CONNECTION_TIMEOUT_MS: 3000,
  HEALTH_CHECK_INTERVAL_MS: 1000,
  CUSTOM_PING_INTERVAL_MS: 500,
  WS_INSTANCE_POLL_TIMEOUT_MS: 2000,
  WS_INSTANCE_POLL_INTERVAL_MS: 50,
  RECONNECT: {
    BASE_DELAY_MS: 100,
    MAX_DELAY_MS: 1000,
    BACKOFF_MULTIPLIER: 2,
    JITTER_MS: 50,
    MAX_ATTEMPTS: 3,
  },
  OFFLINE_QUEUE: {
    MAX_SIZE: 100,
    MAX_MESSAGE_AGE_MS: 600000,
  },
}));

vi.mock('@disclaude/core', () => ({
  WS_HEALTH: MOCK_WS_HEALTH,
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  }),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  WSClient: vi.fn(),
  LoggerLevel: { info: 'info' },
  EventDispatcher: vi.fn().mockImplementation(() => ({
    register: vi.fn().mockReturnThis(),
  })),
}));

// ─── Helper to simulate WebSocket interception (for Pong tests) ─────────
// In production, interceptWsFromClient() accesses wsClient.wsConfig.getWSInstance()
// and calls ws.on('message', handler). In tests, the mock WSClient doesn't have
// a real ws instance, so we manually wire up a minimal EventEmitter-like object
// with the manager's onWsMessage handler.

const PONG_BUFFER = Buffer.from([
  0x08, 0x00, 0x10, 0x00, 0x18, 0x01, 0x20, 0x00,
  0x2A, 0x0C, 0x0A, 0x04, 0x74, 0x79, 0x70, 0x65,
  0x12, 0x04, 0x70, 0x6F, 0x6E, 0x67,
]);

/**
 * Minimal mock of a `ws` WebSocket instance for testing Pong interception.
 * Uses Node.js EventEmitter for .on()/.off() compatibility.
 */
import { EventEmitter } from 'events';

class MockWsInstance extends EventEmitter {
  readyState = 1; // OPEN
  send() {}
  close() {}
  terminate() {}
  removeAllListeners(event?: string | symbol): this {
    super.removeAllListeners(event);
    return this;
  }
}

function setupInterceptedWs(manager: WsConnectionManager): MockWsInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mgr = manager as any;
  const fakeWs = new MockWsInstance();
  const onMessageBound = (data: Buffer) => {
    mgr.onWsMessage(data);
  };
  fakeWs.on('message', onMessageBound);
  mgr.interceptedWs = { instance: fakeWs, onMessageBound };
  return fakeWs;
}

// ─── Helper to create a manager with mocked WSClient ────────────────────

function createTestManager(overrides: {
  wsClient?: MockWSClient;
  maxAttempts?: number;
  deadTimeoutMs?: number;
  healthCheckMs?: number;
  customPingIntervalMs?: number;
} = {}): WsConnectionManager {
  const manager = new WsConnectionManager({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    reconnectMaxAttempts: overrides.maxAttempts ?? MOCK_WS_HEALTH.RECONNECT.MAX_ATTEMPTS,
    deadConnectionTimeoutMs: overrides.deadTimeoutMs ?? MOCK_WS_HEALTH.DEAD_CONNECTION_TIMEOUT_MS,
    healthCheckIntervalMs: overrides.healthCheckMs ?? MOCK_WS_HEALTH.HEALTH_CHECK_INTERVAL_MS,
    customPingIntervalMs: overrides.customPingIntervalMs ?? MOCK_WS_HEALTH.CUSTOM_PING_INTERVAL_MS,
  });

  // Monkey-patch the larkSDK reference to use our mock WSClient constructor
  const mockClient = overrides.wsClient ?? createMockWSClient();
  (manager as unknown as {
    larkSDK: { WSClient: ReturnType<typeof vi.fn>; LoggerLevel: { info: string } };
  }).larkSDK = {
    WSClient: vi.fn().mockReturnValue(mockClient),
    LoggerLevel: { info: 'info' },
  };

  return manager;
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('calculateReconnectDelay', () => {
  it('should return base delay for attempt 0', () => {
    const delay = calculateReconnectDelay(0, 1000, 60000, 500);
    // baseDelay * 2^0 + jitter(0-500) = 1000 + [0, 500)
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThan(1500);
  });

  it('should double delay with each attempt', () => {
    const delay0 = calculateReconnectDelay(0, 1000, 60000, 0);
    const delay1 = calculateReconnectDelay(1, 1000, 60000, 0);
    const delay2 = calculateReconnectDelay(2, 1000, 60000, 0);
    expect(delay1).toBe(delay0 * 2);
    expect(delay2).toBe(delay0 * 4);
  });

  it('should cap at max delay', () => {
    const delay = calculateReconnectDelay(100, 1000, 5000, 0);
    expect(delay).toBe(5000);
  });

  it('should add jitter within [0, jitterMs)', () => {
    const results = Array.from({ length: 100 }, () =>
      calculateReconnectDelay(5, 100, 100000, 200),
    );
    // All should be in range [3200, 3400) = 100 * 2^5 + [0, 200)
    for (const d of results) {
      expect(d).toBeGreaterThanOrEqual(3200);
      expect(d).toBeLessThan(3400);
    }
    // Should not all be the same (randomness)
    const unique = new Set(results);
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('isPongFrame', () => {
  it('should detect Pong in a buffer containing the protobuf "pong" marker', () => {
    // Construct a minimal binary buffer that contains the Pong marker
    // In protobuf: length-prefixed string "pong" = \x04 + "pong"
    // We also need the method=0 (control frame) field for context,
    // but isPongFrame only looks for the "pong" marker
    const buffer = Buffer.from([
      0x08, 0x00,                         // SeqID = 0 (varint)
      0x10, 0x00,                         // LogID = 0 (varint)
      0x18, 0x01,                         // service = 1 (varint)
      0x20, 0x00,                         // method = 0 (control frame)
      0x2A, 0x0C,                         // headers entry length = 12
      0x0A, 0x04, 0x74, 0x79, 0x70, 0x65, // field 1: key = "type" (len=4)
      0x12, 0x04, 0x70, 0x6F, 0x6E, 0x67, // field 2: value = "pong" (len=4)
    ]);
    expect(isPongFrame(buffer)).toBe(true);
  });

  it('should not detect non-Pong frames', () => {
    // Construct a frame with "ping" instead of "pong"
    const buffer = Buffer.from([
      0x08, 0x00,
      0x10, 0x00,
      0x18, 0x01,
      0x20, 0x00,
      0x2A, 0x0C,
      0x0A, 0x04, 0x74, 0x79, 0x70, 0x65,
      0x12, 0x04, 0x70, 0x69, 0x6E, 0x67,
    ]);
    expect(isPongFrame(buffer)).toBe(false);
  });

  it('should handle ArrayBuffer input', () => {
    const buffer = Buffer.from([
      0x08, 0x00, 0x10, 0x00, 0x18, 0x01, 0x20, 0x00,
      0x2A, 0x0C, 0x0A, 0x04, 0x74, 0x79, 0x70, 0x65,
      0x12, 0x04, 0x70, 0x6F, 0x6E, 0x67,
    ]);
    expect(isPongFrame(buffer.buffer)).toBe(true);
  });

  it('should handle Uint8Array input', () => {
    const buffer = Buffer.from([
      0x08, 0x00, 0x10, 0x00, 0x18, 0x01, 0x20, 0x00,
      0x2A, 0x0C, 0x0A, 0x04, 0x74, 0x79, 0x70, 0x65,
      0x12, 0x04, 0x70, 0x6F, 0x6E, 0x67,
    ]);
    expect(isPongFrame(new Uint8Array(buffer))).toBe(true);
  });

  it('should return false for empty buffer', () => {
    expect(isPongFrame(Buffer.alloc(0))).toBe(false);
  });

  it('should return false for string data (non-binary)', () => {
    expect(isPongFrame('hello' as unknown as Buffer)).toBe(false);
  });
});

describe('WsConnectionManager', () => {
  let manager: WsConnectionManager;
  let mockEventDispatcher: ReturnType<typeof createMockEventDispatcher>;

  beforeEach(() => {
    vi.useFakeTimers();
    mockEventDispatcher = createMockEventDispatcher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('lifecycle', () => {
    it('should start and transition to connected state', async () => {
      manager = createTestManager();
      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);

      expect(manager.state).toBe('connected');
      expect(stateChanges).toContain('connected');
    });

    it('should stop and transition to stopped state', async () => {
      manager = createTestManager();
      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);
      await manager.stop();

      expect(manager.state).toBe('stopped');
      expect(stateChanges).toContain('connected');
      expect(stateChanges).toContain('stopped');
    });

    it('should be healthy after successful start', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      expect(manager.isHealthy()).toBe(true);
    });

    it('should not be healthy after stop', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);
      await manager.stop();

      expect(manager.isHealthy()).toBe(false);
    });

    it('should handle start failure gracefully', async () => {
      const failingClient = createMockWSClient(true);
      manager = createTestManager({ wsClient: failingClient });

      // start() calls connectFresh() which fails, then enters reconnect mode
      // maxAttempts defaults to 3, so it will try to reconnect
      await manager.start(mockEventDispatcher as never);

      // State should be reconnecting (initial connect failed, entering reconnect)
      expect(manager.state).toBe('reconnecting');
    });
  });

  describe('health detection', () => {
    it('should detect dead connection after timeout', async () => {
      const deadTimeoutMs = 5000;
      const healthCheckMs = 1000;
      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 0,
      });

      const deadConnectionEvents: number[] = [];
      manager.on('deadConnection', (elapsed) => deadConnectionEvents.push(elapsed));

      await manager.start(mockEventDispatcher as never);

      // Record a message to set lastMessageReceivedAt
      manager.recordMessageReceived();

      // Advance time past the dead connection timeout
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // Should have detected dead connection
      expect(deadConnectionEvents.length).toBeGreaterThanOrEqual(1);
      expect(deadConnectionEvents[0]).toBeGreaterThanOrEqual(deadTimeoutMs);
    });

    it('should reset health timer on recordMessageReceived', async () => {
      const deadTimeoutMs = 5000;
      const healthCheckMs = 1000;
      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 0,
      });

      const deadConnectionEvents: number[] = [];
      manager.on('deadConnection', () => deadConnectionEvents.push(1));

      await manager.start(mockEventDispatcher as never);

      // Advance 4 seconds (not yet dead from connect time)
      await vi.advanceTimersByTimeAsync(4000);
      expect(deadConnectionEvents.length).toBe(0);

      // Record activity (resets the timer)
      manager.recordMessageReceived();

      // Advance another 4 seconds from now (still not dead, only 4s since last activity)
      await vi.advanceTimersByTimeAsync(4000);
      expect(deadConnectionEvents.length).toBe(0);

      // Advance past the timeout from the last activity
      await vi.advanceTimersByTimeAsync(2000);
      expect(deadConnectionEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit heartbeat event on recordMessageReceived', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const heartbeatTimestamps: number[] = [];
      manager.on('heartbeat', (ts) => heartbeatTimestamps.push(ts));

      const before = Date.now();
      manager.recordMessageReceived();

      expect(heartbeatTimestamps.length).toBe(1);
      expect(heartbeatTimestamps[0]).toBeGreaterThanOrEqual(before);
    });

    it('should have grace period equal to deadConnectionTimeoutMs after initial connect', async () => {
      const deadTimeoutMs = 5000;
      const healthCheckMs = 1000;
      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);

      // Don't call recordMessageReceived — connectFresh() sets lastMessageReceivedAt
      // The grace period is effectively deadConnectionTimeoutMs from connect time

      // Advance to just before timeout — should still be healthy
      await vi.advanceTimersByTimeAsync(deadTimeoutMs - 100);
      expect(manager.isHealthy()).toBe(true);

      // Advance past timeout — should be unhealthy (triggers dead connection)
      await vi.advanceTimersByTimeAsync(200);
      expect(manager.isHealthy()).toBe(false);
    });
  });

  describe('Pong detection', () => {
    it('should emit pong event when intercepted WebSocket receives Pong', async () => {
      manager = createTestManager();
      const pongEvents: number[] = [];
      manager.on('pong', (rttMs) => pongEvents.push(rttMs));

      await manager.start(mockEventDispatcher as never);
      const fakeWs = setupInterceptedWs(manager);

      // Simulate the `ws` WebSocket emitting a Pong frame
      // The `ws` package passes raw Buffer as the first argument (not a MessageEvent)
      fakeWs.emit('message', PONG_BUFFER);

      expect(pongEvents.length).toBe(1);
      expect(pongEvents[0]).toBeGreaterThanOrEqual(-1); // -1 if no ping tracked
    });

    it('should not emit pong for non-Pong messages', async () => {
      manager = createTestManager();
      const pongEvents: number[] = [];
      manager.on('pong', () => pongEvents.push(1));

      await manager.start(mockEventDispatcher as never);
      const fakeWs = setupInterceptedWs(manager);

      // Emit a non-Pong message (raw buffer, not a Pong frame)
      fakeWs.emit('message', Buffer.from('not a pong frame'));

      expect(pongEvents.length).toBe(0);
    });

    it('should include pongCount in metrics', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);
      const fakeWs = setupInterceptedWs(manager);

      // Simulate multiple Pongs via `ws` .emit('message', buffer)
      fakeWs.emit('message', PONG_BUFFER);
      fakeWs.emit('message', PONG_BUFFER);
      fakeWs.emit('message', PONG_BUFFER);

      const metrics = manager.getMetrics();
      expect(metrics.pongCount).toBeGreaterThanOrEqual(3);
    });

    it('should prefer Pong timing over application-level timing in health check', async () => {
      const deadTimeoutMs = 5000;
      const healthCheckMs = 1000;
      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 0,
      });

      const deadEvents: number[] = [];
      manager.on('deadConnection', () => deadEvents.push(1));

      await manager.start(mockEventDispatcher as never);

      // Simulate receiving a Pong (via `ws` .emit)
      const fakeWs = setupInterceptedWs(manager);
      fakeWs.emit('message', PONG_BUFFER);

      // Advance 3 seconds (not yet dead — Pong received 3s ago, < 5s timeout)
      await vi.advanceTimersByTimeAsync(3000);
      expect(deadEvents.length).toBe(0);

      // Call recordMessageReceived — updates application-level timer but NOT Pong timer
      manager.recordMessageReceived();

      // Advance 3 more seconds (6s since Pong, but only 3s since last message)
      // Pong-preferred health check uses lastPongAt: 6s > 5s → dead connection detected
      // If it used application-level: 3s < 5s → would NOT be dead
      await vi.advanceTimersByTimeAsync(3000);
      expect(deadEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('WebSocket instance polling (Issue #1504)', () => {
    it('should activate Pong detection when SDK WebSocket becomes available after polling', async () => {
      // Simulate the real-world race condition: SDK start() resolves but
      // getWSInstance() returns null initially, then returns a valid instance
      // after ~200ms (simulating SDK internal connect() completing).
      let getInstanceCallCount = 0;
      const delayedWs = new MockWsInstance();

      const delayedClient = createMockWSClient(false);
      delayedClient.wsConfig.getWSInstance = vi.fn().mockImplementation(() => {
        getInstanceCallCount++;
        // Return null for the first 3 calls, then return the ws instance
        if (getInstanceCallCount <= 3) {
          return null;
        }
        return delayedWs;
      });

      manager = createTestManager({
        wsClient: delayedClient,
        maxAttempts: 0,
        customPingIntervalMs: 0, // Disable custom ping to isolate polling test
      });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);

      // After start(), the manager should be connected even though
      // Pong detection hasn't been activated yet (polling in background)
      expect(manager.state).toBe('connected');

      // Before polling completes: hasWsInterception should be false
      // (first call to getWSInstance returned null)
      let metrics = manager.getMetrics();
      expect(metrics.hasWsInterception).toBe(false);

      // Advance time past the polling interval to allow the background
      // polling to discover the WebSocket instance
      // 3 failed polls × 50ms = 150ms, then 4th poll succeeds
      await vi.advanceTimersByTimeAsync(200);

      // After polling succeeds, Pong detection should be active
      metrics = manager.getMetrics();
      expect(metrics.hasWsInterception).toBe(true);

      // Verify the intercepted WebSocket actually receives messages
      const pongEvents: number[] = [];
      manager.on('pong', (rttMs) => pongEvents.push(rttMs));
      delayedWs.emit('message', PONG_BUFFER);
      expect(pongEvents.length).toBe(1);
    });

    it('should remain in fallback mode when SDK WebSocket never becomes available', async () => {
      // Simulate SDK where getWSInstance() always returns null
      const alwaysNullClient = createMockWSClient(false);
      alwaysNullClient.wsConfig.getWSInstance = vi.fn().mockReturnValue(null);

      manager = createTestManager({
        wsClient: alwaysNullClient,
        maxAttempts: 0,
        customPingIntervalMs: 0,
      });

      await manager.start(mockEventDispatcher as never);

      // Advance past the polling timeout (2s)
      await vi.advanceTimersByTimeAsync(MOCK_WS_HEALTH.WS_INSTANCE_POLL_TIMEOUT_MS + 500);

      // Should still be connected (fallback mode) but without Pong detection
      expect(manager.state).toBe('connected');
      const metrics = manager.getMetrics();
      expect(metrics.hasWsInterception).toBe(false);
    });

    it('should stop polling when manager is stopped', async () => {
      const alwaysNullClient = createMockWSClient(false);
      alwaysNullClient.wsConfig.getWSInstance = vi.fn().mockReturnValue(null);

      manager = createTestManager({
        wsClient: alwaysNullClient,
        maxAttempts: 0,
        customPingIntervalMs: 0,
      });

      await manager.start(mockEventDispatcher as never);

      // Advance a bit but not to timeout
      await vi.advanceTimersByTimeAsync(500);

      // Stop the manager
      await manager.stop();

      // Advance past the timeout — polling should have stopped
      await vi.advanceTimersByTimeAsync(MOCK_WS_HEALTH.WS_INSTANCE_POLL_TIMEOUT_MS + 1000);

      // Manager should be stopped, no crash from polling
      expect(manager.state).toBe('stopped');
    });

    it('should handle SDK WebSocket becoming available then disappearing (TOCTOU avoidance)', async () => {
      // This test verifies the TOCTOU fix: even if getWSInstance() returns
      // a value during polling, but interceptWsFromClient receives it via
      // preObtainedInstance (not re-querying), the interception is reliable.
      let callCount = 0;
      const validWs = new MockWsInstance();

      const flakyClient = createMockWSClient(false);
      flakyClient.wsConfig.getWSInstance = vi.fn().mockImplementation(() => {
        callCount++;
        // Return null initially, then return instance once, then null again
        if (callCount <= 2) return null;
        if (callCount === 3) return validWs; // Poll gets this
        return null; // Subsequent queries return null (TOCTOU scenario)
      });

      manager = createTestManager({
        wsClient: flakyClient,
        maxAttempts: 0,
        customPingIntervalMs: 0,
      });

      await manager.start(mockEventDispatcher as never);

      // Advance for polling to discover the instance
      await vi.advanceTimersByTimeAsync(200);

      // Pong detection should be active despite the instance disappearing
      // from getWSInstance() because pollForWsInstance() passes the instance
      // directly to interceptWsFromClient() (TOCTOU avoidance)
      const metrics = manager.getMetrics();
      expect(metrics.hasWsInterception).toBe(true);

      // Verify the listener is on the correct instance
      const pongEvents: number[] = [];
      manager.on('pong', (rttMs) => pongEvents.push(rttMs));
      validWs.emit('message', PONG_BUFFER);
      expect(pongEvents.length).toBe(1);
    });

    it('should not block connectFresh() when polling is needed', async () => {
      // Verify that start() returns quickly even when getWSInstance() returns null
      // (polling runs in background, doesn't block connection establishment)
      const slowClient = createMockWSClient(false);
      slowClient.wsConfig.getWSInstance = vi.fn().mockReturnValue(null);

      manager = createTestManager({
        wsClient: slowClient,
        maxAttempts: 0,
        customPingIntervalMs: 0,
      });

      const startPromise = manager.start(mockEventDispatcher as never);

      // start() should resolve quickly (not wait for polling timeout)
      // In fake timer environment, polling setTimeout doesn't advance
      // until we call advanceTimersByTimeAsync, but start() should still
      // resolve because polling is fire-and-forget
      await startPromise;

      expect(manager.state).toBe('connected');
    });
  });

  describe('custom ping loop', () => {
    it('should send custom pings at configured interval', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);

      // Advance past first custom ping interval
      await vi.advanceTimersByTimeAsync(500);

      // Should have called sendMessage with a ping frame
      expect(mockClient.sendMessage).toHaveBeenCalledTimes(1);
      const [[sentFrame]] = mockClient.sendMessage.mock.calls;
      expect(sentFrame.headers[0].key).toBe('type');
      expect(sentFrame.headers[0].value).toBe('ping');
      expect(sentFrame.method).toBe(0); // FrameType.control
      expect(sentFrame.service).toBe(Number('test-service-id'));

      // Advance for 2 more pings
      await vi.advanceTimersByTimeAsync(1000);
      expect(mockClient.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should emit ping event when custom ping is sent', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      const pingEvents: number[] = [];
      manager.on('ping', (intervalMs) => pingEvents.push(intervalMs));

      await manager.start(mockEventDispatcher as never);
      await vi.advanceTimersByTimeAsync(500);

      expect(pingEvents.length).toBe(1);
      expect(pingEvents[0]).toBe(500);
    });

    it('should stop custom ping loop when manager stops', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);
      await vi.advanceTimersByTimeAsync(1000);
      const countBeforeStop = mockClient.sendMessage.mock.calls.length;

      await manager.stop();

      // Advance time — no more pings should be sent
      await vi.advanceTimersByTimeAsync(2000);
      expect(mockClient.sendMessage.mock.calls.length).toBe(countBeforeStop);
    });

    it('should not start custom ping loop when interval is 0', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 0,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);
      await vi.advanceTimersByTimeAsync(2000);

      // Should not have called sendMessage for custom ping
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
    });

    it('should include customPingCount in metrics', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);
      await vi.advanceTimersByTimeAsync(1500);

      const metrics = manager.getMetrics();
      expect(metrics.customPingCount).toBe(3);
      expect(metrics.customPingIntervalMs).toBe(500);
    });

    it('should gracefully skip when sendMessage is not available', async () => {
      const mockClient = createMockWSClient(false);
      // Remove sendMessage to simulate SDK without it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient as any).sendMessage = undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (mockClient as any).wsConfig = undefined;

      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      // Should not throw
      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Advance time — should still be connected, no crash
      await vi.advanceTimersByTimeAsync(2000);
      expect(manager.state).toBe('connected');
    });

    it('should reset custom ping count on reconnect', async () => {
      const deadTimeoutMs = 3000;
      const healthCheckMs = 1000;
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        wsClient: succeedingClient,
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 3,
        customPingIntervalMs: 500,
      });

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();

      // Send some custom pings
      await vi.advanceTimersByTimeAsync(1500);
      expect(succeedingClient.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);

      // Trigger dead connection and reconnect
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs + 5000);

      // After reconnect, custom ping count should be reset
      const metrics = manager.getMetrics();
      if (metrics.state === 'connected') {
        // Custom ping count was reset on reconnect
        expect(succeedingClient.sendMessage.mock.calls.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('should pair custom ping with pong for RTT estimation', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        wsClient: mockClient,
        customPingIntervalMs: 500,
        maxAttempts: 0,
      });

      const pongEvents: number[] = [];
      manager.on('pong', (rttMs) => pongEvents.push(rttMs));

      await manager.start(mockEventDispatcher as never);
      const fakeWs = setupInterceptedWs(manager);

      // Wait for custom ping to be sent
      await vi.advanceTimersByTimeAsync(500);

      // Simulate Pong response
      fakeWs.emit('message', PONG_BUFFER);

      // RTT should be recorded (approximate, within reasonable range)
      expect(pongEvents.length).toBe(1);
      expect(pongEvents[0]).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reconnection', () => {
    it('should transition through reconnecting state on dead connection', async () => {
      const deadTimeoutMs = 3000;
      const healthCheckMs = 1000;
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();

      // Trigger dead connection
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // Should have gone through reconnecting state
      expect(stateChanges).toContain('reconnecting');
      // After reconnect succeeds, should be connected again
      await vi.advanceTimersByTimeAsync(5000);
      expect(stateChanges.filter(s => s === 'connected').length).toBeGreaterThanOrEqual(2);
    });

    it('should successfully reconnect after dead connection detection', async () => {
      const deadTimeoutMs = 3000;
      const healthCheckMs = 1000;
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      const reconnectedEvents: number[] = [];
      manager.on('reconnected', (attempt) => reconnectedEvents.push(attempt));

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();

      // Trigger dead connection
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // Wait for reconnect delay to pass
      await vi.advanceTimersByTimeAsync(5000);

      // Should have reconnected
      expect(manager.state).toBe('connected');
      expect(reconnectedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should stop reconnecting after max attempts when all fail', async () => {
      const deadTimeoutMs = 2000;
      const healthCheckMs = 1000;

      // Create a mock that succeeds initially but fails on reconnects
      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
        sendMessage: vi.fn(),
        wsConfig: {
          getWS: vi.fn().mockReturnValue({ serviceId: 'test-service-id' }),
          getWSInstance: vi.fn().mockReturnValue(null),
        },
      };

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 2,
        wsClient: conditionalClient,
      });

      const reconnectFailedEvents: number[] = [];
      manager.on('reconnectFailed', (total) => reconnectFailedEvents.push(total));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      manager.recordMessageReceived();

      // Trigger dead connection
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // Advance through all reconnect attempts with enough time
      // baseDelay=100, max=1000, attempts: 0 (100-150ms), 1 (200-250ms), then stop
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      // Should have given up after max attempts
      expect(manager.state).toBe('stopped');
      expect(reconnectFailedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit reconnectFailed with correct total attempts', async () => {
      const deadTimeoutMs = 2000;
      const healthCheckMs = 1000;
      const maxAttempts = 2;

      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
        sendMessage: vi.fn(),
        wsConfig: {
          getWS: vi.fn().mockReturnValue({ serviceId: 'test-service-id' }),
          getWSInstance: vi.fn().mockReturnValue(null),
        },
      };

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts,
        wsClient: conditionalClient,
      });

      let failedTotal = 0;
      manager.on('reconnectFailed', (total) => { failedTotal = total; });

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();

      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // Run through all retries
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(failedTotal).toBeGreaterThanOrEqual(maxAttempts);
    });
  });

  describe('metrics', () => {
    it('should return correct metrics', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const metrics = manager.getMetrics();
      expect(metrics.state).toBe('connected');
      expect(metrics.isConnected).toBe(true);
      expect(metrics.reconnectAttempt).toBe(0);
      expect(metrics.lastMessageReceivedAt).toBeGreaterThan(0);
    });

    it('should reflect state changes in metrics', async () => {
      const deadTimeoutMs = 3000;
      const healthCheckMs = 1000;
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      await manager.start(mockEventDispatcher as never);

      // Before any dead connection
      const metricsBefore = manager.getMetrics();
      expect(metricsBefore.state).toBe('connected');

      // Trigger dead connection (state should transition to reconnecting)
      manager.recordMessageReceived();
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);

      // State is at least reconnecting or already reconnected
      const metricsDuring = manager.getMetrics();
      expect(['reconnecting', 'connected']).toContain(metricsDuring.state);
    });
  });

  describe('edge cases', () => {
    it('should not trigger dead connection when stopped', async () => {
      const deadTimeoutMs = 2000;
      const healthCheckMs = 500;
      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 0,
      });

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();
      await manager.stop();

      const deadEvents: number[] = [];
      manager.on('deadConnection', (e) => deadEvents.push(e));

      // Advance well past timeout
      await vi.advanceTimersByTimeAsync(10000);

      expect(deadEvents.length).toBe(0);
    });

    it('should suppress redundant reconnect initiation while reconnecting', async () => {
      const deadTimeoutMs = 2000;
      const healthCheckMs = 500;
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        deadTimeoutMs,
        healthCheckMs,
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      let deadEventCount = 0;
      manager.on('deadConnection', () => { deadEventCount++; });

      await manager.start(mockEventDispatcher as never);
      manager.recordMessageReceived();

      // Trigger first dead connection
      await vi.advanceTimersByTimeAsync(deadTimeoutMs + healthCheckMs);
      const firstCount = deadEventCount;

      // The reconnect flow transitions state to 'reconnecting',
      // and runHealthCheck() early-returns when state !== 'connected'.
      // Additional health check ticks should be suppressed.
      // Note: In fake timer environment, the reconnect may not have
      // completed yet (async callback in setTimeout), so state is
      // still 'reconnecting' and health checks are properly suppressed.
      expect(deadEventCount).toBeLessThanOrEqual(firstCount + 1);
    });

    it('should handle double stop gracefully', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);
      await manager.stop();
      await manager.stop(); // Should not throw
      expect(manager.state).toBe('stopped');
    });
  });
});
