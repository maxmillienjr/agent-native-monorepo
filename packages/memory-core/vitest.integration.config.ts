import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // An empty run must never be reported as a pass. The nightly eval depends on
    // these files actually being collected.
    passWithNoTests: false,
    // Every file in this suite shares one Postgres, and each one
    // truncates the shared tables in `beforeAll`. Running the files in parallel
    // races on that shared state: on a fresh database two workers issue
    // `CREATE EXTENSION IF NOT EXISTS vector` concurrently and one loses with
    // `duplicate key value violates unique constraint "pg_extension_name_index"`,
    // because IF NOT EXISTS is not atomic. Serialize the files.
    fileParallelism: false,
  },
});
