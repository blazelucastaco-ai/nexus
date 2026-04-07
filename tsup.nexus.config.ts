import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs'],
  target: 'node22',
  outDir: '/Users/lucastopinka/.nexus/app',
  clean: true,
  sourcemap: false,
  dts: false,
  splitting: false,
  treeshake: true,
  noExternal: [/.*/],
  external: ['better-sqlite3'],
  bundle: true,
  // Preserve original class/function names to avoid breaking instanceof/name checks
  // (e.g. abort-controller's AbortSignal class gets renamed to AbortSignal2 by esbuild
  // which breaks node-fetch's isAbortSignal() check).
  keepNames: true,
});
