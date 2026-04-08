import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * These tests are separate from the main test suite because they:
 * 1. Require real Feishu API credentials (FEISHU_INTEGRATION_TEST=true)
 * 2. Need a running Primary Node with IPC enabled
 * 3. Should NOT run in CI by default
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @see Issue #1626 - Feishu integration test framework
 */

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/feishu/**/*.test.ts'],
    exclude: [
      'node_modules/',
      'dist/',
    ],
    env: {
      NODE_ENV: 'test',
      PINO_DISABLE_DIAGNOSTICS: '1',
    },
    // Single-fork mode for memory efficiency
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Integration tests may need longer timeouts
    testTimeout: 30000,
    hookTimeout: 30000,
    // No coverage for integration tests
    coverage: {
      enabled: false,
    },
    // Do NOT use the global test setup that blocks network
    // Integration tests need real network access to IPC socket
    setupFiles: [],
  },
});
