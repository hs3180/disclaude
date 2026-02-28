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
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
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
        // CLI entry point - requires integration testing
        'src/cli-entry.ts',
        // Runners - require integration testing
        'src/runners/**',
        // Platform base classes - abstract definitions
        'src/platforms/base/**',
        // SDK interfaces and types - type definitions only
        'src/sdk/interface.ts',
        'src/sdk/types.ts',
        // Channel types - type definitions only
        'src/channels/types.ts',
        'src/channels/adapters/**',
        // Node types - type definitions only
        'src/nodes/types.ts',
        // Auth MCP - requires integration testing
        'src/auth/auth-mcp.ts',
        // MCP server - requires integration testing
        'src/mcp/mcp-server.ts',
        // Index files that only re-export
        'src/auth/index.ts',
        'src/channels/index.ts',
        'src/config/types.ts',
        'src/conversation/types.ts',
        'src/core/index.ts',
        'src/nodes/index.ts',
        'src/platforms/index.ts',
        'src/platforms/feishu/index.ts',
        'src/platforms/feishu/card-builders/index.ts',
        'src/platforms/rest/index.ts',
        'src/schedule/index.ts',
        'src/file-transfer/index.ts',
        // Message queue - requires integration testing
        'src/conversation/message-queue.ts',
        // Logger - complex to test, requires integration testing
        'src/utils/logger.ts',
        // Feishu message logger - requires integration testing
        'src/feishu/message-logger.ts',
        // Claude message adapter - requires integration testing
        'src/sdk/providers/claude/message-adapter.ts',
        // Card content builder - requires integration testing
        'src/platforms/feishu/card-builders/content-builder.ts',
        // Channels platforms index
        'src/channels/platforms/index.ts',
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
      include: ['src/**/*.ts'],
    },
    setupFiles: [],
    testTimeout: 10000,
  },
});
