/**
 * Global test setup for network isolation.
 *
 * This file establishes test isolation by blocking all external network requests
 * using nock, ensuring tests are hermetic and deterministic.
 *
 * @see Issue #918 - Four-layer defense architecture overview
 * @see Issue #920 - Test isolation infrastructure
 */

import nock from 'nock';
import { afterAll, afterEach, beforeAll } from 'vitest';

beforeAll(() => {
  // Block all external network requests by default
  nock.disableNetConnect();

  // Allow localhost connections for local test servers if needed
  nock.enableNetConnect('127.0.0.1');
  nock.enableNetConnect('localhost');
});

afterEach(() => {
  // Clean up all nock interceptors after each test
  nock.cleanAll();
});

afterAll(() => {
  // Restore network connections after all tests
  nock.restore();
});
