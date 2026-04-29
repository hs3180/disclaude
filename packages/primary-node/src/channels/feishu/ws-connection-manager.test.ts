/**
 * Tests for WsConnectionManager (Issue #1351, #1666, #2905).
 *
 * Tests cover:
 * - Connection lifecycle (start, stop)
 * - SDK event-triggered reconnection (error/close events)
 * - Exponential backoff reconnection
 * - State machine transitions
 * - Event emission
 * - Metrics reporting
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
  on: ReturnType<typeof vi.fn>;
  // Store event handlers for triggering in tests
  _handlers?: Record<string, (...args: unknown[]) => void>;
}

function createMockWSClient(shouldFail = false): MockWSClient {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  const client: MockWSClient = {
    start: vi.fn().mockResolvedValue(shouldFail ? false : undefined),
    close: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
      handlers[event] = handler;
    }),
    _handlers: handlers,
  };
  return client;
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

  describe('SDK event-triggered reconnection (Issue #2905)', () => {
    it('should initiate reconnect on SDK error event', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Simulate SDK error event
      const errorHandler = mockClient._handlers?.['error'];
      expect(errorHandler).toBeDefined();
      errorHandler?.(new Error('connection lost'));

      // Should have transitioned to reconnecting
      expect(stateChanges).toContain('reconnecting');
    });

    it('should initiate reconnect on SDK close event', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Simulate SDK close event
      const closeHandler = mockClient._handlers?.['close'];
      expect(closeHandler).toBeDefined();
      closeHandler?.('1000', 'normal closure');

      // Should have transitioned to reconnecting
      expect(stateChanges).toContain('reconnecting');
    });

    it('should emit sdkError event on SDK error', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const sdkErrors: unknown[] = [];
      manager.on('sdkError', (error) => sdkErrors.push(error));

      await manager.start(mockEventDispatcher as never);

      const testError = new Error('test error');
      mockClient._handlers?.['error']?.(testError);

      expect(sdkErrors.length).toBe(1);
      expect(sdkErrors[0]).toBe(testError);
    });

    it('should emit sdkClose event on SDK close', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const sdkCloseEvents: Array<{ code?: string; reason?: string }> = [];
      manager.on('sdkClose', (code?, reason?) => sdkCloseEvents.push({ code, reason }));

      await manager.start(mockEventDispatcher as never);

      mockClient._handlers?.['close']?.('1006', 'abnormal closure');

      expect(sdkCloseEvents.length).toBe(1);
      expect(sdkCloseEvents[0].code).toBe('1006');
      expect(sdkCloseEvents[0].reason).toBe('abnormal closure');
    });

    it('should not initiate reconnect when already reconnecting', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);

      // First error triggers reconnect
      mockClient._handlers?.['error']?.(new Error('error 1'));
      expect(stateChanges.filter(s => s === 'reconnecting').length).toBe(1);

      // Second error while already reconnecting — should not trigger again
      mockClient._handlers?.['error']?.(new Error('error 2'));
      expect(stateChanges.filter(s => s === 'reconnecting').length).toBe(1);
    });

    it('should not initiate reconnect when stopped', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);
      await manager.stop();

      // Error event on stopped manager should not trigger reconnect
      mockClient._handlers?.['error']?.(new Error('error after stop'));
      expect(stateChanges).not.toContain('reconnecting');
    });
  });

  describe('reconnection', () => {
    it('should successfully reconnect after SDK error', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const reconnectedEvents: number[] = [];
      manager.on('reconnected', (attempt) => reconnectedEvents.push(attempt));

      await manager.start(mockEventDispatcher as never);

      // Trigger reconnect via SDK error event
      mockClient._handlers?.['error']?.(new Error('connection lost'));

      // Wait for reconnect delay to pass
      await vi.advanceTimersByTimeAsync(5000);

      // Should have reconnected
      expect(manager.state).toBe('connected');
      expect(reconnectedEvents.length).toBeGreaterThanOrEqual(1);
    });

    it('should transition through reconnecting state on SDK close', async () => {
      const mockClient = createMockWSClient(false);
      manager = createTestManager({ wsClient: mockClient, maxAttempts: 3 });

      const stateChanges: string[] = [];
      manager.on('stateChange', (state) => stateChanges.push(state));

      await manager.start(mockEventDispatcher as never);

      // Trigger reconnect via SDK close event
      mockClient._handlers?.['close']?.('1006', 'abnormal');

      // Should have gone through reconnecting state
      expect(stateChanges).toContain('reconnecting');

      // After reconnect succeeds, should be connected again
      await vi.advanceTimersByTimeAsync(5000);
      expect(stateChanges.filter(s => s === 'connected').length).toBeGreaterThanOrEqual(2);
    });

    it('should stop reconnecting after max attempts when all fail', async () => {
      // Create a mock that succeeds initially but fails on reconnects
      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
        on: vi.fn(),
        _handlers: {},
      };
      conditionalClient.on = vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (conditionalClient._handlers) {conditionalClient._handlers[event] = handler;}
      });

      manager = createTestManager({
        maxAttempts: 2,
        wsClient: conditionalClient,
      });

      const reconnectFailedEvents: number[] = [];
      manager.on('reconnectFailed', (total) => reconnectFailedEvents.push(total));

      await manager.start(mockEventDispatcher as never);
      expect(manager.state).toBe('connected');

      // Trigger reconnect via SDK error
      conditionalClient._handlers?.['error']?.(new Error('connection lost'));

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

      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
        on: vi.fn(),
        _handlers: {},
      };
      conditionalClient.on = vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (conditionalClient._handlers) {conditionalClient._handlers[event] = handler;}
      });

      manager = createTestManager({
        maxAttempts,
        wsClient: conditionalClient,
      });

      let failedTotal = 0;
      manager.on('reconnectFailed', (total) => { failedTotal = total; });

      await manager.start(mockEventDispatcher as never);

      // Trigger reconnect via SDK error
      conditionalClient._handlers?.['error']?.(new Error('connection lost'));

      // Run through all retries
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(2000);
      }

      expect(failedTotal).toBeGreaterThanOrEqual(maxAttempts);
    });
  });

  describe('metrics', () => {
    it('should return correct metrics after start', async () => {
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const metrics = manager.getMetrics();
      expect(metrics.state).toBe('connected');
      expect(metrics.isConnected).toBe(true);
      expect(metrics.reconnectAttempt).toBe(0);
    });

    it('should reflect reconnecting state in metrics', async () => {
      const conditionalClient: MockWSClient = {
        start: vi.fn().mockImplementationOnce(() => Promise.resolve(undefined))
          .mockImplementation(() => Promise.resolve(false)),
        close: vi.fn(),
        on: vi.fn(),
        _handlers: {},
      };
      conditionalClient.on = vi.fn().mockImplementation((event: string, handler: (...args: unknown[]) => void) => {
        if (conditionalClient._handlers) {conditionalClient._handlers[event] = handler;}
      });

      manager = createTestManager({ wsClient: conditionalClient, maxAttempts: 3 });

      await manager.start(mockEventDispatcher as never);

      // Before any reconnect
      const metricsBefore = manager.getMetrics();
      expect(metricsBefore.state).toBe('connected');

      // Trigger reconnect via SDK error
      conditionalClient._handlers?.['error']?.(new Error('connection lost'));

      // State is at least reconnecting or already reconnected
      const metricsDuring = manager.getMetrics();
      expect(['reconnecting', 'connected']).toContain(metricsDuring.state);
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

    it('should not export removed APIs (Issue #1666, #2905)', async () => {
      // Verify that the simplified manager no longer has
      // custom ping loop, pong detection, WS interception, or health check capabilities
      manager = createTestManager();
      await manager.start(mockEventDispatcher as never);

      const metrics = manager.getMetrics();
      // Should not have pong/ping-specific fields
      expect(metrics).not.toHaveProperty('pongCount');
      expect(metrics).not.toHaveProperty('customPingCount');
      expect(metrics).not.toHaveProperty('customPingIntervalMs');
      expect(metrics).not.toHaveProperty('lastPongAt');
      expect(metrics).not.toHaveProperty('timeSinceLastPongMs');
      expect(metrics).not.toHaveProperty('hasWsInterception');
      // Should not have health check fields (removed in Issue #2905)
      expect(metrics).not.toHaveProperty('lastMessageReceivedAt');
      expect(metrics).not.toHaveProperty('timeSinceLastMessageMs');
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

      // Trigger reconnect via SDK error (which calls closeClient)
      mockClient._handlers?.['error']?.(new Error('connection lost'));

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

      // Trigger reconnect via SDK error
      mockClient._handlers?.['error']?.(new Error('connection lost'));

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

      // Trigger reconnect via SDK error
      mockClient._handlers?.['error']?.(new Error('connection lost'));

      // Wait for reconnect delay
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

      // Trigger reconnect via SDK error
      mockClient._handlers?.['error']?.(new Error('connection lost'));

      // Wait for reconnect
      await vi.advanceTimersByTimeAsync(5000);

      // checkDns should NOT have been called (dnsCheckHost is empty)
      expect(checkDnsSpy).not.toHaveBeenCalled();

      checkDnsSpy.mockRestore();
    });
  });
});
