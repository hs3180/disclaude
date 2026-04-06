import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Feishu integration tests.
 *
 * Key differences from the main vitest.config.ts:
 * - No nock network isolation (tests need real Feishu API access)
 * - Separate setup file without network blocking
 * - Only includes Feishu integration test files
 * - Longer timeouts for API calls
 *
 * Issue #1626: Optional Feishu integration test framework.
 *
 * Usage:
 *   FEISHU_INTEGRATION_TEST=true npm run test:feishu
 */

const isCI = process.env.CI === 'true';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/feishu/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/'],
    env: {
      NODE_ENV: 'test',
      // Disable pino diagnostics_channel to fix compatibility with Vitest
      PINO_DISABLE_DIAGNOSTICS: '1',
    },
    // Use single-fork mode to prevent multiple worker processes
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Integration tests need longer timeouts for API calls
    testTimeout: isCI ? 60000 : 30000,
    hookTimeout: isCI ? 60000 : 30000,
    // No coverage for integration tests
    coverage: {
      enabled: false,
    },
  },
});
