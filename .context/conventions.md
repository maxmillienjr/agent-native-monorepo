# Conventions

## TypeScript

- **Strict mode everywhere.** No `any`. Use `unknown` + Zod parse at system boundaries.
- Zod schemas are the **source of truth** for types. Infer types from schemas via
  `z.infer<typeof Schema>` — never duplicate type definitions manually.
- Target: ES2022. Module: NodeNext (packages/apps), ESNext (React console).

## File Naming

- `kebab-case.ts` for all source files (e.g., `retrieval-facade.ts`).
- `PascalCase.tsx` for React components (e.g., `RunForm.tsx`).
- Test files: `*.test.ts` co-located with source for unit tests; separate `test/`
  directory for integration tests.

## Package Structure

- All packages export through a root `src/index.ts` barrel file.
- Internal imports within a package use relative paths.
- Cross-package imports use the `@repo/<name>` workspace alias.

## Commits

- **Conventional Commits:** `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `ci:`.
- Imperative mood, lowercase first word after prefix.
- Body optional but encouraged for non-trivial changes.

## Logging

- **No `console.log`.** Use the structured logger from `@repo/telemetry`.
- All log lines include `correlationId` from AsyncLocalStorage context.
- Log levels: `debug`, `info`, `warn`, `error`.

## Testing

Each tier has one command. Unit, Service, Integration and E2E run in CI; `test:eval` is
nightly; `eval` is local-only until P1-C wires it into a pipeline.

| Tier        | Runner                 | Command                       | Scope                                            |
| ----------- | ---------------------- | ----------------------------- | ------------------------------------------------ |
| Unit        | Vitest                 | `yarn turbo test:unit`        | `packages/` and pure logic in apps — no I/O      |
| Service     | Jest + @nestjs/testing | `yarn turbo test:service`     | `apps/agent-service` over HTTP, stub graph deps  |
| Integration | Vitest                 | `yarn turbo test:integration` | Real Postgres/Neo4j — never mock a database      |
| E2E         | Playwright             | `yarn turbo test:e2e`         | Browser against the full `docker compose` stack  |
| Eval        | `@repo/eval-harness`   | `yarn eval`                   | Live agent trials, real model calls, real stores |

- **Service tests need `--experimental-vm-modules`**, which the `test:service` script
  already carries. Jest's ESM support requires it, and without it every import in a spec
  fails with "Cannot use import statement outside a module". For the same reason the Jest
  config is `jest.config.mjs` and not `.ts` — a TypeScript config makes Jest require
  `ts-node`, which is not a dependency.
- **Service tests must not depend on ambient environment.** `RunsService` picks live Gemini
  dependencies over stubs whenever `GOOGLE_API_KEY` is set, so a spec that does not clear
  it passes or fails according to the developer's shell.
- **The eval tier is not a test runner and does not pretend to be one.** `yarn eval` is
  `turbo eval`, which runs `node dist/eval/run-eval.js` in `apps/agent-service`: it boots
  the real application context, runs n trials per task against live stores, and writes
  JSON, JUnit XML and a Markdown summary. The package's own unit tests are Vitest like
  everything else; the trials are not, because they hold one Nest context across every
  trial and their output is three report files rather than a pass/fail line.
- **`packages/eval-harness` must not declare a `test:eval` script.** `agent-eval.yml` runs
  `yarn turbo test:eval` across every workspace, so declaring one there silently makes the
  nightly job run the trial suite on whatever axes that runner happens to have. P1-C owns
  that switch.
- **A Turbo task declares every variable its process reads.** Turbo runs in
  `envMode: strict` — the 2.x default — so a task receives only the variables its `env`
  array names, and an undeclared one arrives as `undefined` with nothing said. The damage
  is not uniform. Without `GOOGLE_API_KEY` every trial runs the canned model set, the suite
  reports on canned strings, and it looks identical to one that is working. `EVAL_TRIALS`
  and `EVAL_OUTPUT_DIR` fail quieter and still cost: both were documented as working knobs
  for as long as they were absent from the list, so `EVAL_TRIALS=1 yarn eval` ran five
  trials. Check the `env` array against what the script actually reads, not against the one
  variable that broke last time.
- **A task declares the axes it is meaningful on, and a skipped task is visible beside the
  rate.** A grader says what it needs in `requires` and the suite refuses when that is
  unmet; a task says the same thing in the `requires` block of its file and is **skipped**
  instead. The asymmetry is deliberate: refusing the whole suite because one task wants a
  key would make `yarn eval` unusable on a clone with no `.env`, which is the ergonomics
  the quickstart depends on. Either axis takes a single value or a set, so `tool-use-001`
  declaring `{ "model": ["live", "replay"] }` does not refuse the replay axis. The half that
  needs watching is arithmetic: a skipped task contributes no trials, so `passRate` rises
  because the denominator shrank. `tool-use-001` on the stub axis is the worked example —
  50% over two tasks becomes 100% over one. A rate that moved for that reason is only
  honest while the exclusion travels with it, so `SuiteReport.skipped` names every skipped
  task and what it needed, and all three reporters print it: the JSON carries it, the JUnit
  XML emits a `<skipped/>` case rather than a pass or an absence, and the Markdown summary
  prints it between the rate and the table. Never report a rate computed over fewer tasks
  without the list of what was left out.
- **Integration needs the stores exported, and says nothing when they are not.** Bring the
  infrastructure up with `docker compose up -d --wait` — no `--profile full`, the suite
  talks to Postgres and Neo4j directly — and export `DATABASE_URL`, `NEO4J_URI`,
  `NEO4J_USER` and `NEO4J_PASSWORD` to match `docker-compose.yml`. With any of the first two
  absent, `test/integration-env.ts` skips every suite so a laptop with no Docker is not a
  crash, and `yarn turbo test:integration` then reports 27 skipped tests and exits 0. That
  is a pass by shape and a no-op by content. `REQUIRE_INTEGRATION_ENV=1` turns the skip into
  a failure naming each missing variable; the nightly `test:eval` script sets it, and it is
  the flag to reach for whenever a green integration run needs to mean something.
- **A retriever's `ORDER BY` needs a unique secondary key.** Both semantic readers produce
  ties by construction — `expandFromSeeds` scores on hop distance, and the eval harness
  seeds every fact in a task with one vector — and an untied order is decided by whatever
  order the store holds rows in, which changes across a delete-and-reseed. That order
  reaches `plan`'s prompt through `rrfMerge` and `retrievedContext`, so it is an input to
  the agent and not a presentation detail. Both readers break the tie on the content hash.
- **E2E runs against the compose stack, not the dev server.** Bring it up with
  `docker compose --profile full up -d --build --wait`, then run the suite with
  `E2E_BASE_URL=http://localhost:8080`. Without that variable Playwright boots the Vite dev
  server instead, which serves the UI with no backend behind it — assertions pass without
  proving anything.

## Documentation

- **Planned work goes in `docs/prd/`**, one file per PRD, indexed by `docs/prd/README.md`.
- **Decisions go in `docs/adr/`.** A record is not edited after it reaches `accepted` —
  supersede it with a new one instead.
- `yarn lint:docs` checks the structure: frontmatter completeness, that every id resolves,
  that `depends_on` and `blocks` are mutual, that the index agrees with the files, and that
  a `shipped` PRD's unmet criteria each name the PRD that now owns them. It runs on every
  pull request.
- **A capability claim in `README.md`, `.context/`, or `.agents/` must be true of the code
  at HEAD.** `.agents/` counts: the testcontainers convention this repo never followed lived
  in three of those files, and one of them was the prompt that reviews pull requests.
  If it is aspirational, it belongs in `docs/prd/` or in the status matrix, not in the
  present tense.
- **`docs/STATUS.md` is that status matrix**, one row per documented capability with what
  is actually behind it and which PRD owns the rest. A change that moves a row — wiring an
  adapter, deleting a claim — updates the row in the same pull request.

## Error Handling

- Validate at system boundaries with Zod. Trust internal types.
- Use NestJS exception filters for HTTP error envelopes. A filter must preserve the payload
  a 4xx `HttpException` carries — `ZodValidationPipe` attaches `error: 'Validation Error'`
  and the Zod `issues`, and rebuilding the body from scratch throws away the only part a
  client can act on. 5xx payloads are never forwarded.
- **Inject Nest dependencies by explicit token: `@Inject(Foo) private readonly foo: Foo`.**
  `yarn dev` runs through tsx, and esbuild does not implement `emitDecoratorMetadata`, so
  Nest has no `design:paramtypes` to resolve an implicit constructor parameter and injects
  `undefined`. It only breaks on the dev path — `tsc` emits the metadata — so the compiled
  build and the service tests will not catch it.
- Graph nodes return `Partial<AgentState>`. **Throwing is not swallowing, and an I/O node
  must throw.** A `retryPolicy` only ever fires on a thrown error, so a node that catches
  its own store failure and returns a `Partial<AgentState>` makes `retryOn` unreachable and
  the policy a decoration. `retrieve`, `plan`, `act`, `distill` and `reflect` therefore
  propagate their I/O errors on purpose.
- Containment happens once, at the graph boundary. An exhausted retry becomes a failed run
  with the checkpoint intact — a JSON error body on `POST /runs`, and a terminal
  `StreamEvent.error` frame on `POST /runs/stream`, because that response is already
  committed and cannot be given an error body. What must never happen is an unhandled
  rejection or a stream that simply stops.

## Dependencies

- Minimize external dependencies. Prefer standard library where possible.
- The root `package.json` workspaces array holds globs — `packages/*` and `apps/*` — not
  package names. A new package in either directory is registered by existing there, and
  `yarn workspaces list` is the check. Adding a name is only needed outside those globs.
- Pin major versions. Use `^` for minor/patch ranges.
