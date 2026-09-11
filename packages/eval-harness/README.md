# `@repo/eval-harness`

Evaluation of the agent as a package: tasks, graders, trials, and three reporters.

Everything else in this repository can be judged by reading it. Whether the agent behaves
is the one claim that only a measurement settles, and this is the measurement.

## Running it

```bash
docker compose up -d postgres neo4j
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentdb \
NEO4J_URI=bolt://localhost:7687 \
  yarn eval
```

`yarn eval` is `turbo eval`, which runs `node dist/eval/run-eval.js` in
`apps/agent-service`. That entry point boots the real Nest application context, so a trial
exercises the same `MemoryModule` providers, the same model axis and the same checkpointer
a request would. Reports land in `apps/agent-service/eval-results/` — `eval-report.json`,
`eval-report.xml` (JUnit) and `eval-summary.md` — or wherever `EVAL_OUTPUT_DIR` points.
`EVAL_TRIALS` overrides the five trials per task, and `EVAL_CASSETTE_MODE` is `record` or
`replay` — see below. All three are declared on `turbo.json`'s `eval` task, without which
strict env mode strips them.

This package deliberately declares **no `test:eval` script**. `agent-eval.yml` runs
`yarn turbo test:eval` across every workspace, so declaring one here would silently make
the nightly job run live trials on whatever axes that runner happened to have. P1-C owns
wiring evaluation into CI.

## What it grades

A grader receives the transcript **and the outcome**, and the ones that matter assert
against the outcome — the state of Postgres, Neo4j and pgvector after the run. An agent
can produce a plausible answer while writing nothing, and pattern-matching the final
message cannot tell the difference.

| Grader                         | Kind | Asserts                                            |
| ------------------------------ | ---- | -------------------------------------------------- |
| `retrieved_context_min_length` | code | retrieval returned at least _n_ candidates         |
| `outcome_must_be`              | code | the run reported the expected outcome              |
| `token_counts_positive`        | code | prompt and completion counts are both above zero   |
| `episodic_row_written`         | code | `episodes` rows exist carrying **this run's** id   |
| `entity_merged`                | code | the concepts _this run_ extracted are in the graph |
| `trajectory_*`                 | code | node-sequence exact / in-order / any-order / P / R |
| `tool_trajectory_*`            | code | the same, over the tool calls                      |

Outcome reads go through `packages/memory-core` — `PgNeo4jMemoryInspector` — never through
a connection this package opens. Reviewer checklist rule 4 is the rule; the reason is that
`scripts/seed-eval-fixtures.mjs` recorded what hand-rolled SQL cost the last time.

`entity_merged` is keyed on the run's own extraction rather than a count of `:Concept`
nodes, because `mergeEntity` writes no episode onto a concept: a count cannot attribute one
to a run and would pass on the seeded concepts alone.

## Which axis a trial ran on

A trial can be run against a stub on two independent axes, and on both of them the stub
passes assertions the real system fails.

- **Model.** `RunsService` picks live Gemini dependencies when `GOOGLE_API_KEY` is set and a
  canned set otherwise. Turbo runs in `envMode: strict`, so `turbo.json`'s `eval` task has
  to declare that variable or every trial silently runs on canned strings. There is a third
  value: `EVAL_CASSETTE_MODE=replay` serves every decision from a recorded cassette and the
  axis reads `replay`, which is a value of its own rather than a disguise for `live` —
  a replayed number is a frozen sample, not a measurement of the model.
- **Memory.** `MemoryModule` resolves every adapter to `null` when `DATABASE_URL` and
  `NEO4J_URI` are absent, and `RunsService` substitutes no-op writers. Those stubs are
  load-bearing — a clone with no `.env` has to serve the quickstart curls — so the harness
  cannot remove them.

Every outcome grader therefore declares `requires: { memory: 'live' }`, and an unmet
requirement **stops the suite before the first trial** rather than producing a pass earned
against a writer that discards its argument. Both axes are logged at start, printed at the
top of the Markdown summary, and recorded in the JSON and JUnit reports.

## `pass@k` and `pass^k`

Agents are stochastic, so each task runs _n_ trials (default 5) and both numbers are
reported. `pass@k` — at least one trial passed — is capability. `pass^k` — every trial
passed — is reliability, and it decays as `p^k`. The gap between them is the point, and it
is the number that matters for anything that touches memory writes.

## Trials are independent, and that takes work

`reflect`'s writes are idempotent by content hash and `episodes` is keyed on
`(session_id, turn_index)` with first write wins, so without a reset the second trial of a
task writes no episodic row at all and its `runId` appears nowhere. Every trial therefore
begins with `restoreToSeed` followed by `applySeed`: delete what the last trial wrote, then
lay the task's seed back down.

The deletion is **database-wide on the Neo4j side**. Neither `:Concept` nor `:Fact` carries
a session, so "everything this session's trials wrote" cannot be expressed in Cypher —
"everything the seed does not own" can, and that is what runs. Point an evaluation run at a
disposable database.

## Dataset

`datasets/memory-recall/` holds the task files. `EVAL_DATASETS_DIR` is exported so nothing
has to spell the path — `scripts/seed-eval-fixtures.mjs` imports it, because the previous
arrangement (a path literal pointing into `apps/agent-service/test/fixtures`) would have
gone stale the moment the dataset moved, and a seed step that finds nothing reports success.

## Current results

Measured 2026-08-29. Each number says which axes produced it, because a number that does
not is not a measurement.

**Model `stub`, memory `live` — 5 trials × 2 tasks. Overall pass rate 50%.**

| Task                | pass@k | pass^k | Trials passed |
| ------------------- | ------ | ------ | ------------- |
| `memory-recall-001` | yes    | yes    | 5/5           |
| `tool-use-001`      | no     | no     | 0/5           |

`tool-use-001` fails `tool_trajectory_recall` on all five: the stub `selectTool` always
returns `null`, so no tool call is ever made. Every other grader passes on both tasks,
including the two that read persisted state — which is the interesting part of this run,
because the memory axis is live and the reset is what makes trials 2 through 5 write their
own episodic rows at all.

**Model `live`, memory `live` — 1 trial of `memory-recall-001`. All eleven graders passed.**

One `POST`-equivalent run wrote 2 `episodes` rows, 17 `semantic_facts` rows and 17
`(:Fact)` nodes under its own `runId`, and 38 of the 38 concepts it extracted were present
in the graph afterwards. It made no tool call, which is the same behaviour the stub set
shows and the reason `tool-use-001` exists.

`tool-use-001` has **not** been run on the live model axis. It was added after the live
verification, and this key's free-tier quota for `gemini-2.5-flash` `generateContent` is 20
requests — a 5×2 suite needs roughly forty. The number above is therefore not the suite's
live pass rate, and is not presented as one.

## Recording and replaying a trial

```bash
EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval   # live model axis, writes cassettes
EVAL_CASSETTE_MODE=replay yarn eval                 # no model call at all
```

A cassette records the decisions a trial made at the five `ModelDeps` seams — not HTTP
traffic; ADR 0005 argues the seam choice and names what it stops measuring. They live in
`datasets/memory-recall/cassettes/`, one file per trial, and the subdirectory matters:
`loadSuite` parses every `.json` in the dataset directory as a task spec.

Under replay the memory axis stays live — the stores are reset, re-seeded and read by the
outcome graders exactly as in a live run — and a task runs at most as many trials as it has
cassettes. Replaying one cassette five times would report `pass^k = pass@k` and present a
single sample as a reliability measurement. Every report names the set's `recordedAt` and
`gitSha`, because a replayed rate is a property of the recording as much as of the code.

`.context/conventions.md` lists what invalidates a set. The short version: a prompt edit
moves the request hash, every replay misses, and `CassetteMissError` prints the diff.

## What this package does not do

- **Reading a cassette.** This package resolves their paths and counts them; it never opens
  one. `@repo/agent-cassette` is the format, and its only runtime dependency is `zod` —
  importing it here for a type would end that.
- **CI.** P1-C owns the tiered pipeline and retiring `memory-core`'s `test:eval` alias.
- **Statistical gating.** `yarn eval` exits non-zero on any failing trial; deciding which
  failures should block a merge is P1-D.
- **Retrieval-quality metrics** (`Recall@k`, `nDCG`, `MRR`). P2-B, built on the `Grader`
  interface defined here.
- **Span collection.** `Transcript.spans` is part of the contract and is not populated;
  P2-C emits GenAI evaluation events.
- **A live model grader.** `ModelGrader` refuses a judge from the system under test's own
  family without a written opt-in, and the agent is Gemini on both paths that matter — so
  using one needs a second credential this repository does not ask for. The refusal and the
  calibration arithmetic are unit-tested; no judge has been run.
