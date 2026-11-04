/**
 * Track Feishu's actual SDK lifecycle. DNS/initial connection attempts run in
 * the background; an SDK start acknowledgement is never a readiness receipt.
 * The SDK owns live reconnects. Only terminal/initial failures create a fresh
 * client, with DNS preflight and bounded backoff. No business-message watchdog.
 */
import dns from 'dns/promises';
import { EventEmitter } from 'events';
import { WS_HEALTH, createLogger } from "../../../../core/dist/index.js";
import * as lark from '@larksuiteoapi/node-sdk';
const logger = createLogger('WsConnectionManager');
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
export function calculateReconnectDelay(attempt, baseDelayMs, maxDelayMs, jitterMs) {
    const exponentialDelay = baseDelayMs * Math.pow(WS_HEALTH.RECONNECT.BACKOFF_MULTIPLIER, attempt);
    const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
    const jitter = Math.floor(Math.random() * jitterMs);
    return Math.min(cappedDelay + jitter, maxDelayMs);
}
/**
 * Default SDK logger that routes through the manager's pino logger.
 */
function createDefaultSdkLogger() {
    return {
        error: (...msg) => logger.error({ context: 'LarkSDK' }, String(msg)),
        warn: (...msg) => logger.warn({ context: 'LarkSDK' }, String(msg)),
        info: (...msg) => logger.info({ context: 'LarkSDK' }, String(msg)),
        debug: (...msg) => logger.debug({ context: 'LarkSDK' }, String(msg)),
        trace: (...msg) => logger.trace({ context: 'LarkSDK' }, String(msg)),
    };
}
export class WsConnectionManager extends EventEmitter {
    config;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    wsClient;
    eventDispatcher;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    larkSDK;
    // State machine
    _state = 'stopped';
    started = false;
    generation = 0;
    connectTimer;
    dnsAbort;
    // Reconnect state
    reconnectAttempt = 0;
    reconnectTimer;
    isReconnecting = false;
    reconnectBaseDelayMs;
    reconnectMaxDelayMs;
    reconnectMaxAttempts;
    // Issue #3292: Timing for reconnect cycle diagnostics
    reconnectStartMs = 0;
    lastStateChangeMs = 0;
    // DNS pre-check (Issue #2259)
    dnsCheckHost;
    constructor(config) {
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
        logger.info({
            reconnectBaseDelayMs: this.reconnectBaseDelayMs,
            reconnectMaxDelayMs: this.reconnectMaxDelayMs,
            reconnectMaxAttempts: this.reconnectMaxAttempts,
            dnsCheckHost: this.dnsCheckHost,
        }, 'WsConnectionManager created');
    }
    // ─── Public API ──────────────────────────────────────────────────────────
    /**
     * Get current connection state.
     */
    get state() {
        return this._state;
    }
    /**
     * Get connection health metrics for observability / monitoring.
     */
    getMetrics() {
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
    async start(eventDispatcher) {
        if (this.started) {
            return;
        }
        this.started = true;
        this.eventDispatcher = eventDispatcher;
        this.dnsAbort = new AbortController();
        const generation = ++this.generation;
        // Scheduling the attempt must not hold up other channels or local HTTP.
        void this.performReconnectAttempt(generation, true);
        await Promise.resolve();
    }
    /** Stop DNS, timers and SDK ownership before any asynchronous work resumes. */
    async stop() {
        this.started = false;
        this.generation++;
        this.dnsAbort?.abort();
        this.clearReconnectTimer();
        this.closeClient();
        this.transitionTo('stopped');
        this.isReconnecting = false;
        this.reconnectAttempt = 0;
        await Promise.resolve();
    }
    /**
     * Check if the connection is currently healthy.
     *
     * After removing the custom health check (Issue #2905), this simply checks
     * if the connection state is 'connected'.
     */
    isHealthy() {
        return this._state === 'connected';
    }
    // ─── Connection lifecycle ────────────────────────────────────────────────
    /** Start one SDK owner; only its lifecycle callbacks may declare readiness. */
    async connectFresh(generation) {
        if (!this.started || generation !== this.generation) {
            return;
        }
        const connectStartMs = Date.now();
        this.transitionTo('connecting');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let client;
        const ownsClient = () => this.started && this.generation === generation && this.wsClient === client;
        const ready = () => {
            if (!ownsClient() || this._state === 'connected') {
                return;
            }
            this.clearConnectTimer();
            const attempt = this.reconnectAttempt;
            this.reconnectAttempt = 0;
            this.isReconnecting = false;
            this.transitionTo('connected');
            logger.info({ timing: 'ws:connect', attempt, elapsedMs: Date.now() - connectStartMs, ok: true }, 'WebSocket connection established');
            // Also flush messages queued before the very first handshake.
            this.emit('reconnected', attempt);
        };
        try {
            client = new this.larkSDK.WSClient({
                appId: this.config.appId,
                appSecret: this.config.appSecret,
                logger: this.config.sdkLogger ?? createDefaultSdkLogger(),
                loggerLevel: this.config.sdkLogLevel ?? this.larkSDK.LoggerLevel.info,
                handshakeTimeoutMs: this.config.connectTimeoutMs ?? 30_000,
                onReady: ready,
                onReconnected: ready,
                onReconnecting: () => {
                    if (ownsClient()) {
                        this.transitionTo('reconnecting');
                    }
                },
                onError: () => {
                    if (ownsClient()) {
                        this.initiateReconnect();
                    }
                },
            });
            this.wsClient = client;
            this.connectTimer = setTimeout(() => {
                if (ownsClient()) {
                    this.initiateReconnect();
                }
            }, this.config.connectTimeoutMs ?? 30_000);
            this.connectTimer.unref?.();
            const result = await client.start({ eventDispatcher: this.eventDispatcher });
            if (ownsClient() && result === false) {
                this.initiateReconnect();
            }
        }
        catch {
            // SDK errors can contain credentials; lifecycle state is sufficient here.
            if (this.started && generation === this.generation && (!client || ownsClient())) {
                this.initiateReconnect();
            }
        }
    }
    /**
     * Force-close the current WSClient.
     *
     * Calls `removeAllListeners()` before closing to prevent event listener
     * accumulation across reconnect cycles (Issue #2259 — MaxListenersExceededWarning).
     */
    closeClient() {
        this.clearConnectTimer();
        const client = this.wsClient;
        this.wsClient = undefined; // Invalidate callbacks before close can invoke them.
        if (client) {
            try {
                // Prevent listener accumulation: old WSClient instances may hold
                // registered event listeners that pile up across reconnect cycles.
                if (typeof client.removeAllListeners === 'function') {
                    client.removeAllListeners();
                }
                client.close({ force: true });
            }
            catch (error) {
                logger.debug({ err: error }, 'Error while closing WSClient');
            }
            this.wsClient = undefined;
        }
    }
    // ─── Reconnection ────────────────────────────────────────────────────────
    /**
     * Begin the reconnect sequence with exponential backoff + jitter.
     */
    initiateReconnect() {
        if (!this.started || this.isReconnecting) {
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
    scheduleReconnectAttempt() {
        this.clearReconnectTimer();
        if (!this.started) {
            return;
        }
        if (this.reconnectMaxAttempts >= 0 && this.reconnectAttempt >= this.reconnectMaxAttempts) {
            const reconnectDurationMs = Date.now() - this.reconnectStartMs; // Issue #3292
            logger.error({ attempt: this.reconnectAttempt, maxAttempts: this.reconnectMaxAttempts, timing: 'ws:reconnect', elapsedMs: reconnectDurationMs, ok: false }, 'Max reconnect attempts exhausted');
            this.isReconnecting = false;
            this.started = false;
            this.dnsAbort?.abort();
            this.transitionTo('stopped');
            this.emit('reconnectFailed', this.reconnectAttempt);
            return;
        }
        const delay = calculateReconnectDelay(this.reconnectAttempt, this.reconnectBaseDelayMs, this.reconnectMaxDelayMs, WS_HEALTH.RECONNECT.JITTER_MS);
        logger.info({ attempt: this.reconnectAttempt, delayMs: delay }, 'Scheduling reconnect attempt');
        const { generation } = this;
        this.reconnectTimer = setTimeout(() => {
            void this.performReconnectAttempt(generation);
        }, delay);
        if (this.reconnectTimer.unref) {
            this.reconnectTimer.unref();
        }
    }
    /** DNS failures never construct an SDK client or block local startup. */
    async performReconnectAttempt(generation, initial = false) {
        if (!this.started || generation !== this.generation) {
            return;
        }
        if (!initial) {
            this.reconnectAttempt++;
        }
        if (this.dnsCheckHost) {
            this.transitionTo('waiting_dns');
            let ready = false;
            try {
                ready = await this.checkDns(this.dnsCheckHost);
            }
            catch { /* Retry below. */ }
            if (!this.started || generation !== this.generation) {
                return;
            }
            if (!ready) {
                this.isReconnecting = true;
                this.scheduleReconnectAttempt();
                return;
            }
        }
        if (!this.started || generation !== this.generation) {
            return;
        }
        this.isReconnecting = false;
        await this.connectFresh(generation);
    }
    /** A cancellable, bounded resolver per probe; never cancel another caller's DNS. */
    async checkDns(host) {
        const signal = this.dnsAbort?.signal;
        if (signal?.aborted) {
            return false;
        }
        const timeoutMs = this.config.dnsTimeoutMs ?? 3_000;
        const resolver = new dns.Resolver({ timeout: timeoutMs, tries: 1 });
        return await new Promise((resolve) => {
            const finish = (ready) => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', cancel);
                resolve(ready);
            };
            const cancel = () => { resolver.cancel(); finish(false); };
            const timer = setTimeout(cancel, timeoutMs);
            timer.unref?.();
            signal?.addEventListener('abort', cancel, { once: true });
            void resolver.resolve(host).then(() => finish(true), () => finish(false));
        });
    }
    clearConnectTimer() {
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = undefined;
        }
    }
    clearReconnectTimer() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }
    // ─── State machine ───────────────────────────────────────────────────────
    transitionTo(newState) {
        if (this._state === newState) {
            return;
        }
        const oldState = this._state;
        this._state = newState;
        const now = Date.now();
        const sinceLastChangeMs = this.lastStateChangeMs ? now - this.lastStateChangeMs : undefined;
        this.lastStateChangeMs = now;
        logger.info({ oldState, newState, reconnectAttempt: this.reconnectAttempt, timing: 'ws:stateChange', sinceLastChangeMs }, 'Connection state changed');
        this.emit('stateChange', newState);
    }
}
