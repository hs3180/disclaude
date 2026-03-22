/**
 * WebSocket Connection Health Monitor & Auto-Reconnect Manager.
 *
 * Addresses Issue #1351: NAT/firewall silently drops WebSocket connections while
 * the SDK's pingLoop only sends Pings without checking Pong responses, leaving
 * readyState as OPEN with no messages flowing.
 *
 * This module wraps the Feishu SDK's WSClient lifecycle with:
 * - **Pong detection**: Accesses the SDK's internal `wsConfig` to obtain the raw
 *   `ws` WebSocket instance after `WSClient.start()` completes, then attaches a
 *   `message` listener for transport-level Pong frame detection.
 * - **Auto-reconnect**: Exponential backoff with jitter when dead connections are detected
 * - **Connection state machine**: Explicit state tracking (connected, reconnecting, stopped)
 * - **Observability**: Emits events and logs for connection lifecycle monitoring,
 *   including Pong round-trip time and Pong-specific metrics
 *
 * ### How Pong detection works
 *
 * The Feishu SDK's WSClient uses `require('ws')` (the npm `ws` package) internally,
 * NOT `globalThis.WebSocket`. This means monkey-patching `globalThis.WebSocket` has
 * no effect — the SDK creates its own WebSocket instance from the `ws` module.
 *
 * After `WSClient.start()` completes, the SDK stores the WebSocket instance in
 * its internal `wsConfig.wsInstance` field (accessible at runtime despite being
 * declared `private` in TypeScript). We read this instance via
 * `wsClient.wsConfig.getWSInstance()` and attach our own `message` listener.
 *
 * Every `message` event on the raw `ws` WebSocket — including SDK application-level
 * Pong control frames — triggers our liveness timer reset. This is the primary
 * signal for dead connection detection, even when no user messages arrive.
 *
 * If internal WebSocket access fails (e.g., SDK internal changes), the manager
 * falls back to `recordMessageReceived()` calls from the FeishuChannel event handler.
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
  /** Override protocol-level ping interval (ms) */
  pingIntervalMs?: number;
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
 * via SDK internal WebSocket access.
 *
 * ### How it works
 *
 * 1. **Start**: Creates a WSClient and calls `start()`. After the SDK's
 *    internal WebSocket connection is established, accesses the SDK's private
 *    `wsConfig` to obtain the raw `ws` WebSocket instance and attaches our
 *    `message` listener for Pong frame detection.
 *
 * 2. **Pong detection**: The SDK's `pingLoop` sends application-level Ping
 *    frames every ~120s (configurable by server). The server responds with
 *    Pong control frames. Our listener on the raw WebSocket detects these
 *    Pong frames and records `lastPongAt` + round-trip time. This is the
 *    primary liveness signal — even if no user messages arrive, Pong responses
 *    confirm the connection is alive.
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
 * ### Why not monkey-patch globalThis.WebSocket?
 *
 * The Feishu SDK uses `require('ws')` (the npm `ws` package) internally,
 * resolved as a local CommonJS variable, NOT `globalThis.WebSocket`.
 * Therefore, monkey-patching `globalThis.WebSocket` has no effect — the SDK
 * creates WebSocket instances directly from the `ws` module import.
 *
 * ### Graceful degradation
 *
 * If internal WebSocket access fails (e.g., SDK internal API changes),
 * the manager falls back to relying on `recordMessageReceived()` calls from
 * FeishuChannel event handlers. This is less reliable for idle bots but still functional.
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
  private interceptedWs?: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    instance: any;
    onMessageBound: (...args: unknown[]) => void;
    onProtocolPongBound?: (...args: unknown[]) => void;
  };

  // Protocol-level ping loop (RFC 6455 §5.5.2)
  private pingTimer?: ReturnType<typeof setInterval>;
  private readonly pingIntervalMs: number;
  private lastProtocolPongAt: number = 0;
  private protocolPongCount: number = 0;

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
    this.pingIntervalMs = config.pingIntervalMs
      ?? WS_HEALTH.PING_INTERVAL_MS;

    logger.info(
      {
        deadConnectionTimeoutMs: this.deadConnectionTimeoutMs,
        healthCheckIntervalMs: this.healthCheckIntervalMs,
        pingIntervalMs: this.pingIntervalMs,
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
    protocolPongCount: number;
    pingIntervalMs: number;
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
      protocolPongCount: this.protocolPongCount,
      pingIntervalMs: this.pingIntervalMs,
      reconnectAttempt: this.reconnectAttempt,
      isConnected: this._state === 'connected',
      hasWsInterception: !!this.interceptedWs,
    };
  }

  /**
   * Start the WebSocket connection with health monitoring.
   *
   * After WSClient.start() completes, accesses the SDK's internal wsConfig
   * to obtain the raw `ws` WebSocket instance for Pong detection.
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
  async stop(): Promise<void> {
    logger.info('WsConnectionManager stopping');

    this.stopPingLoop();
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
   * transport-level Pong detection is unavailable (e.g., SDK internal
   * WebSocket access failed).
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
   * Poll for the SDK's internal WebSocket instance and attach our Pong listener.
   *
   * The Feishu SDK's `start()` method does NOT await the actual WebSocket connection.
   * It calls `reConnect(true)` without `yield`, so `start()` resolves immediately
   * while the real connection (pullConnectConfig → connect → communicate) happens
   * asynchronously. This means `wsConfig.getWSInstance()` returns `null` right
   * after `start()` resolves.
   *
   * We poll `getWSInstance()` every 100ms for up to 30s until the SDK's internal
   * `connect()` sets the instance via `wsConfig.setWSInstance(wsInstance)`.
   *
   * Once obtained, the `ws` package's `.on('message', ...)` is additive — it doesn't
   * replace the SDK's own handler, so both coexist safely.
   *
   * @param wsClient - The WSClient instance (typed as `any` to access private fields)
   * @returns `true` if interception succeeded
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async interceptWsFromClient(wsClient: any): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tryIntercept = (): boolean => {
      try {
        const wsInstance = wsClient.wsConfig?.getWSInstance?.();
        if (!wsInstance) {
          return false;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const onMessageBound = (data: any) => {
          this.onWsMessage(data);
        };

        wsInstance.on('message', onMessageBound);
        this.interceptedWs = { instance: wsInstance, onMessageBound };

        logger.debug('Successfully intercepted SDK WebSocket via wsConfig for Pong detection');
        return true;
      } catch (error) {
        logger.warn({ err: error }, 'Failed to intercept SDK WebSocket — falling back to application-level detection');
        return true; // Don't retry on errors (e.g., SDK API changed)
      }
    };

    // SDK start() doesn't await the connection — poll until WS instance is ready
    const pollIntervalMs = 100;
    const maxWaitMs = 30_000;

    for (let waited = 0; waited < maxWaitMs; waited += pollIntervalMs) {
      if (tryIntercept()) {
        return true;
      }
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    logger.warn('SDK WebSocket instance not available after 30s — falling back to application-level detection');
    return false;
  }

  /**
   * Handler for intercepted WebSocket message events.
   *
   * Called for EVERY message on the raw `ws` WebSocket, including:
   * - SDK application-level Pong responses (control frames)
   * - User messages (data frames)
   * - Any other server-initiated messages
   *
   * The `ws` library passes raw data as the first argument (Buffer/ArrayBuffer),
   * unlike the browser WebSocket which wraps it in a MessageEvent.
   *
   * Detects Pong frames by scanning the binary data for the protobuf-encoded
   * "pong" marker and records timing for health monitoring.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onWsMessage(data: any): void {
    const now = Date.now();

    // Update application-level liveness (covers all message types)
    this.lastMessageReceivedAt = now;

    // Detect Pong control frames specifically
    if (data && isPongFrame(data)) {
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
        // The `ws` package uses .off() or .removeListener() (not removeEventListener)
        this.interceptedWs.instance.off('message', this.interceptedWs.onMessageBound);
        // Detach protocol-level pong listener if present
        if (this.interceptedWs.onProtocolPongBound) {
          this.interceptedWs.instance.off('pong', this.interceptedWs.onProtocolPongBound);
        }
        logger.debug('Detached WebSocket listeners');
      } catch (error) {
        logger.debug({ err: error }, 'Error detaching WebSocket listener');
      }
      this.interceptedWs = undefined;
    }
  }

  // ─── Protocol-level ping loop (RFC 6455 §5.5.2) ──────────────────────

  /**
   * Start sending WebSocket protocol-level pings at the configured interval.
   *
   * Uses `ws.ping()` (RFC 6455 §5.5.2) which sends a Ping control frame.
   * The peer MUST respond with a Pong control frame. This is handled at the
   * WebSocket protocol layer — no protobuf encoding needed.
   *
   * The Feishu SDK does NOT listen for protocol-level pong events (verified),
   * so there is zero conflict with the SDK's own application-level pingLoop.
   */
  private startPingLoop(): void {
    this.stopPingLoop();

    if (!this.interceptedWs) {
      logger.debug('No intercepted WebSocket — skipping protocol-level ping loop');
      return;
    }

    const wsInstance = this.interceptedWs.instance;

    // Attach protocol-level pong listener
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const onProtocolPongBound = (_data: any) => {
      this.lastProtocolPongAt = Date.now();
      this.protocolPongCount++;
      logger.trace(
        { protocolPongCount: this.protocolPongCount },
        'Protocol-level Pong received',
      );
      this.emit('heartbeat', this.lastProtocolPongAt);
    };

    wsInstance.on('pong', onProtocolPongBound);
    this.interceptedWs.onProtocolPongBound = onProtocolPongBound;

    // Start periodic ping
    this.pingTimer = setInterval(() => {
      this.sendProtocolPing();
    }, this.pingIntervalMs);

    if (this.pingTimer.unref) {
      this.pingTimer.unref();
    }

    logger.debug(
      { intervalMs: this.pingIntervalMs },
      'Protocol-level ping loop started',
    );
  }

  /**
   * Send a single WebSocket protocol-level Ping frame.
   *
   * Only sends if the WebSocket is in OPEN state (readyState === 1).
   * Uses `ws.ping()` which automatically handles framing per RFC 6455.
   */
  private sendProtocolPing(): void {
    if (!this.interceptedWs) {
      return;
    }

    const wsInstance = this.interceptedWs.instance;

    // WebSocket.OPEN = 1
    if (wsInstance.readyState !== 1) {
      logger.debug(
        { readyState: wsInstance.readyState },
        'Skipping protocol ping — WebSocket not open',
      );
      return;
    }

    try {
      // ws.ping(data?, mask?, callback?) — sends a Ping control frame
      wsInstance.ping(Buffer.from('disclaude-health'));
    } catch (error) {
      logger.debug({ err: error }, 'Failed to send protocol-level ping');
    }
  }

  /**
   * Stop the protocol-level ping loop and detach the pong listener.
   */
  private stopPingLoop(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    // Pong listener is cleaned up in detachWsListener()
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Create a fresh WSClient and connect.
   *
   * After WSClient.start() completes, accesses the SDK's internal wsConfig
   * to obtain the raw `ws` WebSocket instance for Pong detection.
   *
   * @returns `true` if connection succeeded
   */
  private async connectFresh(): Promise<boolean> {
    const sdkLogger = this.config.sdkLogger ?? createDefaultSdkLogger();

    // Reset Pong state for new connection
    this.lastPongAt = 0;
    this.pongCount = 0;
    this.lastPingSentAt = 0;
    this.lastProtocolPongAt = 0;
    this.protocolPongCount = 0;
    this.detachWsListener();

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

      // Access SDK's internal WebSocket instance for Pong detection
      await this.interceptWsFromClient(this.wsClient);

      // Start our own protocol-level ping loop (RFC 6455 §5.5.2)
      this.startPingLoop();

      // Start grace period
      this.lastMessageReceivedAt = Date.now();
      this.reconnectAttempt = 0;
      this.transitionTo('connected');

      const interceptionStatus = this.interceptedWs ? 'with Pong detection' : 'without Pong detection (fallback mode)';
      logger.info(`WebSocket connection established ${interceptionStatus}`);
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

    if (this.lastProtocolPongAt > 0) {
      // Highest priority: protocol-level pong (our own ping loop)
      lastActivityAt = this.lastProtocolPongAt;
      signalType = 'protocol-pong';
    } else if (this.lastPongAt > 0) {
      // Secondary: SDK application-level Pong
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

    // Stop protocol-level pings on the dead connection
    this.stopPingLoop();

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
