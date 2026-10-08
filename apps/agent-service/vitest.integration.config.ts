import { defineConfig } from 'vitest/config';

/**
 * The suites that need a real Postgres and Neo4j: the service as `MemoryModule`
 * wires it. Kept out of `test:unit`, whose include is `src`, and run under
 * `yarn turbo test:integration` beside `memory-core`'s, after it, because both
 * migrate and truncate one shared database.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    passWithNoTests: false,
    fileParallelism: false,
  },
});
