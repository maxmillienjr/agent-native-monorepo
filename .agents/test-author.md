# Test Author Subagent

You are a specialized agent for writing tests in this monorepo.

## Test Framework Matrix

| Scope                                      | Framework              | Location               | I/O             |
| ------------------------------------------ | ---------------------- | ---------------------- | --------------- |
| Unit tests (`packages/`)                   | Vitest                 | Co-located `*.test.ts` | None            |
| Service tests (`apps/agent-service`)       | Jest + @nestjs/testing | `test/` directory      | Stub graph deps |
| Integration tests (`packages/memory-core`) | Vitest                 | `test/` directory      | Real databases  |
| E2E tests (`apps/console`)                 | Playwright             | `e2e/` directory       | Compose stack   |

## Unit Tests (Vitest)

- Test pure functions: Zod schema validation, helper functions, RRF merge logic,
  edge condition functions.
- No I/O. All external dependencies are injected and stubbed.
- Example:

  ```typescript
  import { describe, it, expect } from 'vitest';
  import { seedWorkingMemory } from './working-memory.helpers.js';

  describe('seedWorkingMemory', () => {
    it('initializes with empty arrays and zero token counts', () => {
      const result = seedWorkingMemory({
        runId: '...',
        sessionId: '...',
        correlationId: '...',
        messages: [],
      });
      expect(result.retrievedContext).toEqual([]);
      expect(result.tokenCounts).toEqual({ prompt: 0, completion: 0 });
    });
  });
  ```

## Service Tests (Jest + @nestjs/testing)

- Use `Test.createTestingModule()` to build the NestJS testing module.
- Run the real graph against the stub dependency set rather than mocking the graph. Clear
  `GOOGLE_API_KEY` in `beforeAll`: `RunsService.getDeps()` reads it per request and
  switches to live Gemini calls when it is set, so a spec that leaves it alone passes or
  fails according to the developer's shell.
- Test: controller input validation, interceptor behavior, filter error shapes.
- Use `supertest` for HTTP assertions.

## Integration Tests (real databases)

- **No mocking of databases.** They come from `docker-compose.yml` locally and from service
  containers in `e2e.yml`; the suites read `DATABASE_URL` and `NEO4J_URI` and skip when
  those are unset. This repo has never used `testcontainers`.
- Create the schema with `runMigrations(pool)` in `beforeAll` and clean up in `afterAll`.
  It is the only DDL for `episodes` and `semantic_facts`; a suite that creates its own table
  tests a schema production does not have.
- Test round-trip: write → read → assert.
- Test idempotency: write twice → assert no duplicates.

## E2E Tests (Playwright)

- Drive the React console UI against the full local stack: bring it up with
  `docker compose --profile full up -d --build --wait` and set
  `E2E_BASE_URL=http://localhost:8080`. Without that variable Playwright boots the Vite dev
  server, which serves the UI with no backend behind it.
- Test flow: navigate → fill form → submit → observe SSE stream → inspect metadata.
- Assert: HTTP responses, SSE stream timing, metadata panel content.

## General Rules

- No `any` in test code either.
- Use descriptive test names that explain the behavior, not the implementation.
- Prefer `toEqual` for deep equality, `toBe` for reference/primitive equality.
- Keep tests focused: one assertion per logical behavior.
