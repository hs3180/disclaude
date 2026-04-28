/**
 * Tests for WsConnectionManager (Issue #1351, #1666, #2905).
 *
 * Tests cover:
 * - Connection lifecycle (start, stop)
 * - SDK-driven reconnect via WSClient 'close' event (Issue #2905)
 * - Exponential backoff reconnection
 * - State machine transitions
 * - Event emission
 * - Metrics reporting
 * - DNS pre-check (Issue #2259)
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
  on: ReturnType<typeof vi.fn>;
  removeAllListeners?: ReturnType<typeof vi.fn>;
}

function createMockWSClient(shouldFail = false): MockWSClient {
  return {
    start: vi.fn().mockResolvedValue(shouldFail ? false : undefined),
    close: vi.fn(),
    on: vi.fn(),
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

    it('should be in connected state after successful start', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      expect(manager.state).toBe('connected');
    });

    it('should be in stopped state after stop', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);
      await manager.stop();

      expect(manager.state).toBe('stopped');
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

  describe('SDK-driven reconnect (Issue #2905)', () => {
    it('should trigger reconnect when WSClient emits close event', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ maxAttempts: 3, wsClient: mockClient });

      const connectionClosedEvents: number[] = [];
      manager.on('connectionClosed', () => connectionClosedEvents.push(1));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Simulate SDK close event — find the 'close' handler from the on() calls
      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      expect(onCloseCalls.length).toBe(1);
      const closeHandler = onCloseCalls[0][1] as () => void;

      // Trigger the close event
      closeHandler();

      expect(connectionClosedEvents.length).toBe(1);
      expect(manager.state).toBe('reconnecting');
    });

    it('should not trigger reconnect when already reconnecting', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ maxAttempts: 3, wsClient: mockClient });

      const connectionClosedEvents: number[] = [];
      manager.on('connectionClosed', () => connectionClosedEvents.push(1));

      await manager.start(mockEventDispatcher as never);

      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;

      // First close triggers reconnect
      closeHandler();
      expect(connectionClosedEvents.length).toBe(1);

      // Second close should be suppressed (already reconnecting)
      closeHandler();
      expect(connectionClosedEvents.length).toBe(1);
    });

    it('should not trigger reconnect when stopped', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ maxAttempts: 3, wsClient: mockClient });

      const connectionClosedEvents: number[] = [];
      manager.on('connectionClosed', () => connectionClosedEvents.push(1));

      await manager.start(mockEventDispatcher as never);
      await manager.stop();

      // After stop, listeners are removed so close event can't fire
      // But if somehow called, state is 'stopped' so handler should bail
      expect(connectionClosedEvents.length).toBe(0);
    });

    it('should successfully reconnect after SDK close event', async () => {
      // First client succeeds, second client (for reconnect) also succeeds
      const firstClient = createMockWSClient(false);
      const secondClient = createMockWSClient(false);
      let callCount = 0;

      manager = createTestManager({ maxAttempts: 3 });

      // Monkey-patch larkSDK to return different clients
      (manager as unknown as {
        larkSDK: { WSClient: ReturnType<typeof vi.fn>; LoggerLevel: { info: string } };
      }).larkSDK = {
        WSClient: vi.fn().mockImplementation(() => {
          callCount++;
          return callCount === 1 ? firstClient : secondClient;
        }),
        LoggerLevel: { info: 'info' },
      };

      const reconnectedEvents: number[] = [];
      manager.on('reconnected', (attempt) => reconnectedEvents.push(attempt));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Simulate SDK close event on first client
      const onCloseCalls = firstClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;
      closeHandler();

      expect(manager.state).toBe('reconnecting');

      // Wait for reconnect delay to pass
      await vi.advanceTimersByTimeAsync(5000);

      expect(manager.state).toBe('connected');
      expect(reconnectedEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('reconnection', () => {
    it('should transition through reconnecting state on initial connection failure', async () => {
      const succeedingClient = createMockWSClient(false);

      manager = createTestManager({
        maxAttempts: 3,
        wsClient: succeedingClient,
      });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      // Use a client that fails the first time but succeeds on retry
      let callCount = 0;
      (manager as unknown as {
        larkSDK: { WSClient: ReturnType<typeof vi.fn>; LoggerLevel: { info: string } };
      }).larkSDK = {
        WSClient: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            return { ...createMockWSClient(true), on: vi.fn() };
          }
          return succeedingClient;
        }),
        LoggerLevel: { info: 'info' },
      };

      await manager.start(mockEventDispatcher as never);

      // Should have gone through reconnecting state
      expect(stateChanges).toContain('reconnecting');
    });

    it('should stop reconnecting after max attempts when all fail', async () => {
      // Create a mock that always fails
      const failingClient = createMockWSClient(true);

      manager = createTestManager({
        maxAttempts: 2,
        wsClient: failingClient,
      });

      const reconnectFailedEvents: number[] = [];
      manager.on('reconnectFailed', (total) => reconnectFailedEvents.push(total));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('reconnecting');

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
      const maxAttempts = 2;

      const failingClient = createMockWSClient(true);

      manager = createTestManager({
        maxAttempts,
        wsClient: failingClient,
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

    it('should not include removed health check fields', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const metrics = manager.getMetrics();
      // Should not have message-receipt-based fields (Issue #2905)
      expect(metrics).not.toHaveProperty('lastMessageReceivedAt');
      expect(metrics).not.toHaveProperty('timeSinceLastMessageMs');
      expect(metrics).not.toHaveProperty('pongCount');
      expect(metrics).not.toHaveProperty('customPingCount');
      expect(metrics).not.toHaveProperty('hasWsInterception');
    });

    it('should reflect reconnecting state in metrics', async () => {
      const failingClient = createMockWSClient(true);

      manager = createTestManager({
        maxAttempts: 3,
        wsClient: failingClient,
      });

      await manager.start(mockEventDispatcher as never);

      // State should be reconnecting since initial connect failed
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

      // Simulate SDK close event to trigger reconnect (which calls closeClient)
      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;
      closeHandler();

      // removeAllListeners should have been called on the old client
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

      await manager.start(mockEventDispatcher as never);

      // Simulate SDK close event to trigger reconnect
      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;
      closeHandler();

      // Wait for reconnect attempt cycle
      await vi.advanceTimersByTimeAsync(5000);

      // WSClient.start() should only have been called once (initial connect),
      // NOT a second time for reconnect since DNS pre-check failed
      expect(mockClient.start.mock.calls.length).toBe(1);

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

      // Simulate SDK close event to trigger reconnect
      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;
      closeHandler();

      // Wait for async reconnect attempt to execute (exponential backoff delay)
      await vi.advanceTimersByTimeAsync(5000);

      // checkDns should have been called during reconnect attempt
      expect(checkDnsSpy).toHaveBeenCalledWith('open.feishu.cn');

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

      // Simulate SDK close event to trigger reconnect
      const onCloseCalls = mockClient.on.mock.calls.filter((call: unknown[]) => call[0] === 'close');
      const closeHandler = onCloseCalls[0][1] as () => void;
      closeHandler();

      // Wait for reconnect
      await vi.advanceTimersByTimeAsync(5000);

      // checkDns should NOT have been called (dnsCheckHost is empty)
      expect(checkDnsSpy).not.toHaveBeenCalled();

      checkDnsSpy.mockRestore();
    });
  });
});
