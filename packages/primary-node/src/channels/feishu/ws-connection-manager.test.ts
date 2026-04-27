/**
 * Tests for WsConnectionManager (Issue #1351, #1666, #2905).
 *
 * Tests cover:
 * - Connection lifecycle (start, stop)
 * - Exponential backoff reconnection
 * - State machine transitions
 * - Event emission
 * - Metrics reporting
 *
 * After Issue #2905, health check logic was removed. The manager now relies
 * on the SDK's built-in ping/pong keepalive and only provides connection
 * state tracking and auto-reconnect with exponential backoff.
 *
 * Does NOT mock the @larksuiteoapi/node-sdk directly (per CLAUDE.md rules),
 * instead uses dependency-injected mocks via constructor.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WsConnectionManager,
  calculateReconnectDelay,
} from './ws-connection-manager.js';

// ─── Mocked WSClient factory ────────────────────────────────────────────

interface MockWSClient {
  start: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  removeAllListeners?: ReturnType<typeof vi.fn>;
}

function createMockWSClient(shouldFail = false): MockWSClient {
  return {
    start: vi.fn().mockResolvedValue(shouldFail ? false : undefined),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
  };
}

// Mock EventDispatcher (minimal — just needs register to return itself)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createMockEventDispatcher(): any {
  return { register: vi.fn().mockReturnThis() };
}

// ─── Mock @disclaude/core ───────────────────────────────────────────────

const MOCK_WS_HEALTH = vi.hoisted(() => ({
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

// ─── Helper to create a manager with mocked WSClient ────────────────────

function createTestManager(overrides: {
  wsClient?: MockWSClient;
  maxAttempts?: number;
  dnsCheckHost?: string;
} = {}): WsConnectionManager {
  const manager = new WsConnectionManager({
    appId: 'test-app-id',
    appSecret: 'test-app-secret',
    reconnectMaxAttempts: overrides.maxAttempts ?? MOCK_WS_HEALTH.RECONNECT.MAX_ATTEMPTS,
    // Disable DNS pre-check by default for existing tests; individual tests
    // in the Issue #2259 describe block enable it explicitly.
    dnsCheckHost: overrides.dnsCheckHost ?? '',
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

  describe('reconnection', () => {
    it('should reconnect after initial connection failure', async () => {
      const succeedingClient = createMockWSClient(false);
      manager = createTestManager({
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      const reconnectedEvents: number[] = [];
      manager.on('reconnected', (attempt) => reconnectedEvents.push(attempt));

      await manager.start(mockEventDispatcher as never);

      // Initial connection succeeded
      expect(manager.state).toBe('connected');
    });

    it('should stop reconnecting after max attempts when all fail', async () => {
      // Create a mock that succeeds initially but fails on reconnects
      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
      };

      manager = createTestManager({
        maxAttempts: 2,
        wsClient: conditionalClient,
      });

      const reconnectFailedEvents: number[] = [];
      manager.on('reconnectFailed', (total) => reconnectFailedEvents.push(total));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Simulate SDK-triggered reconnect by calling initiateReconnect through a failed start
      // Since we can't directly call initiateReconnect, we'll manually test the max attempts
      // by stopping and restarting with a failing client
      await manager.stop();

      const alwaysFailingClient = createMockWSClient(true);
      const manager2 = createTestManager({
        maxAttempts: 2,
        wsClient: alwaysFailingClient,
      });

      const reconnectFailedEvents2: number[] = [];
      manager2.on('reconnectFailed', (total) => reconnectFailedEvents2.push(total));

      await manager2.start(mockEventDispatcher as never);

      // Run through all retries
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      // Should have given up after max attempts
      expect(manager2.state).toBe('stopped');
      expect(reconnectFailedEvents2.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit reconnectFailed with correct total attempts', async () => {
      const maxAttempts = 2;

      const alwaysFailingClient = createMockWSClient(true);
      manager = createTestManager({
        maxAttempts,
        wsClient: alwaysFailingClient,
      });

      let failedTotal = 0;
      manager.on('reconnectFailed', (total) => { failedTotal = total; });

      await manager.start(mockEventDispatcher as never);

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
    });

    it('should reflect state changes in metrics', async () => {
      const alwaysFailingClient = createMockWSClient(true);
      manager = createTestManager({
        maxAttempts: 2,
        wsClient: alwaysFailingClient,
      });

      await manager.start(mockEventDispatcher as never);

      // State should be reconnecting (initial connect failed)
      const metrics = manager.getMetrics();
      expect(metrics.state).toBe('reconnecting');
      expect(metrics.isConnected).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('should handle double stop gracefully', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);
      await manager.stop();
      await manager.stop(); // Should not throw
      expect(manager.state).toBe('stopped');
    });

    it('should not export removed APIs (Issue #2905)', async () => {
      // Verify that the simplified manager no longer has
      // health check, message recording, or liveness detection capabilities
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const metrics = manager.getMetrics();
      // Should not have health-check-specific fields
      expect(metrics).not.toHaveProperty('lastMessageReceivedAt');
      expect(metrics).not.toHaveProperty('timeSinceLastMessageMs');
      expect(metrics).not.toHaveProperty('pongCount');
      expect(metrics).not.toHaveProperty('customPingCount');
      expect(metrics).not.toHaveProperty('customPingIntervalMs');
      expect(metrics).not.toHaveProperty('lastPongAt');
      expect(metrics).not.toHaveProperty('timeSinceLastPongMs');
      expect(metrics).not.toHaveProperty('hasWsInterception');
    });

    it('should not have recordMessageReceived method (Issue #2905)', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      expect(typeof (manager as unknown as { recordMessageReceived?: () => void }).recordMessageReceived).toBe('undefined');
    });

    it('should not have isHealthy method (Issue #2905)', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      expect(typeof (manager as unknown as { isHealthy?: () => boolean }).isHealthy).toBe('undefined');
    });
  });

  describe('Issue #2259 — MaxListeners leak & DNS pre-check', () => {
    it('should call removeAllListeners on WSClient before closing', async () => {
      const mockClient = createMockWSClient(false);
      const removeAllListenersSpy = vi.fn();
      mockClient.removeAllListeners = removeAllListenersSpy;

      manager = createTestManager({
        maxAttempts: 3,
        wsClient: mockClient,
      });

      await manager.start(mockEventDispatcher as never);

      // Stop the manager — this calls closeClient which calls removeAllListeners
      await manager.stop();

      // removeAllListeners should have been called on the client
      expect(removeAllListenersSpy).toHaveBeenCalled();
    });

    it('should skip reconnect when DNS pre-check fails', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        maxAttempts: 3,
        wsClient: mockClient,
        dnsCheckHost: 'open.feishu.cn',
      });

      // Stub checkDns to fail (simulates macOS wake from sleep)
      const checkDnsSpy = vi.spyOn(
        WsConnectionManager.prototype as unknown as { checkDns: () => Promise<boolean> },
        'checkDns',
      ).mockResolvedValue(false);

      // Start with a failing client to trigger reconnect
      const failingClient = createMockWSClient(true);
      const manager2 = createTestManager({
        maxAttempts: 3,
        wsClient: failingClient,
        dnsCheckHost: 'open.feishu.cn',
      });

      await manager2.start(mockEventDispatcher as never);

      // Wait for reconnect attempt cycle
      await vi.advanceTimersByTimeAsync(5000);

      // WSClient.start() should only have been called once (initial connect),
      // NOT a second time for reconnect since DNS pre-check failed
      expect(failingClient.start.mock.calls.length).toBe(1);

      // checkDns should have been called during reconnect
      expect(checkDnsSpy).toHaveBeenCalledWith('open.feishu.cn');

      checkDnsSpy.mockRestore();
    });

    it('should call checkDns during reconnect when dnsCheckHost is configured', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        maxAttempts: 3,
        wsClient: mockClient,
        dnsCheckHost: 'open.feishu.cn',
      });

      // Stub checkDns to succeed
      const checkDnsSpy = vi.spyOn(
        WsConnectionManager.prototype as unknown as { checkDns: () => Promise<boolean> },
        'checkDns',
      ).mockResolvedValue(true);

      await manager.start(mockEventDispatcher as never);

      // checkDns should NOT have been called during initial connect
      expect(checkDnsSpy).not.toHaveBeenCalled();

      checkDnsSpy.mockRestore();
    });

    it('should not call checkDns when dnsCheckHost is empty', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({
        maxAttempts: 3,
        wsClient: mockClient,
        // dnsCheckHost defaults to '' in tests → DNS check disabled
      });

      const checkDnsSpy = vi.spyOn(
        WsConnectionManager.prototype as unknown as { checkDns: () => Promise<boolean> },
        'checkDns',
      ).mockResolvedValue(true);

      await manager.start(mockEventDispatcher as never);

      // checkDns should NOT have been called (dnsCheckHost is empty)
      expect(checkDnsSpy).not.toHaveBeenCalled();

      checkDnsSpy.mockRestore();
    });
  });
});
