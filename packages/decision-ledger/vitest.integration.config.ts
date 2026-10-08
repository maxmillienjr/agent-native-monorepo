import { defineConfig } from 'vitest/config';

/**
 * The ledger against a live Postgres. Each file creates and drops its own
 * database, so nothing here truncates a table another suite reads. The files
 * are still serialized, because they share one server's roles.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // An empty run is not a pass.
    passWithNoTests: false,
    fileParallelism: false,
  },
});
