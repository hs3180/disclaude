import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  sourcemap: true,
  minify: false,
  bundle: true,
  platform: 'node',
  external: ['uuid'],
  dts: {
    resolve: true,
  },
  tsconfig: './tsconfig.json',
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
});
