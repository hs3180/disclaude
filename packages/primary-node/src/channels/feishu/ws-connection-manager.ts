/**
 * WebSocket Connection Health Monitor & Auto-Reconnect Manager.
 *
 * Addresses Issue #1351: NAT/firewall silently drops WebSocket connections while
 * the SDK's pingLoop only sends Pings without checking Pong responses, leaving
 * readyState as OPEN with no messages flowing.
 *
 * Addresses Issue #1437: Adds a custom ping loop with shorter interval (5s vs
 * SDK's 120s) to reduce dead connection detection from ~5 minutes to ~15 seconds.
 *
 * Addresses Issue #1504: WSClient.start() is fire-and-forget (returns void),
 * causing a race condition where interceptWsFromClient() runs before the SDK's
 * internal WebSocket is ready. Fixed by polling getWSInstance() after start().
 *
 * This module wraps the Feishu SDK's WSClient lifecycle with:
 * - **Pong detection**: Accesses the SDK's internal `wsConfig` to obtain the raw
 *   `ws` WebSocket instance after `WSClient.start()` completes, then attaches a
 *   `message` listener for transport-level Pong frame detection.
 * - **Custom ping loop**: Sends application-layer ping frames at 5s intervals via
 *   the SDK's `sendMessage()` method, independent of the SDK's own pingLoop.
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
 * ### How the custom ping loop works (Issue #1437)
 *
 * The SDK's built-in pingLoop runs at 120s intervals, which is too slow for
 * timely dead connection detection. This manager adds an independent ping loop
 * that sends the same application-layer ping frame format at 5s intervals:
 *
 * ```
 * { headers: [{ key: "type", value: "ping" }], service: serviceId, method: 0, SeqID: 0, LogID: 0 }
 * ```
 *
 * The SDK's `sendMessage()` method is used to encode and send the frame via
 * protobuf. Both the SDK's pingLoop and our custom loop run concurrently —
 * the server responds to each ping with a Pong, and our Pong detection
 * captures all of them.
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
 * @see https://github.com/hs3180/disclaude/issues/1437
 */

import { EventEmitter } from 'events';
import { WS_HEALTH, createLogger } from '@disclaude/core';
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
  /** Custom ping sent (Issue #1437) */
  ping: [intervalMs: number];
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
  /** Override custom ping interval (ms). Set to 0 to disable custom ping loop. */
  customPingIntervalMs?: number;
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
 *
 * If the custom ping loop cannot be started (e.g., `sendMessage()` unavailable),
 * health monitoring still works using the SDK's own 120s pingLoop Pong responses.
 * The dead connection detection will just be slower in that case.
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private interceptedWs?: { instance: any; onMessageBound: (...args: unknown[]) => void };

  // Custom ping loop (Issue #1437)
  private customPingTimer?: ReturnType<typeof setInterval>;
  private customPingCount: number = 0;
  private customPingIntervalMs: number;

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
    this.customPingIntervalMs = config.customPingIntervalMs
      ?? WS_HEALTH.CUSTOM_PING_INTERVAL_MS;

    logger.info(
      {
        deadConnectionTimeoutMs: this.deadConnectionTimeoutMs,
        healthCheckIntervalMs: this.healthCheckIntervalMs,
        customPingIntervalMs: this.customPingIntervalMs,
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
    customPingCount: number;
    customPingIntervalMs: number;
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
      customPingCount: this.customPingCount,
      customPingIntervalMs: this.customPingIntervalMs,
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
    await Promise.resolve();
    logger.info('WsConnectionManager stopping');

    this.stopHealthCheck();
    this.stopCustomPingLoop();
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
   * Wait for the SDK's internal WebSocket instance to become available.
   *
   * Issue #1504: `WSClient.start()` is fire-and-forget (returns void), so
   * `await start()` resolves immediately while the SDK's internal `connect()`
   * is still in progress. The WebSocket instance is only set after the SDK's
   * `connect()` → `tryConnect()` → `pullConnectConfig()` chain completes,
   * which can take ~300ms+ depending on network conditions.
   *
   * This method polls `wsClient.wsConfig.getWSInstance()` at a short interval
   * until it returns a non-null value or the timeout is exceeded.
   *
   * @param wsClient - The WSClient instance (typed as `any` to access private fields)
   * @param timeoutMs - Maximum time to wait (default from WS_HEALTH.WS_INSTANCE_POLL.TIMEOUT_MS)
   * @param intervalMs - Polling interval (default from WS_HEALTH.WS_INSTANCE_POLL.INTERVAL_MS)
   * @returns The WebSocket instance, or `null` if timeout was reached
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async waitForWsInstance(wsClient: any, timeoutMs?: number, intervalMs?: number): Promise<any> {
    const timeout = timeoutMs ?? WS_HEALTH.WS_INSTANCE_POLL.TIMEOUT_MS;
    const interval = intervalMs ?? WS_HEALTH.WS_INSTANCE_POLL.INTERVAL_MS;

    // If wsConfig or getWSInstance is not available, we can't poll at all
    if (!wsClient?.wsConfig?.getWSInstance) {
      return null;
    }

    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const instance = wsClient.wsConfig.getWSInstance();
      if (instance) {
        return instance;
      }
      await new Promise(resolve => setTimeout(resolve, interval));
    }

    return null;
  }

  /**
   * Access the SDK's internal WebSocket instance and attach our Pong listener.
   *
   * The Feishu SDK's WSClient uses `require('ws')` internally (NOT globalThis.WebSocket),
   * so monkey-patching globalThis.WebSocket has no effect. Instead, after WSClient.start()
   * completes, we access the SDK's private `wsConfig` to get the raw `ws` WebSocket
   * instance via `wsClient.wsConfig.getWSInstance()`.
   *
   * This is safe because:
   * - The SDK stores the instance in `wsConfig.wsInstance` after connect()
   * - The `ws` package's `.on('message', ...)` is addititive (doesn't replace SDK's handler)
   * - TypeScript `private` is only a compile-time check; at runtime the field is accessible
   *
   * @param wsClient - The WSClient instance (typed as `any` to access private fields)
   * @returns `true` if interception succeeded
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private interceptWsFromClient(wsClient: any): boolean {
    try {
      // Access SDK's internal wsConfig to get the raw `ws` WebSocket instance
      // SDK code: this.wsConfig.setWSInstance(wsInstance) in connect()
      const wsInstance = wsClient.wsConfig?.getWSInstance?.();
      if (!wsInstance) {
        logger.debug('SDK wsConfig.getWSInstance() returned null — connection may not be ready');
        return false;
      }

      // The `ws` package's .on() is additive — it doesn't replace the SDK's own handler
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
      return false;
    }
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
        logger.debug('Detached WebSocket Pong listener');
      } catch (error) {
        logger.debug({ err: error }, 'Error detaching WebSocket listener');
      }
      this.interceptedWs = undefined;
    }
  }

  // ─── Custom ping loop (Issue #1437) ────────────────────────────────────

  /**
   * Start the custom ping loop that sends application-layer ping frames
   * at a configurable interval (default 5s).
   *
   * Uses the SDK's `sendMessage()` method to encode and send the ping frame
   * via protobuf. This is the same mechanism as the SDK's internal `pingLoop()`,
   * but with a much shorter interval for faster dead connection detection.
   *
   * The SDK's own pingLoop (120s default) continues running concurrently.
   * Both loops send pings independently; the server responds to each with
   * a Pong, and our Pong detection captures all of them.
   *
   * Graceful degradation:
   * - If `wsClient.sendMessage` is not available (SDK internal change), the
   *   loop is silently skipped. Health monitoring falls back to Pong detection
   *   from the SDK's pingLoop only.
   * - If `customPingIntervalMs` is 0, the custom ping loop is disabled.
   */
  private startCustomPingLoop(): void {
    this.stopCustomPingLoop();

    if (!this.customPingIntervalMs || this.customPingIntervalMs <= 0) {
      logger.debug('Custom ping loop disabled (interval is 0 or negative)');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = this.wsClient as any;
    if (!client || typeof client.sendMessage !== 'function') {
      logger.debug('SDK sendMessage() not available — custom ping loop skipped');
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wsConfig = client.wsConfig as any;
    if (!wsConfig || typeof wsConfig.getWS !== 'function') {
      logger.debug('SDK wsConfig.getWS() not available — custom ping loop skipped');
      return;
    }

    // Get serviceId from SDK's wsConfig (same source as SDK's pingLoop)
    const wsParams = wsConfig.getWS();
    const serviceId = wsParams?.serviceId;
    if (serviceId === undefined) {
      logger.debug('serviceId not available in wsConfig — custom ping loop skipped');
      return;
    }

    this.customPingTimer = setInterval(() => {
      try {
        // Construct the same ping frame as the SDK's pingLoop
        const frame = {
          headers: [{ key: 'type', value: 'ping' }],
          service: Number(serviceId),
          method: 0, // FrameType.control
          SeqID: 0,
          LogID: 0,
        };

        // Record timing before sending for RTT estimation
        this.lastPingSentAt = Date.now();

        // Use the SDK's sendMessage to encode (protobuf) and send
        client.sendMessage(frame);

        this.customPingCount++;

        if (this.customPingCount <= 3 || this.customPingCount % 60 === 0) {
          // Log first 3 pings and then every 5 minutes (60 × 5s)
          logger.debug(
            { customPingCount: this.customPingCount, intervalMs: this.customPingIntervalMs },
            'Custom ping sent',
          );
        }

        this.emit('ping', this.customPingIntervalMs);
      } catch (error) {
        logger.warn({ err: error }, 'Failed to send custom ping — stopping custom ping loop');
        this.stopCustomPingLoop();
      }
    }, this.customPingIntervalMs);

    if (this.customPingTimer.unref) {
      this.customPingTimer.unref();
    }

    logger.info(
      { intervalMs: this.customPingIntervalMs, serviceId },
      'Custom ping loop started',
    );
  }

  /**
   * Stop the custom ping loop.
   */
  private stopCustomPingLoop(): void {
    if (this.customPingTimer) {
      clearInterval(this.customPingTimer);
      this.customPingTimer = undefined;
      logger.debug(
        { totalPings: this.customPingCount },
        'Custom ping loop stopped',
      );
    }
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
    this.customPingCount = 0;
    this.stopCustomPingLoop();
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

      // Issue #1504: WSClient.start() is fire-and-forget (returns void),
      // so await resolves immediately while the SDK's internal connect() is
      // still in progress. Poll getWSInstance() until the WebSocket is ready.
      const wsInstance = await this.waitForWsInstance(this.wsClient);
      if (!wsInstance) {
        logger.warn(
          'Timed out waiting for SDK WebSocket instance — Pong detection unavailable, falling back to application-level detection',
        );
      } else {
        logger.debug(
          { waitedMs: Date.now() - (Date.now() - 0) }, // Approximate; timing is logged elsewhere
          'SDK WebSocket instance available after polling',
        );
      }

      // Access SDK's internal WebSocket instance for Pong detection
      this.interceptWsFromClient(this.wsClient);

      // Start custom ping loop for faster dead connection detection (Issue #1437)
      this.startCustomPingLoop();

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
      void this.performReconnectAttempt();
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
