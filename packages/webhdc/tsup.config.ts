import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'browser',
  target: 'es2022',
  bundle: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  dts: true,
  outDir: 'dist',
});
