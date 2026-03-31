import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * This is a separate config because Feishu integration tests are
 * excluded from the regular test runner via vitest.config.ts.
 *
 * Run with: FEISHU_INTEGRATION_TEST=true npm run test:feishu
 *
 * @see Issue #1626 — Optional Feishu integration tests (skip by default)
 */

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/primary-node/src/__tests__/integration/feishu/**/*.test.ts'],
    exclude: [
      'node_modules/',
      'dist/',
      '**/workspace/**',
    ],
    env: {
      NODE_ENV: 'test',
      PINO_DISABLE_DIAGNOSTICS: '1',
    },
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./tests/setup.ts'],
  },
});
