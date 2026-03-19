/**
 * WebSocket Connection Health Monitor & Auto-Reconnect Manager.
 *
 * Addresses Issue #1351: NAT/firewall silently drops WebSocket connections while
 * the SDK's pingLoop only sends Pings without checking Pong responses, leaving
 * readyState as OPEN with no messages flowing.
 *
 * This module wraps the Feishu SDK's WSClient lifecycle with:
 * - **Health detection**: Tracks last-message-received timestamp to detect zombie connections
 * - **Auto-reconnect**: Exponential backoff with jitter when dead connections are detected
 * - **Connection state machine**: Explicit state tracking (connected, reconnecting, stopped)
 * - **Observability**: Emits events and logs for connection lifecycle monitoring
 *
 * Offline message queue is managed at the FeishuChannel level. The manager emits
 * events that FeishuChannel can listen to for queue management.
 *
 * Usage:
 * ```typescript
 * const manager = new WsConnectionManager({ appId, appSecret });
 * manager.on('stateChange', (state) => logger.info({ state }, 'Connection state'));
 * await manager.start(eventDispatcher);
 * manager.recordMessageReceived(); // Call from message handler
 * await manager.stop();
 * ```
 *
 * @module channels/feishu/ws-connection-manager
 * @see https://github.com/hs3180/disclaude/issues/1351
 */

import { EventEmitter } from 'events';
import { WS_HEALTH, createLogger } from '@disclaude/core';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as lark from '@larksuiteoapi/node-sdk';

const logger = createLogger('WsConnectionManager');

/**
 * WebSocket connection states.
 */
export type WsConnectionState = 'connected' | 'reconnecting' | 'stopped';

/**
 * Event map for WsConnectionManager.
 *
 * Node.js EventEmitter generic expects values to be tuples (argument arrays),
 * not callback types.
 */
export interface WsConnectionManagerEvents {
  /** Connection state changed */
  stateChange: [state: WsConnectionState];
  /** Connection is healthy (recorded server message receipt) */
  heartbeat: [lastReceived: number];
  /** Dead connection detected, initiating reconnect */
  deadConnection: [elapsedMs: number];
  /** Reconnect attempt succeeded */
  reconnected: [attempt: number];
  /** All reconnect attempts exhausted */
  reconnectFailed: [totalAttempts: number];
}

/**
 * Configuration for WsConnectionManager.
 */
export interface WsConnectionManagerConfig {
  /** Feishu App ID */
  appId: string;
  /** Feishu App Secret */
  appSecret: string;
  /**
   * Logger for the Feishu SDK's WSClient.
   * Defaults to routing through the manager's own logger.
   */
  sdkLogger?: {
    error: (...msg: unknown[]) => void;
    warn: (...msg: unknown[]) => void;
    info: (...msg: unknown[]) => void;
    debug: (...msg: unknown[]) => void;
    trace: (...msg: unknown[]) => void;
  };
  /**
   * SDK logger level.
   * @default lark.LoggerLevel.info
   */
  sdkLogLevel?: lark.LoggerLevel;
  /** Override dead connection timeout (ms) */
  deadConnectionTimeoutMs?: number;
  /** Override health check interval (ms) */
  healthCheckIntervalMs?: number;
  /** Override reconnect base delay (ms) */
  reconnectBaseDelayMs?: number;
  /** Override reconnect max delay cap (ms) */
  reconnectMaxDelayMs?: number;
  /** Override reconnect max attempts (-1 = infinite) */
  reconnectMaxAttempts?: number;
}

/**
 * Calculate delay with exponential backoff and random jitter.
 *
 * Formula: `delay = min(baseDelay × 2^attempt + random(0, jitterMs), maxDelay)`
 *
 * Prevents thundering herd when many clients reconnect simultaneously.
 *
 * @param attempt - Zero-based attempt number
 * @param baseDelayMs - Base delay in milliseconds
 * @param maxDelayMs - Maximum delay cap in milliseconds
 * @param jitterMs - Maximum random jitter in milliseconds [0, jitterMs)
 * @returns Delay in milliseconds before next reconnect attempt
 */
export function calculateReconnectDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitterMs: number,
): number {
  const exponentialDelay = baseDelayMs * Math.pow(WS_HEALTH.RECONNECT.BACKOFF_MULTIPLIER, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  const jitter = Math.floor(Math.random() * jitterMs);
  return cappedDelay + jitter;
}

/**
 * Default SDK logger that routes through the manager's pino logger.
 */
function createDefaultSdkLogger(): {
  error: (...msg: unknown[]) => void;
  warn: (...msg: unknown[]) => void;
  info: (...msg: unknown[]) => void;
  debug: (...msg: unknown[]) => void;
  trace: (...msg: unknown[]) => void;
} {
  return {
    error: (...msg: unknown[]) => logger.error({ context: 'LarkSDK' }, String(msg)),
    warn: (...msg: unknown[]) => logger.warn({ context: 'LarkSDK' }, String(msg)),
    info: (...msg: unknown[]) => logger.info({ context: 'LarkSDK' }, String(msg)),
    debug: (...msg: unknown[]) => logger.debug({ context: 'LarkSDK' }, String(msg)),
    trace: (...msg: unknown[]) => logger.trace({ context: 'LarkSDK' }, String(msg)),
  };
}

/**
 * WebSocket Connection Manager.
 *
 * Wraps the Feishu SDK's WSClient to add zombie connection detection and
 * exponential-backoff reconnection.
 *
 * ### How it works
 *
 * 1. **Start**: Creates a WSClient and registers the provided EventDispatcher.
 *    Starts a periodic health check timer.
 *
 * 2. **Health check**: Every `healthCheckIntervalMs`, compares the current time
 *    against `lastMessageReceivedAt`. If the gap exceeds `deadConnectionTimeoutMs`,
 *    the connection is deemed dead.
 *
 * 3. **Dead connection → reconnect**: Closes the current WSClient (force terminate),
 *    then schedules a new connection attempt after an exponentially increasing delay.
 *
 * 4. **Message tracking**: The FeishuChannel (or any caller) must invoke
 *    `recordMessageReceived()` whenever a WebSocket event is dispatched. This is
 *    the mechanism for liveness detection since the SDK's internal WebSocket `on('message')`
 *    handler is private.
 *
 * 5. **Reconnect flow**: On each failure, delay doubles (capped at `maxDelayMs`) with
 *    random jitter. If `maxAttempts` is reached, the manager transitions to 'stopped'.
 *
 * ### Integration with FeishuChannel
 *
 * - FeishuChannel creates a WsConnectionManager and calls `start()` instead of
 *   directly creating a WSClient.
 * - FeishuChannel calls `recordMessageReceived()` from its event handlers.
 * - FeishuChannel listens for `stateChange` and `reconnected` events to manage
 *   its own offline message queue.
 */
export class WsConnectionManager extends EventEmitter<WsConnectionManagerEvents> {
  private readonly config: WsConnectionManagerConfig;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private wsClient?: any;
  private eventDispatcher?: lark.EventDispatcher;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly larkSDK: any;

  // State machine
  private _state: WsConnectionState = 'stopped';

  // Health monitoring
  private lastMessageReceivedAt: number = 0;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private readonly deadConnectionTimeoutMs: number;
  private readonly healthCheckIntervalMs: number;

  // Reconnect state
  private reconnectAttempt: number = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private isReconnecting: boolean = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMaxAttempts: number;

  constructor(config: WsConnectionManagerConfig) {
    super();
    this.config = config;

    // Reference the lark namespace for creating WSClient instances
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    this.larkSDK = lark;

    // Resolve configuration with defaults from constants
    this.deadConnectionTimeoutMs = config.deadConnectionTimeoutMs
      ?? WS_HEALTH.DEAD_CONNECTION_TIMEOUT_MS;
    this.healthCheckIntervalMs = config.healthCheckIntervalMs
      ?? WS_HEALTH.HEALTH_CHECK_INTERVAL_MS;
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs
      ?? WS_HEALTH.RECONNECT.BASE_DELAY_MS;
    this.reconnectMaxDelayMs = config.reconnectMaxDelayMs
      ?? WS_HEALTH.RECONNECT.MAX_DELAY_MS;
    this.reconnectMaxAttempts = config.reconnectMaxAttempts
      ?? WS_HEALTH.RECONNECT.MAX_ATTEMPTS;

    logger.info(
      {
        deadConnectionTimeoutMs: this.deadConnectionTimeoutMs,
        healthCheckIntervalMs: this.healthCheckIntervalMs,
        reconnectBaseDelayMs: this.reconnectBaseDelayMs,
        reconnectMaxDelayMs: this.reconnectMaxDelayMs,
        reconnectMaxAttempts: this.reconnectMaxAttempts,
      },
      'WsConnectionManager created',
    );
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Get current connection state.
   */
  get state(): WsConnectionState {
    return this._state;
  }

  /**
   * Get connection health metrics for observability / monitoring.
   */
  getMetrics(): {
    state: WsConnectionState;
    lastMessageReceivedAt: number;
    timeSinceLastMessageMs: number;
    reconnectAttempt: number;
    isConnected: boolean;
  } {
    return {
      state: this._state,
      lastMessageReceivedAt: this.lastMessageReceivedAt,
      timeSinceLastMessageMs: this.lastMessageReceivedAt > 0
        ? Date.now() - this.lastMessageReceivedAt
        : 0,
      reconnectAttempt: this.reconnectAttempt,
      isConnected: this._state === 'connected',
    };
  }

  /**
   * Start the WebSocket connection with health monitoring.
   *
   * If the initial connection fails, initiates the reconnect flow
   * (same exponential backoff strategy as dead connection recovery).
   *
   * @param eventDispatcher - Feishu SDK EventDispatcher for handling events
   */
  async start(eventDispatcher: lark.EventDispatcher): Promise<void> {
    this.eventDispatcher = eventDispatcher;
    const success = await this.connectFresh();

    if (!success) {
      // Initial connection failed — start reconnect flow
      logger.warn('Initial connection failed, entering reconnect mode');
      this.initiateReconnect();
    }

    // Always start health monitoring (needed even after reconnect to detect future dead connections)
    this.startHealthCheck();
  }

  /**
   * Stop the connection manager and clean up all resources.
   */
  async stop(): Promise<void> {
    logger.info('WsConnectionManager stopping');

    // Cancel periodic health check
    this.stopHealthCheck();

    // Cancel pending reconnect timer
    this.clearReconnectTimer();

    // Close WSClient
    this.closeClient();

    // Reset state
    this.transitionTo('stopped');
    this.isReconnecting = false;
    this.reconnectAttempt = 0;

    logger.info('WsConnectionManager stopped');
  }

  /**
   * Record that a message was received from the server.
   *
   * **Must** be called by the FeishuChannel (or event handler) whenever any
   * WebSocket event is dispatched. This is the liveness signal for health
   * monitoring — without it, the manager cannot detect dead connections.
   */
  recordMessageReceived(): void {
    this.lastMessageReceivedAt = Date.now();
    this.emit('heartbeat', this.lastMessageReceivedAt);
  }

  /**
   * Check if the connection is currently healthy.
   *
   * A connection is healthy when:
   * - State is 'connected', AND
   * - Either no message has been received yet (grace period after connect),
   *   or the last message was received within `deadConnectionTimeoutMs`.
   */
  isHealthy(): boolean {
    if (this._state !== 'connected') {
      return false;
    }
    // Grace period: if we just connected and haven't received anything yet
    if (this.lastMessageReceivedAt === 0) {
      return true;
    }
    const elapsed = Date.now() - this.lastMessageReceivedAt;
    return elapsed < this.deadConnectionTimeoutMs;
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Create a fresh WSClient and connect.
   *
   * @returns `true` if connection succeeded
   */
  private async connectFresh(): Promise<boolean> {
    const sdkLogger = this.config.sdkLogger ?? createDefaultSdkLogger();

    try {
      this.wsClient = new this.larkSDK.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        logger: sdkLogger,
        loggerLevel: this.config.sdkLogLevel ?? this.larkSDK.LoggerLevel.info,
      });

      if (!this.eventDispatcher) {
        throw new Error('EventDispatcher not set');
      }

      const startResult = await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

      // SDK may resolve to false (instead of throwing) when connection fails
      if (startResult === false) {
        throw new Error('WSClient.start() returned false');
      }

      // Start grace period — consider the connection alive from now
      this.lastMessageReceivedAt = Date.now();
      this.reconnectAttempt = 0;
      this.transitionTo('connected');

      logger.info('WebSocket connection established');
      return true;
    } catch (error) {
      logger.error({ err: error, attempt: this.reconnectAttempt }, 'Failed to establish WebSocket connection');
      this.closeClient();
      return false;
    }
  }

  /**
   * Force-close the current WSClient.
   */
  private closeClient(): void {
    if (this.wsClient) {
      try {
        this.wsClient.close({ force: true });
      } catch (error) {
        logger.debug({ err: error }, 'Error while closing WSClient');
      }
      this.wsClient = undefined;
    }
  }

  // ─── Health monitoring ───────────────────────────────────────────────────

  /**
   * Start the periodic health check loop.
   */
  private startHealthCheck(): void {
    this.stopHealthCheck();

    this.healthCheckTimer = setInterval(() => {
      this.runHealthCheck();
    }, this.healthCheckIntervalMs);

    // Don't hold the process open
    if (this.healthCheckTimer.unref) {
      this.healthCheckTimer.unref();
    }

    logger.debug(
      { intervalMs: this.healthCheckIntervalMs, timeoutMs: this.deadConnectionTimeoutMs },
      'Health check timer started',
    );
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
  }

  /**
   * Single health check iteration.
   *
   * If no server message has been received within the timeout window,
   * the connection is considered dead and reconnection is triggered.
   */
  private runHealthCheck(): void {
    if (this._state !== 'connected' || this.isReconnecting) {
      return;
    }

    // Grace period: haven't received anything yet since connect
    if (this.lastMessageReceivedAt === 0) {
      return;
    }

    const elapsed = Date.now() - this.lastMessageReceivedAt;

    if (elapsed >= this.deadConnectionTimeoutMs) {
      logger.warn(
        {
          elapsedMs: elapsed,
          timeoutMs: this.deadConnectionTimeoutMs,
          reconnectAttempt: this.reconnectAttempt,
        },
        'Dead connection detected — no server messages received within timeout',
      );

      this.emit('deadConnection', elapsed);
      this.initiateReconnect();
    }
  }

  // ─── Reconnection ────────────────────────────────────────────────────────

  /**
   * Begin the reconnect sequence with exponential backoff + jitter.
   */
  private initiateReconnect(): void {
    if (this.isReconnecting) {
      logger.debug('Reconnect already in progress, skipping');
      return;
    }

    this.isReconnecting = true;
    this.transitionTo('reconnecting');

    // Terminate the dead connection
    this.closeClient();

    // Schedule the first reconnect attempt
    this.scheduleReconnectAttempt();
  }

  /**
   * Schedule the next reconnect attempt after a backoff delay.
   */
  private scheduleReconnectAttempt(): void {
    this.clearReconnectTimer();

    // Check if max attempts exceeded
    if (this.reconnectMaxAttempts >= 0 && this.reconnectAttempt >= this.reconnectMaxAttempts) {
      logger.error(
        { attempt: this.reconnectAttempt, maxAttempts: this.reconnectMaxAttempts },
        'Max reconnect attempts exhausted',
      );
      this.isReconnecting = false;
      this.transitionTo('stopped');
      this.emit('reconnectFailed', this.reconnectAttempt);
      return;
    }

    const delay = calculateReconnectDelay(
      this.reconnectAttempt,
      this.reconnectBaseDelayMs,
      this.reconnectMaxDelayMs,
      WS_HEALTH.RECONNECT.JITTER_MS,
    );

    logger.info(
      { attempt: this.reconnectAttempt, delayMs: delay },
      'Scheduling reconnect attempt',
    );

    this.reconnectTimer = setTimeout(() => {
      this.performReconnectAttempt();
    }, delay);

    // Don't hold the process open
    if (this.reconnectTimer.unref) {
      this.reconnectTimer.unref();
    }
  }

  /**
   * Perform a single reconnect attempt.
   *
   * On success, resets reconnect state and emits 'reconnected'.
   * On failure, increments attempt counter and schedules next attempt.
   */
  private async performReconnectAttempt(): Promise<void> {
    this.reconnectAttempt++;

    if (!this.eventDispatcher) {
      logger.error('No event dispatcher available for reconnect');
      this.isReconnecting = false;
      return;
    }

    const success = await this.connectFresh();

    if (success) {
      this.isReconnecting = false;
      logger.info({ attempt: this.reconnectAttempt }, 'Reconnected successfully');
      this.emit('reconnected', this.reconnectAttempt);
    } else {
      logger.warn(
        { attempt: this.reconnectAttempt },
        'Reconnect attempt failed, scheduling next',
      );
      this.scheduleReconnectAttempt();
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  // ─── State machine ───────────────────────────────────────────────────────

  /**
   * Transition to a new state and emit the change event.
   */
  private transitionTo(newState: WsConnectionState): void {
    if (this._state === newState) {
      return;
    }
    const oldState = this._state;
    this._state = newState;
    logger.info(
      { oldState, newState, reconnectAttempt: this.reconnectAttempt },
      'Connection state changed',
    );
    this.emit('stateChange', newState);
  }
}
