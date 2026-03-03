import { defineConfig } from 'tsup';

// Dependencies to exclude from bundling
// These are either pure ESM or have complex dependencies that don't bundle well
const EXTERNAL_DEPS = [
  '@anthropic-ai/claude-agent-sdk',
  '@anthropic-ai/sdk',
  '@larksuiteoapi/node-sdk',
  '@playwright/mcp',
  'ws',
  'pino',
  'pino-pretty',
  'pino-roll',
  'sonic-boom',
  'pino-file',
  // CJS modules that use dynamic require - must be external for ESM build
  // These are dependencies of @larksuiteoapi/node-sdk -> axios
  'axios',
  'form-data',
  'follow-redirects',
  'combined-stream',
  'proxy-from-env',
];

export default defineConfig([
  // CLI entry point (standalone executable)
  // Using ESM with external deps to avoid bundling issues
  // Code splitting enabled to avoid loading schedule module in comm mode (issue #114)
  {
    entry: ['src/cli-entry.ts'],
    format: ['esm'],
    target: 'node18',
    sourcemap: true,
    splitting: true, // Enable code splitting for dynamic imports
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
