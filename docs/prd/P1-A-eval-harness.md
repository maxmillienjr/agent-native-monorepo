---
id: P1-A
title: packages/eval-harness — evaluation as a first-class package
tier: 1
status: shipped
size: L
depends_on: [P0-A, P2-A]
blocks: [P1-B, P1-C, P1-D, P1-E, P1-F, P1-G, P2-B]
issue: null
superseded_by: null
---

# P1-A · `packages/eval-harness` — evaluation as a first-class package

## Problem

There is no evaluation of the agent anywhere in this repository.

`.github/workflows/agent-eval.yml` provisions Postgres and Neo4j, seeds fixtures, and runs
`yarn turbo test:eval`. Exactly one workspace declares that script —
`packages/memory-core/package.json:15` — and its value is
`REQUIRE_INTEGRATION_ENV=1 vitest run --config vitest.integration.config.ts`, which is
`test:integration` on the line above it with a flag prepended. The agent is never invoked.
The workflow is green and measures nothing about agent behavior.

A dataset shape already exists and is half-abandoned.
`apps/agent-service/test/fixtures/run-fixture-001.json` defines `input`, `expectedSeeds`,
`expectedOutcome: "success"`, and an `assertions` block
(`retrievedContextMinLength`, `outcomeMustBe`, `tokenCountsPositive`).
`scripts/seed-eval-fixtures.mjs:43` reads `expectedSeeds` and nothing else. The expected
outcome and the assertions are inert.

## Why it matters

This package is the repository's stated thesis, and the thing it currently lacks most
visibly. Every other tier here can be read and judged from the source; whether the agent
behaves is the one claim that only a measurement can settle, and this repository currently
has no measurement of it. The practitioner guidance in the references argues the same
point from the other side: teams that ship agents without an eval loop are debugging by
anecdote.

It is also the dependency root for the rest of Tier 1: the cassette layer (P1-B), the CI
pipeline (P1-C), the statistical gate (P1-D), the drift canary (P1-E), and the budget
assertions (P1-F) are all consumers of the types defined here, as is the retrieval
ablation in P2-B.

## Scope

- A new workspace, `packages/eval-harness`, exporting the core evaluation types and runner.
- Grader implementations: deterministic/code, model-graded, and human-label import.
- Outcome assertions that read persisted state, not response text — through a read surface
  added to `packages/memory-core`, not raw SQL and Cypher in the harness.
- Trajectory scoring over the graph's node sequence and tool calls.
- Reporters: JSON, JUnit XML, and a GitHub job-summary Markdown table.
- Migration of `run-fixture-001.json` into the dataset format, with its dormant
  `assertions` block becoming executable, and `scripts/seed-eval-fixtures.mjs` following it
  to wherever it lands.
- An `Eval` row in the testing table in `.context/conventions.md`, added in the same change
  that makes it true. The table names four tiers today and the prose above it names a fifth.

### Non-goals

- Zero-cost replay. Every trial in this PRD makes real model calls. Making the pull-request
  path free is P1-B.
- Wiring into CI. This PRD delivers a package and a local `yarn eval` command; the tiered
  pipeline is P1-C. Concretely, `packages/eval-harness` must **not** declare a `test:eval`
  script: `agent-eval.yml:47` runs `yarn turbo test:eval` across every workspace, so
  declaring one here silently makes the nightly job run this suite, on the environment
  described under "Which axis a trial runs on" rather than a chosen one. P1-C owns that
  switch, and owns retiring memory-core's `test:eval` alias at the same time.
- Statistical gating and baseline comparison. That is P1-D.
- Retrieval-quality metrics (`Recall@k`, `nDCG`, `MRR`). Those are P2-B, built on the
  `Grader` interface defined here.

## Design

### Vocabulary

The type names follow the vocabulary used in published agent-evaluation practice, so the
package reads as familiar rather than bespoke:

| Type           | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `Task`         | One evaluable scenario: input, seed state, and graders.                  |
| `Trial`        | One execution of a task. Agents are stochastic, so tasks run _n_ trials. |
| `AgentHarness` | Adapter that runs the system under test and returns a transcript.        |
| `EvalHarness`  | Loads tasks, resets the environment, runs trials, aggregates.            |
| `Transcript`   | The full record of a trial: messages, node sequence, tool calls, spans.  |
| `Outcome`      | The environment state _after_ the trial.                                 |
| `Grader`       | `(transcript, outcome) => Score`.                                        |
| `Suite`        | A named collection of tasks with shared configuration.                   |

### The load-bearing decision: grade the outcome

A grader receives both the transcript and the outcome, and the default graders assert
against the outcome. For this system that means reading Postgres, Neo4j, and pgvector
after the run — did `reflect` actually write the episode, MERGE the entity, upsert the
fact — rather than pattern-matching the assistant's final message. An agent can produce
a plausible answer while writing nothing, and only outcome assertions catch that.

```ts
export interface Grader<TOutcome = unknown> {
  readonly name: string;
  readonly kind: 'code' | 'model' | 'human';
  grade(transcript: Transcript, outcome: TOutcome): Promise<Score>;
}

export interface Score {
  readonly value: number; // normalized 0..1
  readonly label: 'pass' | 'fail';
  readonly explanation?: string; // required for kind === 'model'
}
```

Those reads go through `packages/memory-core`, which needs a small read surface it does not
have today: `EpisodicRepository.findBySession` exists, but nothing answers "how many facts
carry this `episodeId`" or "does a `:Concept` with this id exist." The harness must not
open its own pool and write its own SQL. Reviewer checklist rule 4 forbids database calls
outside `memory-core`, and the reason is not stylistic: `scripts/seed-eval-fixtures.mjs`
carries a comment recording that hand-rolled seeding is exactly how the eval fixtures ended
up in a table shaped differently from production's. A grader with its own `SELECT` drifts
the same way, and a grader that drifts reports a false negative on the one signal this
package exists to produce.

### How `Score` maps onto OpenTelemetry

`Score` is deliberately shaped to match the `gen_ai.evaluation.result` event
(`gen_ai.evaluation.score.value`, `.score.label`, `.explanation`) so P2-C can emit these
as span events without a translation layer. `pass` and `fail` are among the example values
the convention gives for `.score.label`, so the binary default below is the convention's
own idiom rather than a narrowing of it.

One attribute does not come from `Score`: `gen_ai.evaluation.name` is required and is the
name of the metric, which here is `Grader.name`. The unit P2-C emits is therefore the
`(Grader, Score)` pair, not the `Score` alone.

### Binary by default

Graders return `pass` / `fail`, not a 1–5 scale. Ordinal rubrics produce inconsistent
labels across annotators and across judge runs. Where finer resolution is genuinely needed,
decompose into several binary sub-graders and report the fraction satisfied.

### Reliability reporting

The runner executes _n_ trials per task (default 5) and reports both:

- **`pass@k`** — at least one of k trials passed. Capability.
- **`pass^k`** — all k trials passed. Reliability.

`pass^k` decays as `p^k`, which is the point: it exposes the gap between "can do this" and
"does this dependably," and it is the number that matters for anything that touches
memory writes.

### Which axis a trial runs on

A trial can be run against a stub on either of two independent axes, and on both of them
the stub passes assertions the real thing fails. `.agents/prd-author.md` has the rule that
came out of P2-A: a criterion verified on a stub is verified against the half of the system
that cannot fail. For this package that rule is not advice, it is a configuration problem
with two known traps.

**The model axis.** `RunsService.getDeps` selects live Gemini dependencies when
`GOOGLE_API_KEY` is set and a canned stub set otherwise (`runs.service.ts:72-74`). Turbo
runs in `envMode: strict` — the 2.x default, confirmed by `turbo run --dry=json` — so a
task receives only the variables its `env` array declares. `turbo.json:35-39` declares
`DATABASE_URL`, `NEO4J_URI`, `NEO4J_USER` and `NEO4J_PASSWORD` for `test:eval` and does not
declare `GOOGLE_API_KEY`. Verified by probe: under `turbo run test:eval`, `DATABASE_URL`
arrives and `GOOGLE_API_KEY` is `undefined`. Any turbo task that runs trials must declare
it, or every trial silently runs the stub model set and the suite reports on canned strings.

**The memory axis.** `MemoryModule` resolves every provider to `null` when `DATABASE_URL`
and `NEO4J_URI` are absent, and `RunsService` then substitutes no-op writers
(`runs.service.ts:82-87`, `273-286`). Those stubs are load-bearing — P0-A requires the
quickstart curls to work on a clone with no `.env` — so they are not going away. The
harness must refuse to run outcome graders when the memory axis is unconfigured rather than
grade a writer that returns `undefined` and discards its argument.

### Trajectory scoring

Beyond the final outcome, a `TrajectoryGrader` scores the node sequence and tool calls
against a reference, using the metric names that have become the common vocabulary:
`trajectory_exact_match`, `trajectory_in_order_match`, `trajectory_any_order_match`,
`trajectory_precision`, `trajectory_recall`. An agent can make every tool call correctly and
still fail the task, and it can reach the right answer through a wasteful path; these are
separate failure modes and need separate numbers.

Today's graph limits what the node-sequence half of that can show. `graph.ts:92-102` wires
one conditional edge — `act → act | distill` (`edges.ts:8`) — and every other edge is
unconditional, so the sequence is
`ingress → retrieve → plan → act{1..maxSteps} → distill → reflect → egress` and varies only
in the loop count. `trajectory_exact_match` over that is close to a constant. The signal
that does vary is the tool-call sequence: `act` records one `toolOutput` per iteration and
records a failed call as an entry carrying an `error` field rather than throwing
(`act.node.ts:73-88`), so precision and recall have to treat an errored call as a call that
happened and did not succeed. Build the metrics for the graph this will become, and
demonstrate them on the axis that moves today.

### Model graders

Model-graded tasks must declare a judge model from a **different family** than the system
under test, to avoid self-preference bias. The package refuses to run a model grader whose
provider matches the agent's provider unless the task sets
`allowSameFamilyJudge: true` with a written justification. The agent is Gemini on both
paths that matter (`runs.service.ts:96-97`), so in practice this means a judge that is not
Google's, and a second credential the repository does not currently ask for.

Judges are validated, not trusted: a `human` grader kind exists so labeled examples can be
imported and a judge's true-positive and true-negative rates measured against them. A judge
with no calibration set is reported as uncalibrated in the summary output.

### Layout

```
packages/eval-harness/
  src/
    types.ts          Task, Trial, Transcript, Outcome, Grader, Score, Suite
    harness.ts        EvalHarness: load → reset → run n trials → aggregate
    graders/
      code.ts         assertion-based graders over Outcome
      model.ts        judge-backed graders, family check, calibration report
      trajectory.ts   node-sequence and tool-call metrics
    reporters/
      json.ts
      junit.ts        for CI test-report ingestion
      summary.ts      GitHub job-summary Markdown
    index.ts
  datasets/
    memory-recall/    tasks migrated from test/fixtures
  package.json
  vitest.config.ts
```

Runner is Vitest, consistent with the unit and integration tiers in
`.context/conventions.md`.

P0-A's non-goals assign one more thing to this PRD: "consolidating the split Jest/Vitest
runners in `apps/agent-service` … belongs with P1-A, which establishes Vitest as the
evaluation runner." That inheritance is answered rather than passed on, and the answer is
mostly no. The split is not an accident in one package; it is the tier scheme in
`.context/conventions.md`, where Service is Jest + `@nestjs/testing` for a reason P0-A
itself discovered and wrote down. Migrating `test:service` off Jest changes a CI gate and
has no evaluation content in it. What this PRD does take is the part that is genuinely
runner configuration for a package it is touching anyway: `apps/agent-service` has no
`vitest.config.ts`, so `test:unit` collects `dist/` alongside `src/`. That gets an
`exclude`. The service tier stays on Jest, and P0-A's non-goal is closed here, not
re-deferred.

### Dataset format

Supersedes the current fixture shape while preserving it. `expectedSeeds` is retained
as-is, and the dormant `assertions` block becomes a list of named code graders.

Two couplings decide where the file lives, and both are one-way traps.

`scripts/seed-eval-fixtures.mjs:19` resolves its input directory to
`apps/agent-service/test/fixtures` and enumerates every `.json` in it. Moving the task file
into `packages/eval-harness/datasets/` while leaving that directory in place makes the
script find nothing, seed nothing, and print `All fixtures seeded successfully` — the
nightly workflow's seed step stays green over an empty database. The directory constant
moves in the same commit as the file, or the file does not move.

The second coupling is that the fixture's seeded graph data is already unreachable, and a
migrated task inherits that. `CypherNeo4jReader.expandFromSeeds` returns
`:Fact` nodes reached by `(seed:Concept)-[:RELATES_TO*0..n]-(:Concept)<-[:MENTIONS]-(f:Fact)`
(`neo4j.reader.ts:34-36`), which is ADR 0004's one-candidate-universe change. The seed
script writes `:Concept` nodes and `RELATES_TO` edges and no `:Fact` or `:MENTIONS`
(`seed-eval-fixtures.mjs:48-75`), so the graph retriever returns zero candidates from seeded
data regardless of the query. Independently, `retrieveNode` derives seed ids from
capitalized tokens in the last user message (`retrieve.node.ts:12-20`), and this fixture's
question — "What are the key components of a stateful agent system?" — yields `["what"]`,
which matches neither `concept-a` nor `concept-b`. So the migrated task exercises the vector
path only, and its `retrievedContextMinLength` assertion passes on one pgvector row. Either
extend the seed format to write facts and their `MENTIONS` edges, or say in the task that it
is a vector-path task. Do not leave a reader to infer that a graph-seeded task tests the
graph.

## Acceptance criteria

- [x] `packages/eval-harness` exists, builds, typechecks, lints, and is listed by
      `yarn workspaces list`. (The root `workspaces` array is a glob, `packages/*`, so
      resolution is the check — there is no array entry to add.)
- [x] `Task`, `Trial`, `Transcript`, `Outcome`, `Grader`, `Score`, and `Suite` are exported
      from the package root.
- [x] `run-fixture-001.json` is migrated to a `Task`, its three dormant assertions run as
      code graders, and `node scripts/seed-eval-fixtures.mjs` still reports seeding it —
      verified by a row count, not by the script's exit code.
- [x] At least one code grader asserts against persisted state — that `reflect` wrote an
      episodic row and MERGEd an entity — reading through `packages/memory-core` rather than
      its own connection.
- [x] That grader is verified on the live memory axis: `DATABASE_URL` and `NEO4J_URI` set,
      against the same run's `runId`. On the unconfigured axis the harness refuses to run it
      rather than passing it.
- [x] The suite is verified once end to end on the live model axis, with `GOOGLE_API_KEY`
      reaching the trial process, and the command that runs trials declares it wherever
      Turbo would otherwise strip it. **Verified with the suite at one task.**
      `tool-use-001` was added after that run and has never executed on the live model axis,
      because the free-tier quota is 20 `generateContent` requests and a 5×2 suite needs
      about forty. What this tick proves is the path — key reaches the trial process, Turbo
      does not strip it, a live trial grades against live stores. It is not the two-task
      suite's live pass rate, and the risk below owns the difference.
- [x] The runner executes n trials per task and reports `pass@k` and `pass^k`.
- [x] A trajectory grader reports precision and recall over the node sequence and over the
      tool-call sequence, and an errored tool call counts as a call that did not succeed.
- [x] A model grader refuses to run same-family judging without explicit opt-in.
- [x] `yarn eval` runs the suite locally and writes JSON, JUnit XML, and a Markdown summary.
      No `test:eval` script is declared in this package.
- [x] `Score.value`, `.label` and `.explanation` map one-to-one onto
      `gen_ai.evaluation.score.value`, `.score.label` and `.explanation`, and `Grader.name`
      supplies the required `gen_ai.evaluation.name`.
- [x] `.context/conventions.md` gains an `Eval` row in the testing table naming the runner
      and the command.
- [x] `apps/agent-service` gets a `vitest.config.ts` that excludes `dist`, and
      `yarn workspace @repo/agent-service vitest list` reports each unit test once. This
      closes the runner-configuration half of P0-A's Jest/Vitest non-goal; the service tier
      stays on Jest.
- [x] The package README states the current pass rate and does not round it up.

### Where the delivery diverged from the design above

Recorded here rather than by editing the design, because the design is the argument that
was reviewed and the divergences are the part a reader needs to see.

- **The trial runner is a Node program, not Vitest.** The design said "Runner is Vitest,
  consistent with the unit and integration tiers." The package's own unit tests are Vitest;
  the trials are `node dist/eval/run-eval.js`, because a trial run holds one Nest
  application context across every trial and its output is three report files rather than a
  pass/fail line — and because a Vitest suite in this package is one `package.json` edit
  away from the `test:eval` script the non-goals forbid.
- **`Outcome` is a snapshot the adapter captures, not a live connection graders hold.**
  `AgentHarness.captureOutcome` reads the stores through `memory-core`'s `inspectRun` and
  hands graders plain data. It keeps the package free of a database dependency, and it puts
  the numbers a grader judged into the JSON report, so a disputed result is re-read rather
  than re-run — which for a suite of live model calls is the difference between an argument
  and a bill.
- **`Grader` gained a `requires` field.** The interface as drafted had nowhere to say "this
  grader is only meaningful on a live memory axis," which is the refusal the fifth criterion
  asks for.
- **Trajectory metrics are five named graders, not one.** `gen_ai.evaluation.name` is the
  metric name, so one grader emitting five numbers would not map onto the event this package
  is shaped for. Each metric carries a threshold declared in the task file, and a threshold
  of `0` reports a metric without gating on it — which is how node precision is published
  despite falling with every extra `act` iteration.
- **A second task was added.** The risks say a 100% pass rate means the suite is too easy.
  `memory-recall-001` passes everything on both axes, so `tool-use-001` grades whether the
  agent reaches for the one tool it has. It does not, on either axis, and that is what takes
  the suite off 100%.
- **`PgNeo4jSeedManager` applies a seed as well as restoring to one.** Deleting alone leaves
  a two-task suite unrepeatable: the Neo4j half of the reset is database-wide, because
  neither `:Concept` nor `:Fact` carries a session, so one task's reset takes another task's
  concepts with it.

## Risks and open questions

- **The outcome graders are unblocked, and the way they can still be fooled has moved.**
  P2-A shipped, so `MemoryModule` constructs the real adapters and `reflect` writes to live
  stores. What remains is that the no-op writers are still reachable: they are what
  `RunsService` substitutes when the memory axis is unconfigured (`runs.service.ts:82-87`),
  and they are load-bearing rather than vestigial. A grader run against them observes
  nothing written and, unless it checks the axis first, cannot distinguish that from an
  agent that wrote nothing.
- **Turbo's strict env mode is the second way to grade a stub.** Verified rather than
  assumed: `turbo.json` declares no `GOOGLE_API_KEY` for `test:eval`, and a probe task run
  under `turbo run test:eval` sees `DATABASE_URL` set and `GOOGLE_API_KEY` `undefined`. A
  suite wired through Turbo without that declaration reports on canned strings and looks
  identical to one that is working.
- **Cost.** Every trial is a live model call, and n trials multiply it. Keep the initial
  suite small (10–20 tasks) and accept that the full suite is a nightly artifact until
  P1-B makes replay free.
- **The seeded fixtures are not comparable to what the agent writes.**
  `scripts/seed-eval-fixtures.mjs:80` stores `sin(i * 0.01)` vectors, whose L2 norm is
  `19.364676`. The live path stores L2-normalized `gemini-embedding-001` output, norm
  `1.000000` — confirmed by querying both in one table after P2-A. Cosine ops tolerate the
  mismatch, and `rrfMerge` overwrites `score` with the reciprocal-rank score before it
  reaches the transcript (`retrieval-facade.ts:85-88`), so a grader reading
  `RetrievalCandidate.score` never sees a distance at all. The trap is live for a grader
  that queries `semantic_facts` directly for a similarity, and for any task that compares a
  seeded fact against a written one. Normalize the fixtures, or generate them through the
  same embedder the agent uses.
- **The seed script writes to Postgres directly** (`seed-eval-fixtures.mjs:83-88`), which is
  the same rule-4 exception this PRD is closing for graders. It already imports
  `runMigrations` from `memory-core`; folding the insert into the same package is small and
  belongs with the dataset migration, but it is a change to a script the nightly workflow
  depends on and should be its own commit.
- **A 100% pass rate means the suite is too easy.** If the first run passes everything,
  the tasks are wrong, not the agent. Add failing cases until the rate is meaningfully
  below 100%.
- **Environment reset between trials.** Postgres and Neo4j carry state across trials, and
  `reflect` writes are idempotent by content hash, so a second trial may read the first
  trial's writes. Reset means restoring the seeded state, not emptying the database — a
  truncate that also removes `expectedSeeds` makes every trial after the first a different
  task. This needs to be explicit in `EvalHarness`, not left to the task author. The
  checkpointer's own tables are outside `runMigrations` and are created by
  `PostgresSaver.setup()`; each run mints a fresh `thread_id`, so they accumulate rather
  than interfere, and the reset can leave them alone.
- **Open question, settled:** standalone with pluggable reporters, no LangSmith dependency.
  Worth revisiting once P1-D needs baseline storage.
- **`tool-use-001` has not run on the live model axis.** It was written after the live
  verification of `memory-recall-001`, and the key's free-tier quota for `gemini-2.5-flash`
  `generateContent` is 20 requests, which a 5×2 suite exhausts in its first task. The
  package README says which axes produced each number rather than presenting the stub-axis
  rate as the suite's.
- **`IO_RETRY` does not retry a 429, and a rate-limited free tier is exactly where a retry
  would help.** `isClientError` treats every 4xx as terminal on the reasoning that "a
  malformed request, a rejected key or a missing model is not going to succeed on attempt
  three" — true of 400, 401 and 404, false of 429, which comes with a `Please retry in Ns`
  hint. Today it takes down the whole suite. **P1-C owns it**, because it is the PRD that
  runs evaluation in CI, where the same quota applies and the blast radius is a nightly job
  rather than a laptop. Noted here rather than fixed, because changing the retry predicate
  is a change to production behaviour outside this PRD's criteria.
- **Vitest in `apps/agent-service` collects `dist/` as well as `src/`.** `test:unit` runs
  every unit test twice — `vitest list` reports 46 tests where 23 are distinct, once from
  `src/agent/graph/edges.test.ts` and again from the compiled
  `dist/agent/graph/edges.test.js` — because `tsc --build` emits test files and Vitest 4's
  `defaultExclude` is `['**/node_modules/**', '**/.git/**']`, which no longer covers `dist`.
  Found while implementing P0-A and left alone then; it is a criterion here. It wastes time
  and could report a stale compiled copy as a pass — the two copies happen to agree at HEAD,
  which is luck, not a property. The package has no `vitest.config.ts` at all; adding one
  with an `exclude` is the fix, and keeping test files out of `rootDir` is the alternative
  that also stops shipping them in the image.

## References

- OpenTelemetry GenAI evaluation attributes:
  https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-events.md
- `pass^k` as a reliability metric: τ-bench, https://github.com/sierra-research/tau2-bench
- Practitioner guidance on binary rubrics and judge calibration:
  https://hamel.dev/blog/posts/evals-faq/
