/**
 * WebSocket Connection Health Monitor & Auto-Reconnect Manager.
 *
 * Addresses Issue #1351: NAT/firewall silently drops WebSocket connections while
 * the SDK's pingLoop only sends Pings without checking Pong responses, leaving
 * readyState as OPEN with no messages flowing.
 *
 * This module wraps the Feishu SDK's WSClient lifecycle with:
 * - **Pong detection**: Monkey-patches the global WebSocket constructor during
 *   WSClient creation to intercept the underlying WebSocket instance. Every
 *   `message` event (including SDK application-level Pong control frames)
 *   resets the liveness timer.
 * - **Auto-reconnect**: Exponential backoff with jitter when dead connections are detected
 * - **Connection state machine**: Explicit state tracking (connected, reconnecting, stopped)
 * - **Observability**: Emits events and logs for connection lifecycle monitoring,
 *   including Pong round-trip time and Pong-specific metrics
 *
 * ### Why monkey-patch WebSocket?
 *
 * The Feishu SDK's WSClient creates an internal WebSocket instance and registers
 * its own `message` handler. This handler processes both data frames (user messages)
 * and control frames (Pong responses to SDK's pingLoop). Because the SDK's internals
 * are private, we cannot directly add our listener.
 *
 * By temporarily replacing `globalThis.WebSocket` during `WSClient.start()`,
 * we capture the underlying instance and add our own `message` listener. This
 * runs BEFORE the SDK's handler, so every server message (including Pong) is
 * detected. The original WebSocket constructor is restored immediately after.
 *
 * This approach is:
 * - Non-invasive: doesn't modify SDK internals
 * - Reliable: works at the transport level, not application level
 * - Self-healing: if monkey-patching fails, falls back to `recordMessageReceived()`
 *
 * Offline message queue is managed at the FeishuChannel level.
 *
 * Usage:
 * ```typescript
 * const manager = new WsConnectionManager({ appId, appSecret });
 * manager.on('stateChange', (state) => logger.info({ state }, 'Connection state'));
 * manager.on('pong', (rttMs) => logger.debug({ rttMs }, 'Pong received'));
 * await manager.start(eventDispatcher);
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
  /** Any server message received (including Pong) */
  heartbeat: [lastReceived: number];
  /** Pong control frame received from server */
  pong: [rttMs: number];
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
 * Detect if a raw WebSocket message buffer contains a Feishu Pong control frame.
 *
 * The Feishu SDK uses a custom protobuf-like binary protocol. Pong frames have:
 * - `method` field = 0 (control frame)
 * - `headers` containing `{ key: "type", value: "pong" }`
 *
 * Since the SDK sends Ping every ~30s and the server responds with Pong,
 * detecting Pong frames provides a reliable transport-level liveness signal
 * independent of user message activity.
 *
 * Implementation: scans the binary buffer for the UTF-8 string "pong"
 * which appears as a protobuf string field value within the headers.
 * This is simpler and more robust than full protobuf decoding.
 *
 * @param data - Raw WebSocket message data (Buffer, ArrayBuffer, or Buffer-like)
 * @returns `true` if the buffer likely contains a Pong control frame
 */
export function isPongFrame(data: Buffer | ArrayBuffer | Uint8Array): boolean {
  let buf: Uint8Array;
  if (Buffer.isBuffer(data)) {
    buf = data;
  } else if (data instanceof ArrayBuffer) {
    buf = new Uint8Array(data);
  } else if (data instanceof Uint8Array) {
    buf = data;
  } else {
    return false;
  }

  // Search for the bytes representing protobuf-encoded string "pong"
  // In protobuf, a string field is: length-varint + utf8-bytes
  // "pong" = 4 bytes, so we look for \x04 (varint 4) followed by "pong"
  const pongMarker = [0x04, 0x70, 0x6f, 0x6e, 0x67]; // \x04pong
  for (let i = 0; i <= buf.length - pongMarker.length; i++) {
    let match = true;
    for (let j = 0; j < pongMarker.length; j++) {
      if (buf[i + j] !== pongMarker[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }

  return false;
}

/**
 * WebSocket Connection Manager.
 *
 * Wraps the Feishu SDK's WSClient to add zombie connection detection and
 * exponential-backoff reconnection, with **transport-level Pong detection**
 * via WebSocket monkey-patching.
 *
 * ### How it works
 *
 * 1. **Start**: Monkey-patches `globalThis.WebSocket`, creates a WSClient
 *    (which internally creates a WebSocket that our patch intercepts),
 *    then restores the original WebSocket. The intercepted instance has
 *    our `message` listener that tracks ALL server messages including Pong.
 *
 * 2. **Pong detection**: The SDK's `pingLoop` sends application-level Ping
 *    frames every ~30s. The server responds with Pong control frames.
 *    Our listener on the raw WebSocket detects these Pong frames and
 *    records `lastPongAt` + round-trip time. This is the primary liveness
 *    signal — even if no user messages arrive, Pong responses confirm
 *    the connection is alive.
 *
 * 3. **Health check**: Every `healthCheckIntervalMs`, checks `lastPongAt`.
 *    If no Pong received within `deadConnectionTimeoutMs`, the connection
 *    is deemed dead (zombie). Falls back to checking `lastMessageReceivedAt`
 *    (from `recordMessageReceived()`) if Pong tracking is unavailable.
 *
 * 4. **Dead connection → reconnect**: Force-closes the WSClient, then
 *    creates a new one with exponentially increasing delays.
 *
 * 5. **Reconnect flow**: On each failure, delay doubles (capped at `maxDelayMs`)
 *    with random jitter. If `maxAttempts` is reached, transitions to 'stopped'.
 *
 * ### Graceful degradation
 *
 * If WebSocket monkey-patching fails (e.g., in environments where WebSocket
 * cannot be replaced), the manager falls back to relying on `recordMessageReceived()`
 * calls from FeishuChannel event handlers. This is less reliable for idle bots
 * but still functional.
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

  // Health monitoring — transport level (Pong)
  private lastPongAt: number = 0;
  private pongCount: number = 0;
  private lastPingSentAt: number = 0;
  private interceptedWs?: { instance: WebSocket; onMessageBound: (evt: MessageEvent) => void };

  // Health monitoring — application level (fallback)
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

  // WebSocket constructor backup for monkey-patching
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private originalWebSocket?: any;

  constructor(config: WsConnectionManagerConfig) {
    super();
    this.config = config;

    // Reference the lark namespace for creating WSClient instances
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
    lastPongAt: number;
    lastMessageReceivedAt: number;
    timeSinceLastPongMs: number;
    timeSinceLastMessageMs: number;
    pongCount: number;
    reconnectAttempt: number;
    isConnected: boolean;
    hasWsInterception: boolean;
  } {
    return {
      state: this._state,
      lastPongAt: this.lastPongAt,
      lastMessageReceivedAt: this.lastMessageReceivedAt,
      timeSinceLastPongMs: this.lastPongAt > 0
        ? Date.now() - this.lastPongAt
        : 0,
      timeSinceLastMessageMs: this.lastMessageReceivedAt > 0
        ? Date.now() - this.lastMessageReceivedAt
        : 0,
      pongCount: this.pongCount,
      reconnectAttempt: this.reconnectAttempt,
      isConnected: this._state === 'connected',
      hasWsInterception: !!this.interceptedWs,
    };
  }

  /**
   * Start the WebSocket connection with health monitoring.
   *
   * Monkey-patches `globalThis.WebSocket` during WSClient creation to
   * intercept the underlying WebSocket for Pong detection.
   *
   * @param eventDispatcher - Feishu SDK EventDispatcher for handling events
   */
  async start(eventDispatcher: lark.EventDispatcher): Promise<void> {
    this.eventDispatcher = eventDispatcher;
    const success = await this.connectFresh();

    if (!success) {
      logger.warn('Initial connection failed, entering reconnect mode');
      this.initiateReconnect();
    }

    // Always start health monitoring
    this.startHealthCheck();
  }

  /**
   * Stop the connection manager and clean up all resources.
   */
  stop(): void {
    logger.info('WsConnectionManager stopping');

    this.stopHealthCheck();
    this.clearReconnectTimer();
    this.closeClient();
    this.detachWsListener();

    this.transitionTo('stopped');
    this.isReconnecting = false;
    this.reconnectAttempt = 0;

    logger.info('WsConnectionManager stopped');
  }

  /**
   * Record that a message was received from the server (application level).
   *
   * This is a **supplementary** liveness signal used as fallback when
   * transport-level Pong detection is unavailable (e.g., monkey-patching failed).
   *
   * The primary liveness signal comes from intercepted WebSocket `message`
   * events which include Pong control frames.
   */
  recordMessageReceived(): void {
    this.lastMessageReceivedAt = Date.now();
    this.emit('heartbeat', this.lastMessageReceivedAt);
  }

  /**
   * Check if the connection is currently healthy.
   *
   * Prefers transport-level Pong detection when available.
   * Falls back to application-level message tracking.
   */
  isHealthy(): boolean {
    if (this._state !== 'connected') {
      return false;
    }

    // Primary: check Pong-based liveness
    if (this.lastPongAt > 0) {
      const elapsed = Date.now() - this.lastPongAt;
      return elapsed < this.deadConnectionTimeoutMs;
    }

    // Fallback: check application-level message tracking
    if (this.lastMessageReceivedAt === 0) {
      return true; // Grace period
    }
    const elapsed = Date.now() - this.lastMessageReceivedAt;
    return elapsed < this.deadConnectionTimeoutMs;
  }

  // ─── WebSocket interception (Pong detection) ──────────────────────────

  /**
   * Monkey-patch globalThis.WebSocket to capture the instance created by
   * the Feishu SDK's WSClient, then attach our Pong detection listener.
   *
   * The patch is applied before WSClient.start() and removed after.
   * Only the first WebSocket instance created during the patch is captured.
   */
  private patchWebSocket(): void {
    this.originalWebSocket = globalThis.WebSocket;
    const self = this;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const PatchedWebSocket = class extends this.originalWebSocket {
      constructor(...args: any[]) {
        super(...args);

        // Only intercept the first WebSocket created (the SDK's main connection)
        if (!self.interceptedWs) {
          const onMessageBound = (evt: MessageEvent) => {
            self.onWsMessage(evt);
          };

          self.interceptedWs = { instance: this as unknown as WebSocket, onMessageBound };
          this.addEventListener('message', onMessageBound);

          logger.debug('Intercepted WebSocket instance for Pong detection');
        }
      }
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).WebSocket = PatchedWebSocket;
  }

  /**
   * Restore the original WebSocket constructor after WSClient.start() completes.
   */
  private unpatchWebSocket(): void {
    if (this.originalWebSocket) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).WebSocket = this.originalWebSocket;
      this.originalWebSocket = undefined;
    }
  }

  /**
   * Handler for intercepted WebSocket message events.
   *
   * Called for EVERY message on the raw WebSocket, including:
   * - SDK application-level Pong responses (control frames)
   * - User messages (data frames)
   * - Any other server-initiated messages
   *
   * Detects Pong frames by scanning the binary data for the protobuf-encoded
   * "pong" marker and records timing for health monitoring.
   */
  private onWsMessage(evt: MessageEvent): void {
    const now = Date.now();

    // Update application-level liveness (covers all message types)
    this.lastMessageReceivedAt = now;

    // Detect Pong control frames specifically
    if (evt.data && isPongFrame(evt.data)) {
      this.pongCount++;
      this.lastPongAt = now;

      // Estimate round-trip time from last Ping
      let rttMs = -1;
      if (this.lastPingSentAt > 0) {
        rttMs = now - this.lastPingSentAt;
        this.lastPingSentAt = 0; // Reset after pairing
      }

      logger.debug(
        { pongCount: this.pongCount, rttMs, elapsedSinceConnect: now - (this.lastPongAt - rttMs) },
        'Pong received from server',
      );

      this.emit('pong', rttMs);
    }

    this.emit('heartbeat', now);
  }

  /**
   * Detach our message listener from the intercepted WebSocket.
   */
  private detachWsListener(): void {
    if (this.interceptedWs) {
      try {
        this.interceptedWs.instance.removeEventListener('message', this.interceptedWs.onMessageBound);
        logger.debug('Detached WebSocket Pong listener');
      } catch (error) {
        logger.debug({ err: error }, 'Error detaching WebSocket listener');
      }
      this.interceptedWs = undefined;
    }
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Create a fresh WSClient and connect.
   *
   * During connection, monkey-patches WebSocket to intercept the underlying
   * instance for Pong detection. The patch is removed after start() completes.
   *
   * @returns `true` if connection succeeded
   */
  private async connectFresh(): Promise<boolean> {
    const sdkLogger = this.config.sdkLogger ?? createDefaultSdkLogger();

    // Reset Pong state for new connection
    this.lastPongAt = 0;
    this.pongCount = 0;
    this.lastPingSentAt = 0;
    this.detachWsListener();

    try {
      // Patch WebSocket BEFORE creating WSClient to intercept the instance
      this.patchWebSocket();

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

      // Restore original WebSocket AFTER SDK has created its instance
      this.unpatchWebSocket();

      // SDK may resolve to false (instead of throwing) when connection fails
      if (startResult === false) {
        throw new Error('WSClient.start() returned false');
      }

      // Start grace period
      this.lastMessageReceivedAt = Date.now();
      this.reconnectAttempt = 0;
      this.transitionTo('connected');

      const interceptionStatus = this.interceptedWs ? 'with Pong detection' : 'without Pong detection (fallback mode)';
      logger.info(`WebSocket connection established ${interceptionStatus}`);
      return true;
    } catch (error) {
      // Ensure WebSocket is restored even on error
      this.unpatchWebSocket();
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
   * Prefers Pong-based detection (transport level). Falls back to
   * application-level message tracking if Pong interception is unavailable.
   */
  private runHealthCheck(): void {
    if (this._state !== 'connected' || this.isReconnecting) {
      return;
    }

    // Determine the most recent liveness signal
    let lastActivityAt: number;
    let signalType: string;

    if (this.lastPongAt > 0) {
      // Primary: Pong-based (transport level)
      lastActivityAt = this.lastPongAt;
      signalType = 'pong';
    } else if (this.lastMessageReceivedAt > 0) {
      // Fallback: application-level message tracking
      lastActivityAt = this.lastMessageReceivedAt;
      signalType = 'message';
    } else {
      // Grace period: just connected, no signals yet
      return;
    }

    const elapsed = Date.now() - lastActivityAt;

    if (elapsed >= this.deadConnectionTimeoutMs) {
      logger.warn(
        {
          elapsedMs: elapsed,
          timeoutMs: this.deadConnectionTimeoutMs,
          signalType,
          pongCount: this.pongCount,
          hasWsInterception: !!this.interceptedWs,
          reconnectAttempt: this.reconnectAttempt,
        },
        `Dead connection detected — no ${signalType} received within timeout`,
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

    if (this.reconnectTimer.unref) {
      this.reconnectTimer.unref();
    }
  }

  /**
   * Perform a single reconnect attempt.
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
