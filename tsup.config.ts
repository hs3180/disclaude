import { defineConfig } from 'tsup';

export default defineConfig([
  // CLI entry point (standalone executable)
  {
    entry: ['src/cli-entry.ts'],
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    splitting: false,
    minify: false,
    bundle: true,
    platform: 'node',
    banner: {
      js: '#!/usr/bin/env node',
    },
    outDir: 'dist',
    outExtension: () => ({ js: '.js' }),
  },
  // Feishu MCP server (stdio)
  {
    entry: ['src/mcp/feishu-mcp-server.ts'],
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    splitting: false,
    minify: false,
    bundle: true,
    platform: 'node',
    outDir: 'dist/mcp',
    outExtension: () => ({ js: '.js' }),
  },
]);
