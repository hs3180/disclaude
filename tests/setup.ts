/**
 * Global test setup for VCR-style test isolation.
 *
 * This file establishes network isolation to prevent tests from making
 * real external network requests. All external HTTP calls are blocked
 * by default, except for localhost connections.
 *
 * Also provides automatic resource cleanup after each test file to prevent
 * orphaned cron jobs and timers from preventing the test process from
 * exiting gracefully.
 *
 * @see Issue #920 - Test isolation infrastructure
 * @see Issue #918 - Four-layer defense architecture
 * @see Issue #3415 - Test process not exiting gracefully, cron not cleaned up
 */

import nock from 'nock';
import { beforeAll, afterAll, afterEach } from 'vitest';
import { cleanupAllTracked } from './test-resource-tracker.js';

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
 * Clean up all tracked test resources after each test file.
 *
 * With singleFork mode (all tests in one process), this ensures
 * resources (schedulers, cron jobs) from the current test file
 * are cleaned up before the next file runs.
 *
 * Prevents orphaned cron jobs from accumulating and keeping the
 * event loop alive, which would force vitest to SIGKILL the process.
 *
 * @see tests/test-resource-tracker.ts for resource tracking API
 * @see Issue #3415 - Test process not exiting gracefully, cron not cleaned up
 */
afterAll(async () => {
  await cleanupAllTracked();
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
