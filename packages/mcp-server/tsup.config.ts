import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  splitting: false,
  minify: false,
  bundle: true,
  platform: 'node',
  external: ['@disclaude/core'],
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  dts: true,
});
