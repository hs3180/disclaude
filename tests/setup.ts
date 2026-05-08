/**
 * Global test setup for VCR-style test isolation.
 *
 * This file establishes network isolation to prevent tests from making
 * real external network requests. All external HTTP calls are blocked
 * by default, except for localhost connections.
 *
 * Issue #3415: Added SIGTERM/SIGINT handlers for graceful test process
 * shutdown. When the test runner is terminated (e.g., by CI timeout or
 * user interrupt), registered cleanup callbacks are invoked before exit.
 *
 * @see Issue #920 - Test isolation infrastructure
 * @see Issue #918 - Four-layer defense architecture
 * @see Issue #3415 - Test process graceful exit & cron cleanup
 */

import nock from 'nock';
import { beforeAll, afterAll, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Graceful shutdown registry (Issue #3415)
// ---------------------------------------------------------------------------

/**
 * Registered cleanup callbacks invoked on SIGTERM/SIGINT.
 * Tests that create long-lived resources (cron jobs, servers, timers)
 * should register a cleanup function here.
 */
const cleanupCallbacks: Array<() => void | Promise<void>> = [];

/**
 * Register a cleanup callback to be invoked on graceful shutdown.
 *
 * @example
 * ```typescript
 * import { onGracefulShutdown } from '../tests/setup.js';
 *
 * const scheduler = new Scheduler({ ... });
 * onGracefulShutdown(() => scheduler.stop());
 * ```
 */
export function onGracefulShutdown(callback: () => void | Promise<void>): void {
  cleanupCallbacks.push(callback);
}

let isShuttingDown = false;

/**
 * Graceful shutdown handler — invoked on SIGTERM or SIGINT.
 * Runs all registered cleanup callbacks sequentially, then exits.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`\n[Test Setup] Received ${signal}, running ${cleanupCallbacks.length} cleanup callback(s)...`);

  for (const cb of cleanupCallbacks) {
    try {
      await cb();
    } catch {
      // Best-effort cleanup — don't let one failure block the rest
    }
  }

  process.exit(signal === 'SIGINT' ? 130 : 143); // Standard exit codes
}

// Register signal handlers (only in test process, not workers)
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Network isolation (nock)
// ---------------------------------------------------------------------------

/**
 * Block all external network requests by default.
 * Only localhost and 127.0.0.1 are allowed.
 */
beforeAll(() => {
  // Disable all network connections
  nock.disableNetConnect();

  // Allow localhost connections for local test servers
  nock.enableNetConnect('127.0.0.1');
  nock.enableNetConnect('localhost');
});

/**
 * Clean up all nock interceptors after each test.
 */
afterEach(() => {
  nock.cleanAll();
});

/**
 * Restore network connectivity after all tests.
 */
afterAll(() => {
  nock.restore();
});

/**
 * Helper function to allow specific hosts for testing.
 * Use this when a test needs to make real requests to specific hosts.
 *
 * @param host - The host to allow (e.g., 'api.example.com')
 *
 * @example
 * ```typescript
 * import { allowHost } from '../tests/setup.js';
 *
 * describe('API tests', () => {
 *   beforeAll(() => {
 *     allowHost('api.example.com');
 *   });
 * });
 * ```
 */
export function allowHost(host: string): void {
  nock.enableNetConnect(host);
}

/**
 * Helper function to block specific hosts.
 * Use this to re-block a host that was previously allowed.
 *
 * @param host - The host to block
 */
export function blockHost(host: string): void {
  nock.disableNetConnect(host);
}
