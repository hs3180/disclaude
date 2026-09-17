import { defineConfig } from 'vitest/config';
import unitConfig from './vitest.config.js';

// Keep resource isolation, but discover only explicitly selected product use cases.
export default defineConfig({
  test: {
    ...unitConfig.test,
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/workspace/**'],
    coverage: { provider: 'v8', enabled: false },
  },
});
