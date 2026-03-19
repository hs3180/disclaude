import * as lark from '@larksuiteoapi/node-sdk';
import { createLogger } from '@disclaude/core';
import type WebSocket from 'ws';

const logger = createLogger('WSHealthClient');

/**
 * Constructor params for lark.WSClient.
 * Copied since the SDK doesn't export IConstructorParams.
 */
interface WSClientParams {
  appId: string;
  appSecret: string;
  domain?: string | lark.Domain;
  logger?: Record<string, (...args: unknown[]) => void>;
  loggerLevel?: lark.LoggerLevel;
  httpInstance?: unknown;
  autoReconnect?: boolean;
  agent?: unknown;
}

/**
 * Health-aware WSClient that detects silent WebSocket disconnections.
 *
 * Inherits lark.WSClient and overrides start() to attach a health monitor.
 * The monitor tracks the last received message time and triggers a force
 * reconnect if no messages (including pong frames) arrive within the timeout.
 *
 * This addresses the issue where NAT/firewall silently drops connections,
 * leaving readyState as OPEN while the SDK's pingLoop never detects the failure.
 */
export class HealthAwareWSClient extends (lark.WSClient as unknown as { new(params: WSClientParams): lark.WSClient }) {
  private lastMessageTime = 0;
  private healthCheckTimer?: ReturnType<typeof setInterval>;
  private isReconnecting = false;
  private storedEventDispatcher?: lark.EventDispatcher;
  private wsMessageListener?: (buffer: Buffer) => void;

  /** Timeout: 3 x SDK default ping interval (3 x 120s = 360s) */
  private static readonly PONG_TIMEOUT_MS = 3 * 120 * 1000;
  /** Health check interval */
  private static readonly CHECK_INTERVAL_MS = 30_000;

  constructor(params: WSClientParams) {
    super(params);
  }

  async start(params: { eventDispatcher: lark.EventDispatcher }): Promise<void> {
    this.storedEventDispatcher = params.eventDispatcher;
    await super.start(params);
    this.attachHealthMonitor();
  }

  private attachHealthMonitor(): void {
    // Access the native WebSocket instance via SDK internals
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-destructuring
    const wsConfig: any = (this as any).wsConfig;
    const wsInstance: WebSocket | undefined = wsConfig?.getWSInstance?.();
    if (!wsInstance) {
      logger.warn('Cannot attach health monitor: WebSocket instance not available');
      return;
    }

    this.lastMessageTime = Date.now();

    // Track all incoming frames (pong, business events, etc.)
    this.wsMessageListener = () => {
      this.lastMessageTime = Date.now();
    };
    wsInstance.on('message', this.wsMessageListener);

    this.healthCheckTimer = setInterval(() => this.checkHealth(), HealthAwareWSClient.CHECK_INTERVAL_MS);
    logger.info({ timeoutMs: HealthAwareWSClient.PONG_TIMEOUT_MS }, 'Health monitor started');
  }

  private checkHealth(): void {
    if (this.isReconnecting) {
      return;
    }

    const elapsed = Date.now() - this.lastMessageTime;
    if (elapsed > HealthAwareWSClient.PONG_TIMEOUT_MS) {
      logger.warn({ elapsedMs: elapsed }, 'WebSocket health check failed: no messages received, reconnecting');
      void this.forceReconnect();
    }
  }

  private async forceReconnect(): Promise<void> {
    if (this.isReconnecting || !this.storedEventDispatcher) {
      return;
    }
    this.isReconnecting = true;

    this.detachHealthMonitor();

    try {
      // Force-close the dead connection (terminate immediately, no close frame)
      this.close({ force: true });
      logger.info('Dead connection closed, reconnecting...');

      await super.start({ eventDispatcher: this.storedEventDispatcher });
      this.attachHealthMonitor();
      logger.info('Reconnect success');
    } catch (error) {
      logger.error({ err: error }, 'Force reconnect failed, will retry on next check');
      // Restart timer so next check can retry
      this.healthCheckTimer = setInterval(() => this.checkHealth(), HealthAwareWSClient.CHECK_INTERVAL_MS);
    } finally {
      this.isReconnecting = false;
    }
  }

  private detachHealthMonitor(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = undefined;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, prefer-destructuring
    const wsConfig: any = (this as any).wsConfig;
    const wsInstance: WebSocket | undefined = wsConfig?.getWSInstance?.();
    if (wsInstance && this.wsMessageListener) {
      wsInstance.off('message', this.wsMessageListener);
      this.wsMessageListener = undefined;
    }
  }

  close(params?: { force?: boolean }): void {
    this.detachHealthMonitor();
    super.close(params);
  }
}
