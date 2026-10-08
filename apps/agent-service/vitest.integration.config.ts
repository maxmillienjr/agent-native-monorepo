import { defineConfig } from 'vitest/config';

/**
 * The service against real Postgres and Neo4j: the run record and
 * `audit:replay` (P3-B). The unit config names `src/**`; these live in `test/`
 * beside the Jest service specs, whose `*.e2e-spec.ts` names neither runner
 * collects twice.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // An empty run is not a pass.
    passWithNoTests: false,
    // One Postgres and one Neo4j, shared with memory-core's suite, which
    // truncates tables in `beforeAll`. Serialized for the same reason it is.
    fileParallelism: false,
  },
});
