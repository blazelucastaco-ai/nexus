import { defineConfig } from 'tsup';

// Polyfill so bundled CJS packages can call require() inside ESM output
const requirePolyfill = `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`;

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
    noExternal: [/^(?!better-sqlite3|grammy|ws).*/],
    banner: { js: requirePolyfill },
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
    banner: { js: `#!/usr/bin/env node\n${requirePolyfill}` },
  },
  {
    entry: { 'runners/dream': 'src/runners/dream.ts' },
    format: ['esm'],
    target: 'node22',
    outDir: 'dist',
    clean: false,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    noExternal: [/^(?!better-sqlite3|ws).*/],
    banner: { js: requirePolyfill },
  },
]);
