import { defineConfig } from 'vitest/config';

// Tests share a real SQLite database at ~/.nexus/memory.db. Running test files
// concurrently causes non-deterministic races when one file's `DELETE FROM
// <table>` cleanup nukes another file's in-flight rows (most notably the
// projects-repository timing tests which need rows to survive a 1.1s wait).
//
// Disabling file-level concurrency is the surgical fix: tests within a file
// still run in their natural order, and total wall time increases only slightly
// because individual tests are fast.
//
// Scope tests to `tests/**` only. Without this, vitest auto-discovers files
// under `hub/tests/**` and `installer-app/...` and tries to compile them with
// the root's dep tree — which fails at `import fastify from 'fastify'` because
// root has no fastify. Each subpackage has its own vitest run.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['tests/**/*.{test,spec}.ts'],
    exclude: [
      'node_modules',
      'dist',
      'hub/**',
      'installer-app/**',
      'chrome-extension/**',
      '**/*.d.ts',
    ],
  },
});
