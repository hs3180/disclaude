import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * This is a separate config from the main vitest.config.ts to:
 * 1. NOT use the nock-based setup file (tests need real HTTP access)
 * 2. Include only tests/feishu/ directory
 * 3. Use longer timeouts for real API calls
 * 4. Exclude from coverage thresholds (integration tests shouldn't affect coverage)
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true FEISHU_TEST_CHAT_ID=<id> npm run test:feishu
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/feishu/**/*.test.ts'],
    // Integration tests need longer timeouts
    testTimeout: 60000,
    hookTimeout: 60000,
    // Use single-fork mode consistent with main config
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // NO setupFiles - we don't want nock blocking real network access
    // The main tests/setup.ts uses nock to block external HTTP,
    // but Feishu integration tests need real network connectivity.
    env: {
      NODE_ENV: 'test',
    },
    // Exclude from coverage - integration tests are for E2E validation
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      exclude: [
        'tests/**',
        'node_modules/**',
      ],
    },
  },
});
