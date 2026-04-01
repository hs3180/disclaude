import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * Key differences from the default vitest.config.ts:
 * - Only includes integration test files (packages/primary-node/src/__tests__/integration/**)
 * - Does NOT use the nock-based setupFiles (integration tests need real network access)
 * - No coverage thresholds (integration tests are not counted toward coverage)
 * - Longer default timeouts (integration tests involve real I/O)
 *
 * @see Issue #1626 - Optional Feishu integration test framework
 */

const isCI = process.env.CI === 'true';
const testTimeout = isCI ? 60000 : 30000;
const hookTimeout = isCI ? 60000 : 30000;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/primary-node/src/__tests__/integration/**/*.test.ts'],
    exclude: [
      'node_modules/',
      'dist/',
      '**/workspace/**',
    ],
    env: {
      NODE_ENV: 'test',
      // Note: PINO_DISABLE_DIAGNOSTICS is NOT set here because integration
      // tests may need pino diagnostics for debugging
    },
    // Use single-fork mode to prevent multiple worker processes (same as default)
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Longer timeouts for integration tests (real network I/O)
    testTimeout,
    hookTimeout,
    // No setupFiles — integration tests need real network access,
    // unlike unit tests which use nock to block external connections
    setupFiles: [],
  },
});
