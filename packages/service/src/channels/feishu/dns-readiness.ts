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
import { createLogger } from '@disclaude/core';

const logger = createLogger('FeishuStartupReadiness');

/** Options shared by the DNS and connection readiness waits. */
export interface ReadinessWaitOptions {
  /** Hostname resolved on every probe (getaddrinfo semantics). */
  host: string;
  /** Delay before the second probe; default 500 ms. */
  baseDelayMs?: number;
  /** Per-delay cap for the exponential backoff; default 5_000 ms. */
  maxDelayMs?: number;
  /**
   * Total bound across all probes; on expiry the wait gives up and reports
   * not ready. Default 30_000 ms.
   */
  totalTimeoutMs?: number;
  /** Cancellation; abort resolves as not ready instead of rejecting. */
  signal?: AbortSignal;
  /** Injectable lookup probe for tests. */
  lookup?: (host: string) => Promise<unknown>;
}

/** Outcome of a bounded readiness wait. */
export interface ReadinessResult {
  /** Whether the probed condition held before the bound expired. */
  ready: boolean;
  /** Number of probes issued. */
  attempts: number;
  /** Wall-clock ms from wait start to outcome. */
  elapsedMs: number;
  /** Whether the wait ended because the AbortSignal fired. */
  aborted: boolean;
  /** Last probe error code (e.g. ENOTFOUND), when known. */
  lastErrorCode?: string;
}

/** Outcome of the two-phase startup wait; `ready` implies a live connection. */
export interface StartupReadinessResult extends ReadinessResult {
  /** Whether the DNS phase succeeded (the connection phase may still fail). */
  dnsReady: boolean;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error) {
    const { code } = error as { code?: unknown };
    return typeof code === 'string' ? code : String(code);
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Poll `probe` with exponential backoff until it resolves, the total bound
 * expires, or the signal aborts. Never a fixed sleep: every delay is derived
 * from the backoff sequence and every outcome is logged for observability.
 */
async function pollWithBackoff(
  probe: () => void | Promise<void>,
  label: string,
  options: ReadinessWaitOptions,
): Promise<ReadinessResult> {
  const { baseDelayMs = 500, maxDelayMs = 5_000, totalTimeoutMs = 30_000, signal } = options;
  const startedAt = Date.now();
  let delayMs = baseDelayMs;
  let attempts = 0;
  let lastErrorCode: string | undefined;
  for (;;) {
    attempts++;
    try {
      await probe();
      const elapsedMs = Date.now() - startedAt;
      logger.info({ timing: `startup:${label}`, ok: true, attempts, elapsedMs }, `${label} ready (#5519)`);
      return { ready: true, attempts, elapsedMs, aborted: false };
    } catch (error) {
      lastErrorCode = errorCode(error);
    }    const elapsedMs = Date.now() - startedAt;
    if (signal?.aborted) {
      logger.warn(
        { timing: `startup:${label}`, ok: false, attempts, elapsedMs, aborted: true, lastErrorCode },
        `${label} wait cancelled (#5519)`,
      );
      return { ready: false, attempts, elapsedMs, aborted: true, lastErrorCode };
    }
    if (elapsedMs + delayMs >= totalTimeoutMs) {
      logger.warn(
        { timing: `startup:${label}`, ok: false, attempts, elapsedMs, lastErrorCode },
        `${label} not ready within the startup bound; continuing without it (#5519)`,
      );
      return { ready: false, attempts, elapsedMs, aborted: false, lastErrorCode };
    }
    // Abort wakes the backoff sleep immediately, so cancellation never waits
    // out the current (possibly 30 s) backoff interval.
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = (): void => { done(); };
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
export async function waitForDnsReady(options: ReadinessWaitOptions): Promise<ReadinessResult> {
  const lookup = options.lookup ?? ((host: string) => dns.lookup(host));
  return await pollWithBackoff(async () => {
    if (options.signal?.aborted) { throw Object.assign(new Error('wait cancelled'), { code: 'ABORTED' }); }
    await lookup(options.host);
  }, 'dns', options);
}

/**
 * Wait for DNS readiness and then for a real connection, sharing one total
 * bound. `ready` is only true after `isConnectionReady` reports an
 * established connection, so callers never report the channel available on a
 * DNS success or a start() acknowledgement alone.
 */
export async function waitForStartupReadiness(
  options: ReadinessWaitOptions & { isConnectionReady: () => boolean },
): Promise<StartupReadinessResult> {
  const { baseDelayMs = 500, maxDelayMs = 5_000, totalTimeoutMs = 30_000, signal } = options;
  const deadline = Date.now() + totalTimeoutMs;
  const remaining = (): number => Math.max(deadline - Date.now(), 0);
  const dnsResult = await waitForDnsReady({ ...options, totalTimeoutMs: remaining() });
  if (!dnsResult.ready) {
    return { ...dnsResult, dnsReady: false };
  }
  const connection = await pollWithBackoff(() => {
    if (signal?.aborted) { throw Object.assign(new Error('aborted'), { code: 'ABORTED' }); }
    if (!options.isConnectionReady()) {
      throw Object.assign(new Error('connection not established'), { code: 'NOT_CONNECTED' });
    }
  }, 'connection', { ...options, baseDelayMs, maxDelayMs, totalTimeoutMs: remaining() });
  return { ...connection, dnsReady: true };
}
