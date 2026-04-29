/**
 * WebSocket Connection Manager with Auto-Reconnect.
 *
 * Wraps the Feishu SDK's WSClient with connection state management and
 * exponential-backoff reconnection triggered by SDK error/close events.
 *
 * ### Evolution
 *
 * - Issue #1351: Added custom health check (periodic timer checking message
 *   liveness) to detect zombie connections behind NAT/firewalls.
 * - Issue #1666: Simplified by removing custom ping loop and SDK WebSocket
 *   interception — the Lark WS Server does NOT respond to client-sent
 *   application-layer ping messages.
 * - Issue #2905: Removed the custom health check entirely. It produced
 *   frequent false positives (~every 150s) because the passive message
 *   tracking only captured EventDispatcher events, not SDK-level ping/pong
 *   frames. The Feishu SDK already has built-in ping/pong + auto-reconnect
 *   (pingInterval: 120s, reconnectCount: -1, reconnectInterval: 120s).
 *
 * ### Current architecture
 *
 * The manager now relies on the Feishu SDK's built-in keepalive and reconnect
 * mechanism, and adds:
 * - **Connection state machine**: Explicit state tracking (connected, reconnecting, stopped).
 * - **SDK event listeners**: Listens for WSClient error/close events to trigger reconnect.
 * - **DNS pre-check**: Before each reconnect attempt, verifies DNS is available
 *   (prevents futile attempts during macOS DarkWake — Issue #2259).
 * - **Exponential backoff**: Custom reconnect delay with jitter.
 *
 * Usage:
 * ```typescript
 * const manager = new WsConnectionManager({ appId, appSecret });
 * manager.on('stateChange', (state) => logger.info({ state }, 'Connection state'));
 * await manager.start(eventDispatcher);
 * await manager.stop();
 * ```
 *
 * @module channels/feishu/ws-connection-manager
 * @see https://github.com/hs3180/disclaude/issues/2905
 */

import dns from 'dns/promises';
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
  /** SDK error event received on the WSClient */
  sdkError: [error: unknown];
  /** SDK close event received on the WSClient */
  sdkClose: [code?: string, reason?: string];
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
  /** Override reconnect base delay (ms) */
  reconnectBaseDelayMs?: number;
  /** Override reconnect max delay cap (ms) */
  reconnectMaxDelayMs?: number;
  /** Override reconnect max attempts (-1 = infinite) */
  reconnectMaxAttempts?: number;
  /**
   * DNS pre-check host for reconnect attempts (Issue #2259).
   *
   * Before each reconnect attempt, the manager resolves this hostname to verify
   * that the network is available.  This prevents futile WebSocket connection
   * attempts during macOS DarkWake or similar transient network-outage windows.
   *
   * Set to empty string (`''`) to disable the DNS pre-check.
   * @default 'open.feishu.cn'
   */
  dnsCheckHost?: string;
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
 * Wraps the Feishu SDK's WSClient to add connection state management,
 * SDK error/close event monitoring, and exponential-backoff reconnection.
 *
 * ### How it works
 *
 * 1. **Start**: Creates a WSClient and calls `start()`.
 *
 * 2. **SDK event monitoring**: Listens for WSClient `error` and `close`
 *    events to detect connection failures. The Feishu SDK's built-in
 *    ping/pong mechanism handles normal keepalive detection.
 *
 * 3. **Error/close → reconnect**: When the SDK emits an error or close
 *    event, force-closes the WSClient and creates a new one with
 *    exponentially increasing delays.
 *
 * ### Architecture (Issue #2905)
 *
 * ```
 * 连接建立 → 注册 SDK error/close 事件监听器
 *     ↓
 * SDK 内置 ping/pong 保活 (120s interval)
 *     ↓
 * SDK error/close 事件 → 触发重连
 * ```
 *
 * No longer requires (removed in Issue #2905):
 * - ❌ Custom health check timer (every 30s)
 * - ❌ Passive message tracking (lastMessageReceivedAt)
 * - ❌ Dead connection detection based on message timeout
 * - ❌ recordMessageReceived() calls in event handlers
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

  // Reconnect state
  private reconnectAttempt: number = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private isReconnecting: boolean = false;
  private readonly reconnectBaseDelayMs: number;
  private readonly reconnectMaxDelayMs: number;
  private readonly reconnectMaxAttempts: number;

  // DNS pre-check (Issue #2259)
  private readonly dnsCheckHost: string;

  constructor(config: WsConnectionManagerConfig) {
    super();
    this.config = config;

    // Reference the lark namespace for creating WSClient instances
    this.larkSDK = lark;

    // Resolve configuration with defaults from constants
    this.reconnectBaseDelayMs = config.reconnectBaseDelayMs
      ?? WS_HEALTH.RECONNECT.BASE_DELAY_MS;
    this.reconnectMaxDelayMs = config.reconnectMaxDelayMs
      ?? WS_HEALTH.RECONNECT.MAX_DELAY_MS;
    this.reconnectMaxAttempts = config.reconnectMaxAttempts
      ?? WS_HEALTH.RECONNECT.MAX_ATTEMPTS;

    // DNS pre-check: enabled by default for 'open.feishu.cn'
    // Set to '' in tests or config to disable
    this.dnsCheckHost = config.dnsCheckHost ?? 'open.feishu.cn';

    logger.info(
      {
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
   * Get connection metrics for observability / monitoring.
   */
  getMetrics(): {
    state: WsConnectionState;
    reconnectAttempt: number;
    isConnected: boolean;
  } {
    return {
      state: this._state,
      reconnectAttempt: this.reconnectAttempt,
      isConnected: this._state === 'connected',
    };
  }

  /**
   * Start the WebSocket connection with health monitoring.
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
  }

  /**
   * Stop the connection manager and clean up all resources.
   */
  async stop(): Promise<void> {
    await Promise.resolve();
    logger.info('WsConnectionManager stopping');

    this.clearReconnectTimer();
    this.closeClient();

    this.transitionTo('stopped');
    this.isReconnecting = false;
    this.reconnectAttempt = 0;

    logger.info('WsConnectionManager stopped');
  }

  /**
   * Check if the connection is currently healthy.
   *
   * After Issue #2905, this simply checks whether the state is 'connected'.
   * The SDK's own ping/pong mechanism handles connection liveness detection.
   */
  isHealthy(): boolean {
    return this._state === 'connected';
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Create a fresh WSClient and connect.
   *
   * Sets up SDK error/close event listeners to trigger reconnect when the
   * SDK detects a connection failure (Issue #2905).
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

      // Listen for SDK-level error/close events to trigger reconnect (Issue #2905).
      // The Feishu SDK's built-in ping/pong + reconnect handles normal keepalive;
      // these listeners catch explicit error/close signals the SDK emits.
      this.wsClient.on('error', (error: unknown) => {
        logger.warn({ err: error }, 'WSClient error event received');
        this.emit('sdkError', error);
        // Only initiate reconnect if currently connected (not already reconnecting/stopped)
        if (this._state === 'connected' && !this.isReconnecting) {
          this.initiateReconnect();
        }
      });

      this.wsClient.on('close', (code?: string, reason?: string) => {
        logger.info({ code, reason }, 'WSClient close event received');
        this.emit('sdkClose', code, reason);
        // Only initiate reconnect if currently connected (not already reconnecting/stopped)
        if (this._state === 'connected' && !this.isReconnecting) {
          this.initiateReconnect();
        }
      });

      const startResult = await this.wsClient.start({ eventDispatcher: this.eventDispatcher });

      // SDK may resolve to false (instead of throwing) when connection fails
      if (startResult === false) {
        throw new Error('WSClient.start() returned false');
      }

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
   *
   * Calls `removeAllListeners()` before closing to prevent event listener
   * accumulation across reconnect cycles (Issue #2259 — MaxListenersExceededWarning).
   */
  private closeClient(): void {
    if (this.wsClient) {
      try {
        // Prevent listener accumulation: old WSClient instances may hold
        // registered event listeners that pile up across reconnect cycles.
        if (typeof this.wsClient.removeAllListeners === 'function') {
          this.wsClient.removeAllListeners();
        }
        this.wsClient.close({ force: true });
      } catch (error) {
        logger.debug({ err: error }, 'Error while closing WSClient');
      }
      this.wsClient = undefined;
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
   *
   * Includes a configurable DNS pre-check (Issue #2259): on macOS, after waking
   * from sleep, DNS resolution may briefly fail.  When `dnsCheckHost` is set, we
   * probe that hostname before trying the expensive WSClient startup; if DNS is
   * not ready we skip this round and let the normal back-off schedule the next
   * attempt.
   */
  private async performReconnectAttempt(): Promise<void> {
    this.reconnectAttempt++;

    if (!this.eventDispatcher) {
      logger.error('No event dispatcher available for reconnect');
      this.isReconnecting = false;
      return;
    }

    // DNS pre-check: skip reconnect when DNS is not yet available
    // (e.g. macOS DarkWake after sleep — Issue #2259)
    if (this.dnsCheckHost) {
      const dnsReady = await this.checkDns(this.dnsCheckHost);
      if (!dnsReady) {
        logger.warn(
          { attempt: this.reconnectAttempt, host: this.dnsCheckHost },
          'DNS pre-check failed — network not ready, skipping reconnect attempt',
        );
        this.scheduleReconnectAttempt();
        return;
      }
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

  /**
   * Check whether DNS resolution works for the given host.
   *
   * Protected (instead of private) so tests can spy on or override it via
   * the prototype without module-level mocking of `dns/promises`.
   *
   * @returns `true` if resolution succeeded, `false` otherwise
   */
  protected async checkDns(host: string): Promise<boolean> {
    try {
      await dns.resolve(host);
      return true;
    } catch {
      return false;
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
