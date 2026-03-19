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

/**
 * Coverage tracking scope.
 *
 * Only source files that have corresponding unit tests are included in coverage.
 * Integration-test-only modules (requiring WebSocket, HTTP servers, external APIs, etc.)
 * are excluded from the coverage threshold calculation.
 *
 * When adding new unit tests, add the corresponding source directory/file to this list.
 */
const coverageInclude = [
  // packages/core - config module has unit tests
  'packages/core/src/config/**/*.ts',
  // packages/primary-node - unit-tested modules
  'packages/primary-node/src/channel-manager.ts',
  'packages/primary-node/src/exec-node-registry.ts',
  'packages/primary-node/src/exec-node-manager.ts',
  'packages/primary-node/src/ipc/**/*.ts',
  'packages/primary-node/src/channels/rest-channel.ts',
  'packages/primary-node/src/platforms/feishu/**/*.ts',
  // packages/worker-node - unit-tested modules
  'packages/worker-node/src/agents/worker-pool/task-queue.ts',
  'packages/worker-node/src/agents/pilot/message-builder.ts',
];

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
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
      include: coverageInclude,
    },
    setupFiles: ['./tests/setup.ts'],
  },
});
