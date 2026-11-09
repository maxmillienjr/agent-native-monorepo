# `@repo/eval-harness`

Evaluation of the agent as a package: tasks, graders, trials, and three reporters.

Everything else in this repository can be judged by reading it. Whether the agent behaves
is the one claim that only a measurement settles, and this is the measurement.

## Running it

```bash
docker compose up -d postgres
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentdb yarn eval
```

`yarn eval` is `turbo eval`, which runs `node dist/eval/run-eval.js` in
`apps/agent-service`. That entry point boots the real Nest application context, so a trial
exercises the same `MemoryModule` providers, the same model axis and the same checkpointer
a request would. Reports land in `apps/agent-service/eval-results/` — `eval-report.json`,
`eval-report.xml` (JUnit) and `eval-summary.md` — or wherever `EVAL_OUTPUT_DIR` points.
A run that cannot complete writes `eval-abort.json` and an `eval-summary.md` headed
`aborted` instead, and never `eval-report.json`, so that file's presence means the suite
completed. `EVAL_TRIALS` overrides the five trials per task, `EVAL_CASSETTE_MODE` is
`record` or `replay` — see below — and `EVAL_EXPECT_AXES`, when set, refuses a run whose
axes differ from it. All four are declared on `turbo.json`'s `eval` task, without which
strict env mode strips them, as are `EVAL_GATE` and `EVAL_HISTORY_DIR` (below).

In CI, `agent-eval.yml` runs this same command twice: on the replay axis on every pull
request, and on the live axis nightly when a `GOOGLE_API_KEY` repository secret exists.

## What it grades

A grader receives the transcript **and the outcome**, and the ones that matter assert
against the outcome — the state of Postgres and pgvector after the run. An agent
can produce a plausible answer while writing nothing, and pattern-matching the final
message cannot tell the difference.

| Grader                         | Kind | Asserts                                            |
| ------------------------------ | ---- | -------------------------------------------------- |
| `retrieved_context_min_length` | code | retrieval returned at least _n_ candidates         |
| `outcome_must_be`              | code | the run reported the expected outcome              |
| `token_counts_positive`        | code | prompt and completion counts are both above zero   |
| `episodic_row_written`         | code | `episodes` rows exist carrying **this run's** id   |
| `semantic_fact_written`        | code | `semantic_facts` rows exist carrying this run's id |
| `trajectory_*`                 | code | node-sequence exact / in-order / any-order / P / R |
| `tool_trajectory_*`            | code | the same, over the tool calls                      |

Outcome reads go through `packages/memory-core` — `PgMemoryInspector` — never through
a connection this package opens. Reviewer checklist rule 4 is the rule; the reason is that
the nightly seed script, deleted in P1-C, recorded what hand-rolled SQL cost the last time.

`semantic_fact_written` replaced `entity_merged` when `reflect` stopped writing the graph
(P2-E). It is keyed on the row's `episode_id`, so a seeded fact never counts, and it is the
positive control ADR 0011 names: the agent still promotes what the user said.

## Which axis a trial ran on

A trial can be run against a stub on two independent axes, and on both of them the stub
passes assertions the real system fails.

- **Model.** `RunsService` picks live Gemini dependencies when `GOOGLE_API_KEY` is set and a
  canned set otherwise. Turbo runs in `envMode: strict`, so `turbo.json`'s `eval` task has
  to declare that variable or every trial silently runs on canned strings. There is a third
  value: `EVAL_CASSETTE_MODE=replay` serves every decision from a recorded cassette and the
  axis reads `replay`, which is a value of its own rather than a disguise for `live` —
  a replayed number is a frozen sample, not a measurement of the model.
- **Memory.** `MemoryModule` resolves every adapter to `null` when `DATABASE_URL` is
  absent, and `RunsService` substitutes no-op writers. Those stubs are
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

Both deletes are scoped to the session: every session the task names, the graded input's,
each prior run's and each seeded fact's. A seed is `semantic_facts` rows alone, each under
the session it names, and the task format refuses any other seed key (P2-E). Point an
evaluation run at a disposable database anyway: a fact keeps its first writer, so rows
another run wrote can decide whose a fact is.

## Dataset

`datasets/memory-recall/` holds the task files. `EVAL_DATASETS_DIR` is exported so nothing
has to spell the path. The nightly seed script that first imported it is gone, and the
reason still holds: its previous arrangement (a path literal pointing into
`apps/agent-service/test/fixtures`) went stale the moment the dataset moved, and a consumer
that finds nothing reports success. A trial needs no seed step of its own — every trial
applies its task's seed in `reset`, against the schema `MemoryModule` migrates on boot.

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

One `POST`-equivalent run wrote 2 `episodes` rows and 17 `semantic_facts` rows under its
own `runId`, and, at the time, as many `(:Fact)` nodes in a graph since removed (P2-E). It made no tool call, which is the same behaviour the stub set
shows and the reason `tool-use-001` exists.

`tool-use-001` has since run on the live model axis, once: one trial on 2026-09-10 passed
on three `web-search` selections (P1-G), and the recording run for P1-B's cassettes passed
one trial of each task the same day. That is one trial per task. The 5×2 suite needed
roughly forty `generateContent` calls against the free-tier quota of 20 a day for
`gemini-2.5-flash`, and was never run, so none of these numbers is the suite's live pass
rate, and none is presented as one. Every number in this section was measured on
`gemini-2.5-flash`. The pin has been `gemini-3.5-flash-lite` since P1-I (ADR 0018), whose
recording run is the first measurement on it:
memory-recall 3 of 3 and red-team 3 of 3 at `4ddbaff`, prior-auth 22 of 24 at `86f6acc`
with 0 wrongful approvals of 16, all on 2026-11-09, one trial each (P1-I's recording table).

P2-B added a third task, `graph-recall-001`, which proved that a fact only the graph held
reached `plan`'s prompt, graded by a `retrieved_from_source` grader. ADR 0009 made retrieval
vector-only, so no graph fact can reach the prompt, and the task, its cassette, its baseline
cells and the grader were deleted together. The two remaining cassettes replay unchanged:
their context never held a graph fact.

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
moves the request hash, every replay misses, and `CassetteMissError` prints the diff. That
includes the instruction of each JSON seam, which its request carries from cassette format
3 (P1-I). A set in an older format, or recorded on another chat model id, is refused before
any store is reset.

## Evaluation events

After grading a trial, `EvalHarness` emits one OpenTelemetry `gen_ai.evaluation.result`
event per grader result. An event is a log record emitted through the Logs API, not a span
event: `Span.addEvent` is the API OTEP 4430 deprecates, and the GenAI conventions define
the evaluation result as an event in the Logs data model. Each record carries
`gen_ai.evaluation.name`, `.score.value`, `.score.label` and, when the grader wrote one,
`.explanation`, plus the task, the trial index, the grader kind and both axes, so a
replayed `pass` can never be averaged with a live one downstream.

The record's trace and span id are the trial's `invoke_agent` span, rebuilt from the
transcript's root `SpanRecord`. The run has finished by the time it is graded, and a log
record carries ids rather than a live span, so that is allowed. A transcript with no spans
gets unparented events. The API is a no-op until an SDK registers a logger provider.
`yarn eval` registers one, logs how many events it emitted beside how many grader results
the report holds, and exports both spans and events over OTLP when
`OTEL_EXPORTER_OTLP_ENDPOINT` is set. `eval-report.json` names the conventions commit the
spans and events follow, as `genAiSemconvCommit`.

## The regression gate

```bash
EVAL_CASSETTE_MODE=replay EVAL_GATE=replay yarn eval   # compare with the committed baseline
EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval   # accept a change: rewrite it, no key
yarn eval:promote-live <cassette digest>               # commit a live reference (P1-D)
```

Without `EVAL_GATE`, `yarn eval` exits non-zero when any trial failed, which is a local
signal and nothing more. With it, the gate's verdict decides the exit code, and the runner
writes `eval-gate.json` beside the reports and appends a section to `eval-summary.md`.
Either way a budget breach also exits non-zero; see the next section.

- **Replay is a snapshot, not a statistic.** Trial `i` replays cassette `i` in the baseline
  run and in this one, so a per-cell difference has zero variance. `src/gate/` compares
  every `(task, trial, grader) → (label, value)` cell with
  `datasets/memory-recall/baselines/replay.json`, exactly, and every difference blocks:
  `regressed`, `improved`, `value-moved`, `missing` (a skipped task, a deleted assertion),
  `unbaselined`, and `stale-digest` when the cassette set changed and the baseline did not.
  An improvement blocks because a baseline that kept the old `fail` would match a later
  regression back to it. The explanation is not in the cell, because it carries the run id.
  A run that aborted is `aborted`, which also blocks. Accepting any of this is
  `EVAL_GATE=update` and a baseline diff someone reviews; after a re-record, run it too.
- **Live is statistical, and usually says `insufficient-evidence`.** `EVAL_GATE=live`
  appends the run's tally — one pass/fail per trial — to the orphan `eval-history` branch
  checked out at `EVAL_HISTORY_DIR`, pools every night of the same cassette digest (an
  _epoch_), and compares that pool with `baselines/live.json`. The statistic is the mean
  over tasks of the difference in trial pass rates, with a stratified percentile bootstrap
  below 20 tasks (`tasks-fixed`: about these tasks only) and P2-B's paired bootstrap over
  per-task differences from 20 (`tasks-random`). At δ = 0.20 the verdict is `regressed`
  only when Δ ≤ −δ and the interval excludes 0, `held` only when its lower bound is above
  −δ, and neither below 15 trials per task per arm. A failed live trial is data, and only
  `regressed` or an abort fails the job.

`stats/` holds the resamplers and nothing that knows what a task is. `pairedBootstrap` was
written for P2-B's retrieval ablation, archived since P2-E.

## The graph's two measurements, archived

P2-B's retrieval ablation measured the graph/vector/hybrid question ADR 0002 left open, and
P2-D measured the graph's explanation role. Both rules selected against the graph: ADR 0009
took it out of retrieval and ADR 0012 removed it. P2-E deleted the two runners and the
modules only they called, `src/retrieval/` among them, after both reproduced their
committed reports with no key at `df655c0`.

**To reproduce either, check out the tag `archive/p2e-graph-measurements`.** Its message
has the commands: bring up Postgres and Neo4j, then `yarn eval:retrieval` and
`yarn eval:explanation` with `GOOGLE_API_KEY` empty, and compare with the committed reports
once timestamps and latencies are masked.

`datasets/retrieval-ablation/` stays as committed, the record of both: 335 facts and 200
labelled queries frozen before the first run, the adjudication files, the gold explanation
labels, the recorded embeddings and stage 2's 76 recorded answers, and the reports under
`reports/`. Nothing at HEAD loads it.

**Results.** Recall@10 over all 200 queries: on the deployed path `hybrid` and `vector` both
scored 0.940 and `graph` 0, because the seed linker produced no id the graph held; with gold
seeds `hybrid·oracle` scored 0.145 below `vector`, interval [−0.195, −0.095]. The rule
selected "neither does". The explanation's stage 1 was `good`, and stage 2 was `not met`:
over 38 queries the paths moved `answer_key_present` by −0.079 [−0.184, +0.026], where the
rule needed +0.10.

## Budgets, usage and cost

A task file may declare per-trial ceilings beside `requires`:

```json
"budgets": { "inputTokens": 2200, "outputTokens": 8500, "modelCalls": 5 }
```

`inputTokens` and `outputTokens` are sums of `gen_ai.usage.input_tokens` and
`gen_ai.usage.output_tokens` over the trial's `generate_content` spans, output counting
thinking tokens; `modelCalls` counts those spans, errored ones included. `checkBudgets` reads
nothing but the trial's own spans (P1-F).

- **Beside the pass rate, not inside it.** A budget is not a grader. A trial that did the
  task and spent too much has `passed: true` and `withinBudget: false`, `passRate` does not
  move, and `SuiteReport.budgetBreaches` counts the breach. The run still exits non-zero,
  with or without `EVAL_GATE`, and the summary says which of the two happened. P1-D compares
  pass rates, and a rate that fell because a correct answer got longer would be a quality
  number measuring cost.
- **Absent is not zero.** A successful call whose span has no usage count, or a trial with
  no inference span, is `unmeasurable`, which counts as a breach. A trial whose spans are
  partly replayed is unmeasurable too. Nothing is checked on `model=stub`, which opens no
  inference span, and the summary says so beside the skipped tasks.
- **On replay a budget checks the cassette.** A replayed trial's usage is the recording's,
  exactly, and a change that alters a request misses before it reaches a count. So the
  replay tier fails on one kind of pull request: the one that re-records the set with a
  more expensive prompt. On live a budget is one fresh sample against a loose ceiling.
- **Latency is reported, never a budget.** The loader rejects `latencyMs` with the reason.
  Identical requests in one recording took between 1.1 s and 23.1 s, so a ceiling loose
  enough to hold catches only a hang, which the job timeout already catches, and on replay a
  span's duration is how fast the cassette was read. The live summary prints each trial's
  model latency as one sample; the replay summary prints none and says why.
- **Cost is a list-price equivalent, never asserted.** The harness takes a `PriceTable` as
  an option, since it knows no provider; `yarn eval` passes `GEMINI_PRICES`
  (`apps/agent-service/src/eval/pricing.ts`), which records its source page and the dates.
  A model the table does not list prints `unpriced`, never `$0`, and embedding calls are
  counted and unpriced because the API reports no usage for them.

The current values are each task's recording × 1.5 for input and × 2 for output, rounded
up to the next hundred, and `2 + maxSteps` model calls. Raising one is an edit to the task
file, reviewed in the pull request that needs it.

## What this package does not do

- **Parsing a cassette.** This package resolves their paths, counts them and hashes their
  bytes for the gate's digest; it never parses one. `@repo/agent-cassette` is the format,
  and its only runtime dependency is `zod` — importing it here for a type would end that.
- **CI.** The workflow is `agent-eval.yml` (P1-C); this package has no script of its own for
  it and needs none.
- **Applying the merge gate.** The gate decides the verdict; `.github/rulesets/main.json`
  is what makes `eval-replay` a required check. The owner applied it on 2026-11-09, and a
  change to it is a pull request like any other.
- **Asserting latency or dollars.** Both are reported. A latency gate needs many live
  samples against a baseline, which is P1-D's machinery; a dollar ceiling means nothing
  until two model ids with different prices are compared, which is P1-E's.
- **Span collection.** `Transcript.spans` is filled by the adapter, not by this package.
  `apps/agent-service` keeps the evaluation process's spans in memory and hands each trial
  the spans of its own run's trace, which is how every trial in `eval-report.json` carries
  its `invoke_agent` tree on every axis.
- **A live model grader.** `ModelGrader` refuses a judge from the system under test's own
  family without a written opt-in, and the agent is Gemini on both paths that matter — so
  using one needs a second credential this repository does not ask for. The refusal and the
  calibration arithmetic are unit-tested; no judge has been run.
