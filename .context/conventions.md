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

## Migrations

- **An applied migration's statements never change; a schema change is a new migration.**
  `runMigrations` is Drizzle's migrator, which picks what to apply from
  `meta/_journal.json`'s `when` and records a sha256 of each file without ever comparing
  it. An edited statement is neither re-applied nor rejected — it diverges silently between
  databases migrated before the edit and after it. A comment may be corrected in place, and
  `0001_semantic_facts.sql` says where it was (ADR 0006).

## Commits

- **Conventional Commits:** `feat:`, `fix:`, `chore:`, `test:`, `docs:`, `ci:`.
- Imperative mood, lowercase first word after prefix.
- Body optional but encouraged for non-trivial changes.

## Logging

- **No `console.log`.** Use the structured logger from `@repo/telemetry`.
- All log lines include `correlationId` from AsyncLocalStorage context.
- Log levels: `debug`, `info`, `warn`, `error`.

## Testing

Each tier has one command, and all five run in CI. Eval runs twice in `agent-eval.yml`: on
the replay axis on every pull request, every push to `main` and nightly, and on the live
axis nightly and on dispatch when a `GOOGLE_API_KEY` repository secret exists.

| Tier        | Runner                 | Command                       | Scope                                                    |
| ----------- | ---------------------- | ----------------------------- | -------------------------------------------------------- |
| Unit        | Vitest                 | `yarn turbo test:unit`        | `packages/` and pure logic in apps — no I/O              |
| Service     | Jest + @nestjs/testing | `yarn turbo test:service`     | `apps/agent-service` over HTTP, stub graph deps          |
| Integration | Vitest                 | `yarn turbo test:integration` | Real Postgres/Neo4j — never mock a database              |
| E2E         | Playwright             | `yarn turbo test:e2e`         | Browser against the full `docker compose` stack          |
| Eval        | `@repo/eval-harness`   | `yarn eval`                   | Agent trials against real stores, model replayed or live |

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
- **A CI eval job declares the axes it exists to measure.** `detectAxes` falls back to the
  stub set when the key is empty, which keeps `yarn eval` usable on a clone with no `.env`
  and is exactly wrong in CI: a live job that lost its secret, or a replay job whose
  `EVAL_CASSETTE_MODE` was stripped, skips `tool-use-001` and goes green at 100% over one
  task. Each job in `agent-eval.yml` sets `EVAL_EXPECT_AXES` (`model=replay memory=live`,
  `model=live memory=live`), and the runner refuses before the Nest context is built when
  the detected axes differ. It is the same move as `REQUIRE_INTEGRATION_ENV`.
- **A report file exists only if the suite completed.** A graded failure writes
  `eval-report.json`, `eval-report.xml` and `eval-summary.md` and exits 1. Anything that
  stops the run — a stale cassette, an axis refusal, a request that reached the model
  during replay, an exhausted quota, an unreachable store — writes `eval-abort.json` and an
  `eval-summary.md` headed `aborted`, names the error and the trials that finished, and
  also exits 1. The runner clears all four files before it starts, so read the directory,
  never the exit code.
- **A Turbo task declares every variable its process reads.** Turbo runs in
  `envMode: strict` — the 2.x default — so a task receives only the variables its `env`
  array names, and an undeclared one arrives as `undefined` with nothing said. The damage
  is not uniform. Without `GOOGLE_API_KEY` every trial runs the canned model set, the suite
  reports on canned strings, and it looks identical to one that is working. `EVAL_TRIALS`,
  `EVAL_OUTPUT_DIR`, `EVAL_CASSETTE_MODE` and `EVAL_EXPECT_AXES` fail quieter and still
  cost: the first two were documented as working knobs for as long as they were absent
  from the list, so `EVAL_TRIALS=1 yarn eval` ran five trials. A stripped `EVAL_CASSETTE_MODE` is the
  expensive one — a run that was asked to replay for nothing goes live instead. Check the
  `env` array against what the script actually reads, not against the one variable that
  broke last time. A variable a workflow sets in a job's `env` is no exception:
  `REQUIRE_INTEGRATION_ENV` reached nothing under `yarn turbo test:integration` until
  `turbo.json` declared it, because the alias that used to carry it set it inside the
  script's own command, where Turbo never looks.
- **Turbo reduces a failing task's exit code to 1.** A script that exits 2 under
  `yarn turbo run <task>`, or under a root script that calls Turbo, returns 1 to the
  caller. This was checked with a probe on 2026-09-26. A distinction that CI needs, such as
  aborted versus failed, therefore has to be carried in a file the task writes, not in its
  exit code. For `yarn eval` that file is `eval-abort.json`.
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
  a failure naming each missing variable; the integration job in `e2e.yml` sets it on every
  pull request, and it is the flag to reach for whenever a green integration run needs to
  mean something.
- **A cassette is recorded against a commit, a prompt and a model, and replays nothing
  else.** `EVAL_CASSETTE_MODE=record` writes one cassette per trial to
  `packages/eval-harness/datasets/memory-recall/cassettes/<taskId>.trial-<n>.json`, holding
  the decisions the run made at the five `ModelDeps` seams and the tool call — not HTTP
  traffic. `EVAL_CASSETTE_MODE=replay` serves them back with no model client in the process
  at all, on a memory axis that stays live: the stores are still reset, re-seeded and read
  by the outcome graders, because a replayed store read would leave those graders nothing
  real to assert against. Recording is refused off the live model axis by the header
  schema's two literals — a recording of the canned stub set is schema-valid, replays
  cleanly and measures nothing.
  **Re-record when any of these moves:** a prompt string (`plan.node.ts`,
  `extraction.ts`, the `selectTool` instruction in `runs.service.ts`), the request a seam
  sends, the chat or embedding model id, the embedding width, the tool registry, or a
  graph change that alters which decisions a run makes. The first four are mechanical —
  the request hash moves, every replay misses, and `CassetteMissError` prints the diff. The
  cost is real and it falls on prompt changes, which are common here; the alternative,
  keying on a normalized shape, serves the old answer to the new prompt and calls it a
  pass. Re-recording needs a live key and about eight `generateContent` calls against a
  20-request daily free tier, so it is a deliberate act rather than a step in a loop. ADR
  0005 records the seam choice and what replay stops measuring.
- **A retriever's `ORDER BY` needs a unique secondary key.** Both semantic readers produce
  ties by construction — `expandFromSeeds` scores on hop distance, and the eval harness
  seeds every fact in a task with one vector — and an untied order is decided by whatever
  order the store holds rows in, which changes across a delete-and-reseed. That order
  reaches `plan`'s prompt through `rrfMerge` and `retrievedContext`, so it is an input to
  the agent and not a presentation detail. Both readers break the tie on the content hash.
- **A script or test that runs git in another directory strips git's environment first.**
  Git exports `GIT_DIR` and `GIT_INDEX_FILE` to hooks and to `git rebase --exec`, and an
  inherited `GIT_DIR` overrides discovery from `cwd`. A fixture test that ran `git init` and
  `git add` in a temporary directory under `rebase --exec` set `core.bare = true` in this
  repository's shared config and staged the fixture into the worktree's index.
  `gitEnv()` in `scripts/lib/anchors.mjs` drops every `GIT_` variable; pass it as `env`.
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
  a `shipped` PRD's unmet criteria each name the PRD that now owns them. It also resolves
  every evidence anchor in `docs/STATUS.md` and `governance/controls.yaml`, checks the
  control catalogue against the PRDs that own its `planned` rows, fails when
  `governance/CONTROLS.md` is stale, and runs the fixture tests under `scripts/`. It runs on
  every pull request.
- **Evidence is cited by name, not by line.** In `docs/STATUS.md` a citation is
  `path#name`: a declaration (`Class.member` for a method), a test title, a workflow job, a
  heading or a JSON key. In `governance/controls.yaml` it is a `symbol`, `test`, `ci` or
  `doc` anchor. A `path:NN` citation fails the lint in either file, because a line check
  stays green after the line stops holding what the sentence names. PRDs are dated records
  and keep `file:line`: they describe the tree they were written against.
- **A capability claim in `README.md`, `.context/`, or `.agents/` must be true of the code
  at HEAD.** `.agents/` counts: the testcontainers convention this repo never followed lived
  in three of those files, and one of them was the prompt that reviews pull requests.
  If it is aspirational, it belongs in `docs/prd/` or in the status matrix, not in the
  present tense.
- **`docs/STATUS.md` is that status matrix**, one row per documented capability with what
  is actually behind it and which PRD owns the rest. A change that moves a row — wiring an
  adapter, deleting a claim — updates the row in the same pull request.
- **`governance/controls.yaml` is the control catalogue**: which safeguards the repository
  has, which framework clauses each one answers, and what backs it. `implemented` needs a
  test or a CI job, `procedural` a written rule, `planned` an unshipped owning PRD, and
  `not-applicable` a rationale. A change that moves a control updates its row in the same
  pull request and regenerates `governance/CONTROLS.md` with `yarn controls:matrix`.

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
- **A root `scripts/` check may import a package only from the root `devDependencies`, and
  only one already in `yarn.lock`.** `scripts/lint-docs.mjs` once needed nothing installed.
  The controls check needs `yaml` to read workflows and the catalogue, and `zod` because a
  Zod schema is the source of truth here too. Both were already resolved for the workspaces
  at the same ranges, so declaring them at the root added no package to the tree. The cost
  is that `yarn lint:docs` now needs `yarn install` first, which CI already runs. A check
  that would need a package the lockfile does not have belongs in a workspace, not in
  `scripts/`.
