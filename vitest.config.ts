import { defineConfig } from 'vitest/config';

// Tests share a real SQLite database at ~/.nexus/memory.db. Running test files
// concurrently causes non-deterministic races when one file's `DELETE FROM
// <table>` cleanup nukes another file's in-flight rows (most notably the
// projects-repository timing tests which need rows to survive a 1.1s wait).
//
// Disabling file-level concurrency is the surgical fix: tests within a file
// still run in their natural order, and total wall time increases only slightly
// because individual tests are fast.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
