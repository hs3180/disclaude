/**
 * Bounded startup readiness wait for the Feishu channel (Issue #5519).
 *
 * launchd autostart can outrun the network stack: right after boot
 * `getaddrinfo` answers ENOTFOUND for open.feishu.cn, so the Feishu SDK
 * connection never establishes — yet the startup sequence used to report the
 * channel as available the moment the (non-blocking) connection manager
 * returned. These helpers let the startup sequence wait for observable
 * readiness before claiming availability:
 *
 * - `waitForDnsReady` polls `dns.promises.lookup` (getaddrinfo — the exact
 *   call that fails in the issue) with exponential backoff, never a fixed
 *   sleep, cancellable through an AbortSignal, and gives up honestly after a
 *   bounded total timeout.
 * - `waitForStartupReadiness` continues with a connection probe so readiness
 *   is only reported after the real websocket handshake, never after a mere
 *   start() acknowledgement.
 *
 * Giving up is bounded and honest: the caller reports the channel as not
 * ready while the connection manager keeps retrying in the background, so the
 * connection still completes automatically once the network recovers.
 *
 * @module channels/feishu/dns-readiness
 */
import dns from 'node:dns/promises';
import { createLogger } from "../../../../core/dist/index.js";
const logger = createLogger('FeishuStartupReadiness');
function errorCode(error) {
    if (error && typeof error === 'object' && 'code' in error) {
        const { code } = error;
        return typeof code === 'string' ? code : String(code);
    }
    return error instanceof Error ? error.message : String(error);
}
/**
 * Poll `probe` with exponential backoff until it resolves, the total bound
 * expires, or the signal aborts. Never a fixed sleep: every delay is derived
 * from the backoff sequence and every outcome is logged for observability.
 */
async function pollWithBackoff(probe, label, options) {
    const { baseDelayMs = 500, maxDelayMs = 5_000, totalTimeoutMs = 30_000, signal } = options;
    const startedAt = Date.now();
    let delayMs = baseDelayMs;
    let attempts = 0;
    let lastErrorCode;
    for (;;) {
        attempts++;
        try {
            await probe();
            const elapsedMs = Date.now() - startedAt;
            logger.info({ timing: `startup:${label}`, ok: true, attempts, elapsedMs }, `${label} ready (#5519)`);
            return { ready: true, attempts, elapsedMs, aborted: false };
        }
        catch (error) {
            lastErrorCode = errorCode(error);
        }
        const elapsedMs = Date.now() - startedAt;
        if (signal?.aborted) {
            logger.warn({ timing: `startup:${label}`, ok: false, attempts, elapsedMs, aborted: true, lastErrorCode }, `${label} wait cancelled (#5519)`);
            return { ready: false, attempts, elapsedMs, aborted: true, lastErrorCode };
        }
        if (elapsedMs + delayMs >= totalTimeoutMs) {
            logger.warn({ timing: `startup:${label}`, ok: false, attempts, elapsedMs, lastErrorCode }, `${label} not ready within the startup bound; continuing without it (#5519)`);
            return { ready: false, attempts, elapsedMs, aborted: false, lastErrorCode };
        }
        // Abort wakes the backoff sleep immediately, so cancellation never waits
        // out the current (possibly 30 s) backoff interval.
        await new Promise((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', onAbort);
                resolve();
            };
            const onAbort = () => { done(); };
            const timer = setTimeout(done, delayMs);
            signal?.addEventListener('abort', onAbort, { once: true });
        });
        delayMs = Math.min(delayMs * 2, maxDelayMs);
    }
}
/**
 * Wait until `dns.promises.lookup` resolves `host` — i.e. until the OS
 * resolver can actually answer for the Feishu endpoint.
 */
export async function waitForDnsReady(options) {
    const lookup = options.lookup ?? ((host) => dns.lookup(host));
    return await pollWithBackoff(async () => {
        if (options.signal?.aborted) {
            throw Object.assign(new Error('wait cancelled'), { code: 'ABORTED' });
        }
        await lookup(options.host);
    }, 'dns', options);
}
/**
 * Wait for DNS readiness and then for a real connection, sharing one total
 * bound. `ready` is only true after `isConnectionReady` reports an
 * established connection, so callers never report the channel available on a
 * DNS success or a start() acknowledgement alone.
 */
export async function waitForStartupReadiness(options) {
    const { baseDelayMs = 500, maxDelayMs = 5_000, totalTimeoutMs = 30_000, signal } = options;
    const deadline = Date.now() + totalTimeoutMs;
    const remaining = () => Math.max(deadline - Date.now(), 0);
    const dnsResult = await waitForDnsReady({ ...options, totalTimeoutMs: remaining() });
    if (!dnsResult.ready) {
        return { ...dnsResult, dnsReady: false };
    }
    const connection = await pollWithBackoff(() => {
        if (signal?.aborted) {
            throw Object.assign(new Error('aborted'), { code: 'ABORTED' });
        }
        if (!options.isConnectionReady()) {
            throw Object.assign(new Error('connection not established'), { code: 'NOT_CONNECTED' });
        }
    }, 'connection', { ...options, baseDelayMs, maxDelayMs, totalTimeoutMs: remaining() });
    return { ...connection, dnsReady: true };
}
