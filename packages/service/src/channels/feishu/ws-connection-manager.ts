/**
 * WebSocket Connection Manager & Auto-Reconnect.
 *
 * Wraps the Feishu SDK's WSClient with connection state tracking and
 * exponential-backoff reconnection triggered by SDK error/close events.
 *
 * ### Why no custom health check?
 *
 * The Feishu SDK (@larksuiteoapi/node-sdk) WSClient has built-in keepalive:
 * - `pingInterval: 120s` — SDK automatically sends ping frames
 * - `reconnectCount: -1` — infinite reconnect attempts
 * - `reconnectInterval: 120s` — reconnect delay
 *
 * A previous custom health check (Issue #1351, simplified in #1666) monitored
 * `lastMessageReceivedAt` and triggered reconnect when no message arrived within
 * 130s. However, `recordMessageReceived()` was only called from EventDispatcher
 * handlers, **not** from SDK-level ping/pong frames — causing ~15 false-positive
 * reconnections per 50 minutes (Issue #2905).
 *
 * This module now relies on SDK error/close events to detect connection failures,
 * and adds its own exponential-backoff reconnect with DNS pre-check on top of the
 * SDK's built-in mechanism.
 *
 * ### Architecture
 *
 * ```
 * connectFresh() → create WSClient + register error/close listeners
 *     ↓
 * SDK detects connection loss → emits 'close'/'error'
 *     ↓
 * initiateReconnect() → force-close old client → create new one with backoff
 * ```
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
 * @see https://github.com/hs3180/disclaude/issues/1666
 * @see https://github.com/hs3180/disclaude/issues/1351
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
 * Wraps the Feishu SDK's WSClient with connection state tracking and
 * exponential-backoff reconnection triggered by SDK error/close events.
 *
 * ### How it works (Issue #2905)
 *
 * 1. **Start**: Creates a WSClient and registers error/close listeners.
 *
 * 2. **SDK-driven reconnect**: When the SDK emits `error` or `close` events,
 *    the manager initiates its own reconnect sequence with exponential backoff
 *    and DNS pre-check.
 *
 * 3. **Connection state machine**: Explicit state tracking (connected, reconnecting, stopped).
 *
 * ### No custom health check
 *
 * The Feishu SDK already has built-in ping/pong with auto-reconnect
 * (pingInterval: 120s, reconnectCount: -1). A previous custom health check
 * (Issue #1351/#1666) that monitored `lastMessageReceivedAt` produced false
 * positives because it only tracked EventDispatcher events, not SDK-level
 * ping/pong frames — causing ~15 spurious reconnections per 50 minutes.
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

  // Issue #3292: Timing for reconnect cycle diagnostics
  private reconnectStartMs: number = 0;
  private lastStateChangeMs: number = 0;

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
        dnsCheckHost: this.dnsCheckHost,
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
   * Start the WebSocket connection.
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
   * After removing the custom health check (Issue #2905), this simply checks
   * if the connection state is 'connected'.
   */
  isHealthy(): boolean {
    return this._state === 'connected';
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * Create a fresh WSClient and connect.
   *
   * Registers error/close event listeners on the WSClient to trigger
   * reconnection when the SDK detects connection failures (Issue #2905).
   *
   * @returns `true` if connection succeeded
   */
  private async connectFresh(): Promise<boolean> {
    const sdkLogger = this.config.sdkLogger ?? createDefaultSdkLogger();
    const connectStartMs = Date.now(); // Issue #3292: track connection attempt timing
    logger.debug({ timing: 'ws:connect', attempt: this.reconnectAttempt, elapsedMs: 0 });

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

      // Register SDK error/close event listeners (Issue #2905)
      // These trigger reconnect when the SDK detects connection failures,
      // replacing the previous custom health check mechanism.
      if (typeof this.wsClient.on === 'function') {
        this.wsClient.on('error', (err: unknown) => {
          logger.warn({ err }, 'WSClient error event received');
        });

        this.wsClient.on('close', (code?: number, reason?: string) => {
          logger.warn(
            { code, reason, state: this._state, isReconnecting: this.isReconnecting },
            'WSClient close event received',
          );
          // Only trigger reconnect if we're currently connected and not already
          // in the reconnect loop — prevents double-reconnect
          if (this._state === 'connected' && !this.isReconnecting) {
            this.initiateReconnect();
          }
        });
      }

      this.reconnectAttempt = 0;
      this.transitionTo('connected');

      logger.info(
        { timing: 'ws:connect', attempt: this.reconnectAttempt, elapsedMs: Date.now() - connectStartMs, ok: true },
        'WebSocket connection established',
      );
      return true;
    } catch (error) {
      logger.error(
        { err: error, attempt: this.reconnectAttempt, timing: 'ws:connect', elapsedMs: Date.now() - connectStartMs, ok: false },
        'Failed to establish WebSocket connection',
      );
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
    this.reconnectStartMs = Date.now(); // Issue #3292: track reconnect start
    logger.info({ timing: 'ws:reconnect', elapsedMs: 0 });
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
      const reconnectDurationMs = Date.now() - this.reconnectStartMs; // Issue #3292
      logger.error(
        { attempt: this.reconnectAttempt, maxAttempts: this.reconnectMaxAttempts, timing: 'ws:reconnect', elapsedMs: reconnectDurationMs, ok: false },
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
      const reconnectDurationMs = Date.now() - this.reconnectStartMs; // Issue #3292
      logger.info(
        { attempt: this.reconnectAttempt, timing: 'ws:reconnect', elapsedMs: reconnectDurationMs, ok: true },
        'Reconnected successfully',
      );
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
    const now = Date.now();
    const sinceLastChangeMs = this.lastStateChangeMs ? now - this.lastStateChangeMs : undefined;
    this.lastStateChangeMs = now;
    logger.info(
      { oldState, newState, reconnectAttempt: this.reconnectAttempt, timing: 'ws:stateChange', sinceLastChangeMs },
      'Connection state changed',
    );
    this.emit('stateChange', newState);
  }
}
