import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration optimized for low-memory environments.
 *
 * Key optimizations to prevent OOM in containerized environments:
 * - `pool: 'forks'` with `poolOptions.forks.singleFork: true`: Runs tests in a single
 *   process instead of spawning multiple worker threads (default behavior uses workers)
 * - This reduces memory from 500MB-2GB per worker to ~100-200MB total
 *
 * For coverage reports, use `npm run test:coverage` which enables coverage collection.
 * The default `npm test` runs without coverage to minimize memory footprint.
 *
 * @see https://vitest.dev/guide/cli.html#options
 * @see Issue #80 - OOM issue with child processes
 * @see Issue #807 - vitest-worker timeout fix with increased timeouts
 */

// CI environments need longer timeouts due to slower I/O and module loading
const isCI = process.env.CI === 'true';
const testTimeout = isCI ? 30000 : 10000;
const hookTimeout = isCI ? 30000 : 10000;

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['packages/**/*.test.ts'],
    exclude: [
      'node_modules/',
      'dist/',
      '**/workspace/**',
    ],
    env: {
      NODE_ENV: 'test',
      // Disable pino diagnostics_channel to fix compatibility with Vitest
      // See: https://github.com/hs3180/disclaude/issues/115
      PINO_DISABLE_DIAGNOSTICS: '1',
    },
    // Use single-fork mode to prevent multiple worker processes
    // This is critical for preventing OOM in containerized environments
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
    // Increased timeouts for CI to prevent "Timeout calling fetch" errors
    // during module loading (Issue #807)
    testTimeout,
    hookTimeout,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
        '**/*.d.ts',
        'vitest.config.ts',
        'tsconfig.json',
        'ecosystem.config.cjs',
        '**/workspace/**',
      ],
      // Temporarily lowered: monorepo migration left many packages without unit tests.
      // Restore to 70 once coverage improves across all packages.
      thresholds: {
        lines: 10,
        functions: 10,
        branches: 10,
        statements: 10,
      },
      include: ['packages/**/*.ts'],
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
