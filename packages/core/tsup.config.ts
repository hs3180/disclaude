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
  external: [],
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  dts: true,
});
