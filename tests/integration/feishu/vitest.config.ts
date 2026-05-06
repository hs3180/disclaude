import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu IPC integration tests.
 *
 * These tests use mock IPC handlers and real Unix socket transport.
 * No real Feishu credentials needed.
 *
 * Run with: npm run test:feishu
 *
 * @see Issue #1626
 */

const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/feishu/**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
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
    testTimeout: isCI ? 30000 : 10000,
    hookTimeout: isCI ? 30000 : 10000,
    setupFiles: ['./tests/setup.ts'],
  },
});
