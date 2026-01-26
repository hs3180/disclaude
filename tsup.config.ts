import { defineConfig } from 'tsup';

export default defineConfig([
  // Main entry point (for backward compatibility)
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node18',
    clean: true,
    sourcemap: true,
    splitting: false,
    minify: false,
  },
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
]);
