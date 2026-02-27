/**
 * Vitest configuration for integration tests.
 *
 * Integration tests verify the system works correctly with real external services:
 * - Feishu API (sandbox environment)
 * - Claude SDK (test account)
 * - MCP tools (real protocol communication)
 *
 * These tests require environment variables to be set:
 * - FEISHU_APP_ID / FEISHU_APP_SECRET: Feishu sandbox credentials
 * - ANTHROPIC_API_KEY: Claude API key for SDK tests
 *
 * Run: npm run test:integration
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/', 'dist/', 'src/'],
    env: {
      NODE_ENV: 'integration-test',
      PINO_DISABLE_DIAGNOSTICS: '1',
    },
    // Integration tests need more time for API calls
    testTimeout: 60000,
    // Run sequentially to avoid rate limiting
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Retry failed tests once (flaky network)
    retry: 1,
    setupFiles: ['tests/integration/setup.ts'],
  },
});
