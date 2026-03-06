/**
 * Vitest global setup file for test isolation.
 *
 * This setup file implements VCR-style test isolation by:
 * 1. Blocking all external network requests by default
 * 2. Allowing localhost/127.0.0.1 for local testing
 * 3. Providing a mechanism for recorded network responses (fixtures)
 *
 * @see Issue #914 - Epic 1: 基础设施改造与测试环境隔离
 */

import nock from 'nock';

/**
 * Global setup: Configure network isolation before all tests.
 *
 * This prevents tests from making accidental real network calls,
 * which could cause flaky tests or unwanted side effects.
 */
beforeAll(() => {
  // Disable all external network requests by default
  // This forces tests to either mock responses or use recorded fixtures
  nock.disableNetConnect();

  // Allow localhost connections for:
  // - In-memory test servers
  // - Health check endpoints
  // - Local integration tests
  nock.enableNetConnect('127.0.0.1');
  nock.enableNetConnect('localhost');
});

/**
 * Global teardown: Clean up nock after all tests.
 */
afterAll(() => {
  nock.cleanAll();
  nock.enableNetConnect();
});

/**
 * Per-test cleanup: Reset nock between tests.
 */
afterEach(() => {
  nock.cleanAll();
});

/**
 * Helper to allow specific hosts for a test.
 *
 * Usage in tests:
 * ```typescript
 * import { allowHost } from './setup';
 *
 * describe('my test', () => {
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
 * Helper to block a host (re-block after allowing).
 */
export function blockHost(host: string): void {
  nock.disableNetConnect();
  nock.enableNetConnect('127.0.0.1');
  nock.enableNetConnect('localhost');
}

// Re-export nock for convenience in test files
export { nock };
