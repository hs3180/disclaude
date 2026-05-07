import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration for Chat Lifecycle integration tests.
 *
 * These tests call real lark-cli to create/dissolve Feishu groups.
 * lark-cli must be installed and authenticated.
 * Tests auto-skip when lark-cli is unavailable.
 *
 * Run with: npm run test:chat
 *
 * Environment variables:
 *   TEST_CHAT_USER_IDS  Comma-separated user open_ids for member tests (ou_xxx format)
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
    // Longer timeouts — lark-cli API calls can be slow
    testTimeout: isCI ? 30000 : 15000,
    hookTimeout: isCI ? 30000 : 15000,
    // No global setupFiles — we need real network access for lark-cli.
    // The nock setup in tests/setup.ts only blocks Node.js-level HTTP,
    // not child processes, but we skip it to keep the config clean.
  },
});
