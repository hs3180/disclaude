import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for chat skill integration tests.
 *
 * These tests call real lark-cli and use real filesystem I/O.
 * No Feishu credentials or mocking — tests skip automatically
 * when lark-cli is unavailable.
 *
 * Run with: npm run test:chat
 *
 * @see Issue #3284
 */

const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/chat/**/*.test.ts'],
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
    testTimeout: isCI ? 60000 : 30000,
    hookTimeout: isCI ? 60000 : 30000,
    // No setupFiles — do NOT load tests/setup.ts which blocks external network.
    // lark-cli calls go through child_process, not Node.js HTTP.
  },
});
