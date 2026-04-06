import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    target: 'node22',
    outDir: 'dist',
    clean: true,
    sourcemap: true,
    dts: true,
    splitting: false,
    treeshake: true,
    noExternal: [/^(?!better-sqlite3|grammy).*/],
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: false,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
