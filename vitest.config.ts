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
        // Issue #398: Exclude files not suitable for unit testing
        'src/runners/**',           // Runners require integration testing
        'src/platforms/base/**',    // Platform base abstractions
        'src/sdk/interface.ts',     // SDK interface definitions
        'src/sdk/types.ts',         // SDK type definitions
        'src/channels/types.ts',    // Channel type definitions
        'src/channels/adapters/**', // Adapter type definitions
        'src/nodes/types.ts',       // Node type definitions
        'src/cli-entry.ts',         // CLI entry point
        'src/auth/types.ts',        // Auth type definitions
        'src/config/types.ts',      // Config type definitions
        'src/conversation/types.ts', // Conversation type definitions
        'src/mcp/mcp-server.ts',    // MCP server - requires integration testing
        'src/auth/auth-mcp.ts',     // Auth MCP - requires OAuth integration testing
        'src/sdk/providers/claude/message-adapter.ts', // Requires API integration testing
        'src/feishu/message-logger.ts', // Requires message system integration testing
        // Index files (re-exports only)
        'src/channels/index.ts',
        'src/platforms/index.ts',
        'src/platforms/feishu/index.ts',
        'src/platforms/rest/index.ts',
        'src/feishu/index.ts',
        'src/file-transfer/index.ts',
        'src/file-transfer/outbound/index.ts',
        'src/auth/index.ts',
        'src/config/index.ts',
        'src/conversation/index.ts',
        'src/nodes/index.ts',
        'src/schedule/index.ts',
        'src/core/index.ts',
        'src/sdk/index.ts',
        'src/sdk/providers/index.ts',
        'src/sdk/providers/claude/index.ts',
        'src/messaging/index.ts',
        'src/agents/index.ts',
        'src/platforms/feishu/card-builders/index.ts',
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
