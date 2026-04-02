import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * These tests are isolated from the regular unit test suite:
 * - No nock network isolation (tests make real Feishu API calls)
 * - Longer timeouts for API calls (60 seconds)
 * - Only includes files in tests/integration/feishu/
 *
 * @see Issue #1626 - Optional Feishu integration tests
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true FEISHU_TEST_APP_ID=xxx \
 *   FEISHU_TEST_APP_SECRET=xxx FEISHU_TEST_CHAT_ID=oc_xxx \
 *   npx vitest --run --config vitest.config.feishu.ts
 */

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/feishu/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    // Longer timeout for real API calls
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Use single-fork mode to prevent multiple worker processes (OOM prevention)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // No nock setup — these tests need real network access
    // No coverage collection for integration tests
  },
});
