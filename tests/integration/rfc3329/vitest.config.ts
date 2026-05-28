import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for RFC #3329 integration tests.
 *
 * Tests the cross-component integration of:
 * - ProjectManager / CwdProvider
 * - Input MessageRouter
 * - Scheduler → MessageRouter → Handler
 * - Output MessageRouter (level-based routing)
 *
 * Uses real internal components with mock external dependencies.
 * No real Feishu/SDK credentials needed.
 *
 * @see Issue #3662
 */

const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/rfc3329/**/*.test.ts'],
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
