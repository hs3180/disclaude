import { defineConfig } from 'tsup';

// Dependencies to exclude from bundling
// These are either pure ESM or have complex dependencies that don't bundle well
const EXTERNAL_DEPS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@larksuiteoapi/node-sdk',
  '@playwright/mcp',
  'ws',
];

export default defineConfig([
  // CLI entry point (standalone executable)
  // Using ESM with external deps to avoid bundling issues
  {
    entry: ['src/cli-entry.ts'],
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    splitting: false,
    minify: false,
    bundle: true,
    platform: 'node',
    external: EXTERNAL_DEPS,
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
    external: EXTERNAL_DEPS,
    outDir: 'dist/mcp',
    outExtension: () => ({ js: '.js' }),
  },
]);
