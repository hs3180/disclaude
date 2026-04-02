/**
 * Vitest configuration for Feishu integration tests.
 *
 * This config is used by `npm run test:feishu` and intentionally
 * does NOT exclude the integration test directory.
 *
 * @see Issue #1626 - Optional Feishu integration tests
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/__tests__/integration/**/*.test.ts'],
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
