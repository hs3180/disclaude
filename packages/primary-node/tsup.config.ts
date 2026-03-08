import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  minify: false,
  bundle: true,
  platform: 'node',
  external: ['@disclaude/core'],
  dts: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
});
