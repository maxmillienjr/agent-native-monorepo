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
- Type tests: `*.test-d.ts`, co-located. `tsc --noEmit` checks them under
  `yarn turbo typecheck`, and Vitest never runs them, because its include is
  `src/**/*.test.ts`. An unused `@ts-expect-error` fails with TS2578, so each one carries a
  one-line reason naming the error it expects.

## Package Structure

- All packages export through a root `src/index.ts` barrel file. There is one deliberate
  exception: `@repo/determination/clinician`, the only constructor for an adverse
  determination. It is a second entry point in the package's `exports` map and is absent
  from the barrel, so the graph can import everything it may use without the one thing it
  may not. A lint rule in `apps/agent-service/eslint.config.js` forbids the subpath under
  `src/agent/**`, because an `exports` map cannot: the subpath is public on purpose, for
  the clinician review surface (P3-A).
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

## Telemetry

- **Spans are opened through the helpers in `@repo/telemetry`**: `withNodeSpan` for a graph
  node, `withToolSpan` around a tool, `withInferenceSpan` around a model or embedding call,
  and `withAgentSpan` for the run's root, which `RunsService` already opens. Each records
  `error.type` and ERROR status on a throw and never the error's message, which can quote
  a prompt. `@repo/telemetry/genai` is the same vocabulary without the SDK, for a package
  that only needs the names.
- **The GenAI semantic conventions are pinned to one commit, and moving it is a
  deliberate pull request.** They left `open-telemetry/semantic-conventions` after
  `v1.41.1` for `open-telemetry/semantic-conventions-genai`, which is in Development status
  and had no release tag when P2-C pinned commit `e57c543b4889619eb2a05702471937db5119165d`
  (2026-09-24). The npm package is not the pin: its `ATTR_GEN_AI_*` constants are
  deprecated and behind the source. `GENAI_SEMCONV` in `packages/telemetry/src/genai.ts`
  names the commit and the schema URL every helper's tracer carries, and `GEN_AI` spells
  every key once. A rename upstream is not a defect here until someone bumps. To bump:
  1. Read the diff of `docs/gen-ai/` and `model/` between the pinned commit and the new
     one.
  2. Edit `genai.ts` and nothing it does not have to: the commit, the schema URL if the
     manifest's changed, and every renamed or removed key in `GEN_AI` and
     `ALLOWED_SPAN_ATTRIBUTES`.
  3. Expect `genai.test.ts`, `spans.test.ts` and `cassette-deps.test.ts` to fail on a
     renamed key, and fix their assertions in the same pull request. That failure is what
     keeps a bump from being silent.
  4. Emit no old names beside the new ones. The only reader is P1-F, through the same
     constants, so it moves in the same commit.
  5. `eval-report.json` records `genAiSemconvCommit`; a comparison of two reports across
     a bump has to read it before it compares attributes.

  Re-pin to a tag in a pull request of its own once the repository publishes a `v*-dev`
  release.

- **Content capture is off, and there is no switch.** No span carries prompts, completions,
  system instructions, tool definitions, tool arguments or tool results, and
  `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` is not read. The enforcement is
  `ALLOWED_SPAN_ATTRIBUTES`, an allowlist that `spans.test.ts` holds a full graph run to and
  that `yarn eval` holds every span of every trial to, failing the run before it writes a
  report. Adding a key is an edit to that list, and the review question is whether the value
  is content. An extracted entity id is content: in the payer domain it can be a member's
  name. Opt-in capture needs the external-store pattern the conventions recommend, and the
  store is P3-C's ledger.
- **A replayed span is a recording, not a measurement.** On the replay axis the inference
  spans are opened from the cassette and marked `agent_native.replayed`. They carry the
  usage the recording measured, and only where the cassette has it. Their duration is
  replay speed. A reader summing usage or reading latency across tiers filters on the
  marker.

## Testing

Each tier has one command, and the first five run in CI. Eval runs twice in
`agent-eval.yml`: on the replay axis on every pull request, every push to `main` and
nightly, and on the live axis nightly and on dispatch when a `GOOGLE_API_KEY` repository
secret exists. `eval:retrieval` and `eval:explanation` run in no pipeline, by P2-D's
decision. Under ADR 0012's outcome, P2-E either adds a reproduction step for both to the
replay job, if the graph is kept, or archives both, if it is removed. `eval:retrieval`
measures the fused retrieval ADR 0009 retired, so it is a historical measurement: its
`vector` condition is what a request gets, and its `graph` and `hybrid` conditions are not.
`eval:explanation` is stage 1 of P2-D, the graph's explanation role, and reads the graph
alone.

| Tier        | Runner                 | Command                       | Scope                                                    |
| ----------- | ---------------------- | ----------------------------- | -------------------------------------------------------- |
| Unit        | Vitest                 | `yarn turbo test:unit`        | `packages/` and pure logic in apps — no I/O              |
| Service     | Jest + @nestjs/testing | `yarn turbo test:service`     | `apps/agent-service` over HTTP, stub graph deps          |
| Integration | Vitest                 | `yarn turbo test:integration` | Real Postgres/Neo4j — never mock a database              |
| E2E         | Playwright             | `yarn turbo test:e2e`         | Browser against the full `docker compose` stack          |
| Eval        | `@repo/eval-harness`   | `yarn eval`                   | Agent trials against real stores, model replayed or live |
| Retrieval   | `@repo/eval-harness`   | `yarn eval:retrieval`         | The P2-B ablation, pre-0009 design: recorded embeddings  |
| Explanation | `@repo/eval-harness`   | `yarn eval:explanation`       | P2-D stage 1: graph paths, no model and no embeddings    |

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
  also exits 1. The runner clears all five files before it starts, so read the directory,
  never the exit code.
- **In CI the exit code is the gate's verdict, not the pass rate.** With `EVAL_GATE` set
  (P1-D), `yarn eval` also writes `eval-gate.json` and appends the verdict to
  `eval-summary.md`. `EVAL_GATE=replay` compares every `(task, trial, grader)` cell with
  `packages/eval-harness/datasets/memory-recall/baselines/replay.json` and fails on any
  difference, an improvement included, or on an abort; a committed trial that is known to
  fail is fine as long as the baseline says so. `EVAL_GATE=live` pools nights of one
  cassette set and fails only on `regressed`. **A pull request that changes a grader
  result, a task, an assertion or the cassette set regenerates the baseline in the same
  change:** `EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval`, against the stores, with
  no key. The baseline diff is how a reviewer sees the behaviour that changed; never re-run
  the job instead.
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
- **There are two suites, and `EVAL_SUITE` picks one.** Unset, `yarn eval` runs
  memory-recall, the suite CI gates. `EVAL_SUITE=prior-auth` runs the 24 labelled
  prior-authorization requests (P3-D), whose tasks require a `live` or `replay` model, so
  the stub axis skips every one and says so. It is an environment variable and not a flag
  because Turbo reads `yarn eval --suite …` as its own option, and it is in `turbo.json`'s
  `env` for the strict-mode reason above. The prior-auth suite defaults to one trial a task
  and makes one `generateContent` call a task, except the four administrative requests,
  which are referred before the model is asked: 20 calls a trial set.
- **`EVAL_TRIALS` is per task.** `EVAL_TRIALS=1 yarn eval` on the live axis runs one trial
  of every task that is not skipped: three `generateContent` calls for `memory-recall-001`
  and five for `tool-use-001`. To measure or record one task on
  a tight quota, name it in `EVAL_TASKS` (below) rather than moving the other files out of
  `packages/eval-harness/datasets/memory-recall/`, which is how P2-C's live criteria and
  P1-F's re-recording were run before that variable existed.
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
  sends, the chat or embedding model id, the embedding width, the tool registry, a graph
  change that alters which decisions a run makes, or the canary reporting `changed` on a
  pinned id. The first four are mechanical — the request hash moves, every replay misses,
  and `CassetteMissError` prints the diff. The last is the one nothing else notices: the id
  is the same, so the cassettes replay cleanly with the old model's answers. The
  cost is real and it falls on prompt changes, which are common here; the alternative,
  keying on a normalized shape, serves the old answer to the new prompt and calls it a
  pass. Re-recording needs a live key and about eight `generateContent` calls against a
  20-request daily free tier, so it is a deliberate act rather than a step in a loop.
  ADR 0005 records the seam choice and what replay stops measuring. **After a re-record,
  regenerate the replay baseline** with `EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval`
  and commit both: the baseline is tied to the set by a digest, and a new set with the old
  baseline fails the gate as `stale-digest`. A contributor without a key cannot re-record;
  a maintainer with one pushes the new set and baseline to the pull request's branch. A
  cassette in an older format is refused before any store is reset, with the same two
  commands in the message: P1-F's format 2 changed what two seams return and not what they
  ask, so an old set would otherwise match and replay the wrong shape.
  **The free tier also allows 5 `generateContent` calls a minute**, and a record or live
  run of both tasks makes about eight in half a minute, so it reaches that limit. The chat
  client is meant to wait it out: `stopOnDailyQuota` retries any 429 that does not name a
  per-day quota, and the client backs off for up to about 90 seconds. That retry has to be
  explicit, because from `@langchain/core` 1.x LangChain's default handler stops on
  Gemini's quota wording. At 1.x the wait is proven by `rate-limit.test.ts` against a
  stubbed `fetch` and has not been observed live (P5-C, "What the implementation found").
- **Retrieval labels are written, not computed, and they are frozen before the first
  run.** `yarn eval:retrieval` scores the graph/vector/hybrid ablation against
  `packages/eval-harness/datasets/retrieval-ablation/queries.json`. Every label there is a
  human-authored judgement that a fact's text answers the question — never "cosine above a
  threshold" or "reachable from the seed", which would make one of the measured systems
  correct by definition. The dataset commit precedes the embedding commit, every report
  prints the dataset's sha256, and a label is never edited after a run. Missing labels are
  found by pooling and blind adjudication, which adds to `adjudication/` in its own commit
  and leaves the pre-registered set untouched. P2-D's gold concept paths are the one
  deliberate exception, and they are computed from the strata construction the loader
  already enforces, not from anything the measured explainer returns.
  `explanation-labels.json` was committed before the explainer existed, and a unit test holds
  it equal to `deriveGoldPaths`. Its answer keys are written by hand, like the labels above.
- **An embedding file is recorded against a model, a width and a dataset, and replays
  nothing else.** `recorded/embeddings.json` pins `EMBEDDING_MODEL`,
  `EMBEDDING_DIMENSIONS` and the dataset sha256 in its header, and replay refuses a
  mismatch or a missing vector rather than calling the embedder. Re-record it with
  `EVAL_EMBEDDINGS_MODE=record yarn eval:retrieval` when any of the three moves — a query
  or label edit moves the third. The recorder is resumable and stops on the first 429:
  the free tier allows about 100 `embedContent` requests a minute per model, so a full
  recording of the 535 texts takes six invocations a minute apart. Its default,
  `EVAL_EMBEDDINGS_MODE` unset, makes no request to the model host and fails if one is
  made.
- **`EVAL_TASKS` narrows `yarn eval` to named tasks.** Recording is per suite, so adding
  one task and recording its cassette otherwise re-records every other cassette and
  spends their `generateContent` calls. An unknown id is refused, and the selection is
  printed in the suite name.
- **The drift canary watches the model behind the pinned ids, and its baseline moves only
  by a commit.** `yarn canary` (P1-E) reads `models.get` for `gemini-2.5-flash`,
  `gemini-embedding-001` and `gemini-flash-latest`, makes one direct `generateContent` per
  chat id for `modelVersion`, and embeds the 21 baseline texts, comparing each vector bit for
  bit with `packages/eval-harness/datasets/canary/baseline.json`. It needs a key and no
  stores, refuses to run without `GOOGLE_API_KEY`, and exits 1 when a pinned id is
  `changed`, `gone` or `unobserved`; a moved floating alias is a notice. Accepting a change
  is `CANARY_BASELINE=update yarn canary` with a key and a committed baseline diff, never a
  re-run, and a pinned `changed` usually means a re-record as well. `CANARY_PROBES` runs a
  subset (`metadata,embedding` spends no `generateContent`), and the summary names what was
  left out. It is a root script over `yarn workspace`, not a Turbo task, so strict env mode
  does not strip its variables. `EVAL_CHAT_MODEL` runs `yarn eval` on another chat id for a
  hand-started comparison; replay and `EVAL_GATE` both refuse it.
- **A budget is a line in the task file, and raising one is an edit reviewed in the pull
  request that needs it.** Each task declares per-trial ceilings beside `requires` —
  `inputTokens`, `outputTokens` and `modelCalls` — and `yarn eval` checks them against the
  trial's spans beside the graders, never among them: a breach leaves `passed` and the pass
  rate alone, fails the run on its own, and is not something `EVAL_GATE=update` can accept.
  On replay a budget checks the committed cassettes, so it fails on one kind of pull
  request: the re-record of a prompt change that costs more. The re-record runs the same
  check on the live axis first, so the breach shows on the contributor's machine. Raise the
  number in the task file, in that pull request, and say why in its description; never
  widen headroom in a pull request that does not need it. The values follow P1-F's rule —
  the recording × 1.5 for input and × 2 for output, rounded up to the next hundred, and
  `2 + maxSteps` calls — until the nightly's samples calibrate them. Latency and dollars
  are reported and never budgets: the loader refuses a `latencyMs` key with the reason.
- **A retriever's `ORDER BY` needs a unique secondary key.** Both semantic readers produce
  ties by construction — `expandFromSeeds` scores on hop distance, and the eval harness
  seeds every fact in a task with one vector — and an untied order is decided by whatever
  order the store holds rows in, which changes across a delete-and-reseed. The vector
  reader's order reaches `plan`'s prompt through `retrievedContext`, so it is an input to
  the agent and not a presentation detail; the graph reader's reaches the ablation's
  `rrfMerge`. Both readers break the tie on the content hash.
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

### Live model quota

One budget, shared by everything that calls the model live. The free tier allows **20
`generateContent` requests per day and 5 per minute, per Google Cloud project and model**
(`gemini-2.5-flash`); `embedContent` is a separate quota with its own per-minute limit. The
day resets at midnight Pacific. The `GOOGLE_API_KEY` repository secret and the developer
key in `.env` are, as of 2026-10-08, in the **same project**, so CI and local work draw on
one pool.

Standing consumers, before any development spends a call:

| Consumer                                     | `generateContent` per day |
| -------------------------------------------- | ------------------------- |
| `agent-eval.yml` `eval-live`, one trial each | about 8                   |
| `agent-eval.yml` `eval-canary` (P1-E)        | 2–3                       |

That leaves roughly 9–10 a day for recordings and live criteria. A PRD that needs live
calls states its count and how it splits across days; whoever schedules the run checks this
table first and does not start a recording that the day's remainder cannot finish. A key
from a separate project doubles the pool and is the owner's decision.

## Documentation

- **Planned work goes in `docs/prd/`**, one file per PRD, indexed by `docs/prd/README.md`.
- **Decisions go in `docs/adr/`.** A record is not edited after it reaches `accepted` —
  supersede it with a new one instead.
- `yarn lint:docs` checks the structure: frontmatter completeness, that every id resolves,
  that `depends_on` and `blocks` are mutual, that the index agrees with the files, and that
  a `shipped` PRD's unmet criteria each name the PRD that now owns them. It also resolves
  every evidence anchor in `docs/STATUS.md` and `governance/controls.yaml`, checks the
  control catalogue against the PRDs that own its `planned` rows, fails when
  `governance/CONTROLS.md` is stale, runs `scripts/lint-data.mjs` (below), and runs the
  fixture tests under `scripts/`. It runs on every pull request.
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

## Payer Data

- **The code systems payer data may name are listed in ADR 0008**, and nothing else is
  permitted until a reviewer has read the licence and amended it. ICD-10-CM is used on
  CDC's public-domain conditions, whose notice is in ADR 0008 and `data/payer.json`; HCPCS
  Level II is permitted except its D range, which is the ADA's CDT.
- **The prior-authorization bundles are generated, and `scenarios.ts` is the copy to edit.**
  A FHIR attachment carries its note base64-encoded, so the readable text lives in
  `packages/prior-auth/src/dataset/scenarios.ts` and
  `yarn workspace @repo/prior-auth author-dataset` writes the bundles and task files from
  it. `dataset.test.ts` fails if the two differ, and the files are in `.prettierignore` for
  that reason. `bundles/labels.json` changes only when a label does, in a commit of its own,
  before any recording that depends on it.
- **`scripts/lint-data.mjs` checks payer data structurally and every other file anchored.**
  An exception goes in `scripts/lint-data.allow.json` with a reason, and an entry whose token
  has left its file fails, so the list cannot rot.
- **No NPI in payer data, in either form.** An NPI that passes its check digit could be a real
  provider's, and lint-data fails it; one that fails it breaks US Core 6.1.0's `us-core-17`,
  and the validator job fails it. US Core requires an identifier, not an NPI, so use an
  `https://example.org/` one.
- **`fhir-validate.yml` gates base R4 and US Core 6.1.0 and reports PAS 2.2.1.** It needs
  Java 17 and the 200 MB `validator_cli.jar`, which is why it is not in `ci.yml`. To run it
  locally, run the service spec with `FHIR_CAPTURE_DIR` set and then
  `node scripts/fhir-validate.mjs --jar <jar> --captured <dir>`; `FHIR_VALIDATOR_JAVA`
  replaces `java` with a container command. Each resource's `meta.profile` names US Core
  `|6.1.0`, because loading PAS brings US Core 7.0.0 and an unversioned canonical would
  resolve to whichever loaded last.

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
- **Clear an advisory by version, and touch only what the dependent's range cannot reach.**
  When `dependency-audit` fails, run `yarn why <pkg>` first, then compare the via clause
  with the range the dependent asks for in `yarn.lock`. If the fix is inside that range,
  `yarn up -R <pkg>` moves the lockfile, with no resolution. If a resolution already
  exists, it has failed in one of two ways. It is **inert** when its key names a range
  nothing asks for: the via clause shows the dependent's own range, and Yarn ignored the
  key without saying so. Re-key it to the range actually asked for. It is **stale** when the
  via clause shows the pinned value: the pin works, but it holds the tree on a version that
  is now vulnerable. Bump the value. Add a new resolution only when the dependent's range
  excludes every fixed version. The commit body says which case it was.
- **An advisory with no fixed release is ignored by numeric ID in `.yarnrc.yml`, never
  silenced.** `npmAuditIgnoreAdvisories` holds one ID per entry, with the GHSA, the
  reason the package cannot reach this repository's input, and what removes the entry.
  Never use a package name, a glob, or a lowered `--severity`. A release above the
  advisory range does not count as a fix until its diff shows one: http-cache-semantics
  4.3.0 is outside the range of GHSA-ch52-4w7c-c8xp and leaves the flawed path unchanged.
- **A root `scripts/` check may import a package only from the root `devDependencies`, and
  only one already in `yarn.lock`.** `scripts/lint-docs.mjs` once needed nothing installed.
  The controls check needs `yaml` to read workflows and the catalogue, and `zod` because a
  Zod schema is the source of truth here too. Both were already resolved for the workspaces
  at the same ranges, so declaring them at the root added no package to the tree. The cost
  is that `yarn lint:docs` now needs `yarn install` first, which CI already runs. A check
  that would need a package the lockfile does not have belongs in a workspace, not in
  `scripts/`.
