---
id: P1-B
title: packages/agent-cassette — decision-level record and replay
tier: 1
status: shipped
size: L
depends_on: [P1-A]
blocks: [P1-C]
issue: 45
superseded_by: null
---

# P1-B · `packages/agent-cassette` — decision-level record and replay

## Problem

Every evaluation trial costs a live model call, and there is no path that does not.

`RunsService.getDeps` picks the Gemini dependency set when `GOOGLE_API_KEY` is set and a
canned stub set otherwise (`runs.service.ts:93-95`). There is no third option. A trial
therefore either spends money and quota, or measures the stub — and P1-A's whole argument
is that a number earned on the stub is a number earned against the half of the system that
cannot fail.

The cost is not hypothetical and its shape is recorded. One live run of `memory-recall-001`
made three `generateContent` calls — `plan` (`plan.node.ts:37`), `act`'s `selectTool`
(`act.node.ts:30`), `distill` (`distill.node.ts:38`) — and eighteen `embedContent` calls:
one for the query (`retrieve.node.ts:41`) and one per distilled fact
(`reflect.node.ts:85`), of which that run produced seventeen. `packages/eval-harness`
defaults to five trials per task over two tasks, and
`packages/eval-harness/README.md:124-127` records what happened when that was attempted:
the key's free-tier quota for `gemini-2.5-flash` is 20 `generateContent` requests, a 5×2
suite needs roughly forty, and `tool-use-001` has never run on the live model axis as a
result. The suite's published live number is one trial of one task.

Two smaller facts sit in the same path and are load-bearing for anything that fixes this.

**The eval command's documented knobs do not reach it.** `run-eval.ts:39-40` reads
`EVAL_TRIALS` and `EVAL_OUTPUT_DIR`, and `packages/eval-harness/README.md:21-22` documents
both. `turbo.json:40-44` declares `GOOGLE_API_KEY`, `DATABASE_URL`, `NEO4J_URI`,
`NEO4J_USER` and `NEO4J_PASSWORD` for the `eval` task and neither of those two. Turbo runs
in `envMode: strict`. Verified by probe — the `eval` script replaced with
`node -p 'JSON.stringify({...process.env})'` and run as
`EVAL_TRIALS=3 EVAL_OUTPUT_DIR=/tmp/x npx turbo run eval` — the task received
`{"DATABASE_URL":true}` and `undefined` for both. So `EVAL_TRIALS=1 yarn eval` runs five
trials, which is the difference between recording a cassette set inside the free-tier quota
and exhausting it on the first task.

**Retrieval's ranking is not stable across a trial reset, and the graph half is
demonstrably not.** `CypherNeo4jReader.expandFromSeeds` orders by
`1.0 / (1.0 + distance)` (`neo4j.reader.ts:42-43`), so every fact at the same hop distance
carries an identical score and the tie is broken by nothing. `PgPgvectorReader` orders by
`embedding <=> $1::vector` with no secondary key (`pgvector.reader.ts:52`, `:57`), and
`AgentServiceHarness.reset` seeds every fact with `fixtureEmbedding()` called with no
argument (`agent-harness.ts:88`), so every seeded fact in a task carries the _same_ vector
and ties exactly. `rrfMerge` then turns list position into rank and rank into score
(`retrieval-facade.ts:64-88`), and `retrievedContext` in that order is interpolated into
`plan`'s prompt (`plan.node.ts:28-35`).

Measured, not inferred: twelve `:Fact` nodes at equal distance from one seed, queried five
times against unchanged data, returned the same order every time; deleted and recreated
three times — which is what `restoreToSeed` followed by `applySeed` does before every
trial — the same query returned three different orders. Any record-and-replay scheme keyed
on the prompt text is therefore built on a prompt that can change between two trials of the
same task over identical seeded data.

## Why it matters

Record-and-replay is the standard answer to "how is this tested in CI without paying for
it," and the interesting part of the answer is not that it exists — VCR, Polly.js and nock
have been the shape of it for a decade — but _at what level it records_ and _what it stops
measuring_. Recording at the transport captures credentials in the fixture, breaks on an
SDK upgrade that changes a header, and cannot record a tool call that is not HTTP.
Recording at the decision seam captures the values the graph actually branches on, carries
no credential, and survives the client being replaced — at the cost of no longer exercising
the client. Being able to say which of those you chose, and name the class of bug the
choice makes invisible, is the difference between having a replay layer and understanding
one.

For this repository it is also the thing that makes the tier below it possible. P1-C
replaces the nightly stub with a tiered pipeline; a pull-request tier that costs a model
call per trial is a pull-request tier nobody will leave switched on, and one that runs the
canned stub set is the failure P1-A exists to prevent. Replay is the third axis value that
makes a cheap tier honest.

## Scope

- A new workspace, `packages/agent-cassette`: the cassette format as a Zod schema, the
  canonical request hash, the recorder, the player, the vector codec, and the miss error.
  It depends on `zod` and nothing else in this repository.
- A decoration hook on `RunsService` so the model half of `GraphDeps` can be wrapped
  without the service learning what a cassette is, and the wiring for it in
  `apps/agent-service/src/eval/`.
- `ModelAxis` gains `'replay'`, and every report says which cassette set produced a
  replayed number and when it was recorded.
- A per-task trial cap, because a suite has as many replayable trials as it has cassettes.
- A recorded cassette set for both tasks in `datasets/memory-recall/`, on the live model
  axis, committed.
- Deterministic tie-breaking in both retrievers, without which replay cannot be
  reproducible. `ORDER BY score DESC, contentHash` in Cypher and
  `ORDER BY embedding <=> $1::vector, content_hash` in SQL.
- `EVAL_CASSETTE_MODE`, `EVAL_TRIALS` and `EVAL_OUTPUT_DIR` declared on `turbo.json`'s
  `eval` task. The last two are already documented as working and are not; a change that
  adds a third variable to the same stripped list has to fix the list.
- An ADR recording the decision-seam choice against the transport-level alternative.

### Non-goals

- **Wiring replay into CI.** This PRD delivers the mode and the recorded set; the tiered
  pipeline that decides which tier runs on a pull request and which runs nightly is
  **P1-C**, which also owns retiring `memory-core`'s `test:eval` alias and the `IO_RETRY`
  429 defect P1-A left it.
- **Deciding which failures block a merge.** `yarn eval` exits non-zero on any failing
  trial, replayed or not. Comparing a replayed rate against a baseline is **P1-D**.
- **Detecting model drift.** A replayed trial cannot, by construction — see the design.
  Pinned-versus-floating model ids are **P1-E**.
- **Cost and latency budgets.** Recorded token counts are exactly the input P1-F wants, and
  a replayed `Transcript.latencyMs` measures replay speed rather than the agent. **P1-F**
  owns both, and owns not confusing them.
- **Span capture.** `Transcript.spans` stays unpopulated; **P2-C** fills it.
- **A graph-path cassette.** Both tasks seed `:Concept` nodes and no `:Fact`, so
  `expandFromSeeds` returns nothing and the recorded runs exercise the vector path only —
  the same limitation the tasks already declare. A seed format that writes facts and their
  `MENTIONS` edges is **P2-B**'s, which needs one for the ablation.
- **Audit-grade replay.** Reconstructing what a past production run did, from its
  checkpoints, is **P3-B**. It is a different mechanism against a different artifact; the
  design says how they differ.
- **Recording a tool that changes the world.** The one registered tool is a pure function
  (`runs.service.ts:142-147`). A reversibility-tiered registry is **P4-C**, and a cassette
  of an irreversible call is its problem, not this one's.

## Design

### What a decision is

The seam is `ModelDeps` (`runs.service.ts:55-61`) — the four functions that cost a model
call, plus tool execution:

| Seam                      | Request                    | Response                      |
| ------------------------- | -------------------------- | ----------------------------- |
| `plan.callLlm`            | system prompt, user prompt | content, token counts         |
| `act.selectTool`          | plan text, tool names      | `{toolName, input}` or `null` |
| `act.tool`                | tool name, input           | tool output                   |
| `distill.extractEntities` | conversation context       | `Extraction`                  |
| `embed`                   | text                       | 768 floats                    |

Everything else in a run is a function of those. The graph's one conditional edge branches
on `shouldContinue` (`edges.ts:8-13`), which `act` sets from whether `selectTool` returned a
selection; `plan`'s prompt is built from `state.messages` and `state.retrievedContext`;
`distill`'s context is `state.messages` joined; every `embed` argument is either the user's
message or a fact from the recorded extraction. Freeze the table above and the run is
determined.

Nothing in any recorded request depends on the `runId`. It is minted per run
(`runs.service.ts:208`, `:237`) and reaches the checkpointer's `thread_id` and `reflect`'s
writes, and none of the five call sites above passes it. That is what lets a replayed run
mint a fresh `runId`, write under it, and still be graded by `episodic_row_written` and
`entity_merged`, which read persisted state for _this_ run.

### The memory axis stays live

Replay substitutes the model axis and only the model axis. A replayed trial still needs
Postgres and Neo4j, still resets and re-seeds, and still has its outcome read out of the
stores by `PgNeo4jMemoryInspector`. The alternative — replaying the store reads too — would
leave the outcome graders with nothing real to assert against, and those are the graders
P1-A exists for. Containers are free; model calls are not.

That is also why the retrieval facade is not a recorded seam. Given the same seeded state
and the same query embedding it is a pure function of the database, and the database is
restored before every trial.

### Decision-level, not transport-level

Recorded at the seam above rather than at the wire, and the trade is deliberate:

- **A cassette carries no credential.** `createGeminiEmbedder` puts the key in an
  `x-goog-api-key` header (`gemini-embedder.ts:34`); a transport recording captures it, a
  decision recording never sees it. For a repository that is read in public this is the
  deciding argument.
- **It survives the client.** P5-C upgrades `@langchain/langgraph`, and
  `gemini-embedder.ts:16-24` already exists because the pinned `@langchain/google-genai`
  lacks an output-dimension parameter. A transport cassette is invalidated by either
  change; a decision cassette is not.
- **It covers a tool that is not HTTP.** `Tool.execute` is `(input: unknown) =>
Promise<unknown>` (`act.node.ts:6-9`), and P4-C's registry will hold tools that are not
  network calls at all.
- **The cost, stated plainly: replay exercises the graph, not the client.** A defect in
  `parseExtraction`, in `l2Normalize`, in the `embedContent` response check
  (`gemini-embedder.ts:49-57`) — the exact class of defect that made P2-A ship broken twice
  — is invisible under replay, because the recorded value is the parsed one. The nightly
  live tier is what covers that, and P1-C owns keeping it.

This is what the ADR records.

### Format

```ts
export const CassetteHeaderSchema = z.object({
  formatVersion: z.literal(1),
  taskId: z.string().min(1),
  trialIndex: z.number().int().nonnegative(),
  recordedAt: z.string().datetime(),
  gitSha: z.string().length(40),
  // Recording anything but a live model is a fake of a fake. The literal is the check.
  axes: z.object({ model: z.literal('live'), memory: z.literal('live') }),
  chatModel: z.string(),
  embeddingModel: z.string(),
  embeddingDimensions: z.number().int().positive(),
});

export const DecisionSchema = z.object({
  seam: z.enum(SEAMS),
  /** Which tool, at the `act.tool` seam. Absent elsewhere. */
  label: z.string().optional(),
  /** sha256 over canonical JSON of `{ seam, label, request }`. The lookup key. */
  requestHash: z.string().length(64),
  /** Kept for the miss diff, never for lookup. Redacted before it is written. */
  request: z.unknown(),
  response: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('value'), value: z.unknown() }),
    z.object({ kind: z.literal('vector'), float32Base64: z.string() }),
    z.object({
      kind: z.literal('error'),
      name: z.string(),
      message: z.string(),
      status: z.number().int().optional(),
    }),
  ]),
  tokenCounts: z.object({ prompt: z.number(), completion: z.number() }).optional(),
  latencyMs: z.number().nonnegative(),
});

export const CassetteSchema = z.object({
  header: CassetteHeaderSchema,
  decisions: z.array(DecisionSchema),
});
```

**Lookup consumes in recorded order.** The player holds one queue per
`(seam, label, requestHash)` and takes the head. Two identical requests in one run are two
entries and are consumed in order; when a queue empties, that is a miss, not a reuse. This
is what makes a retry replayable: `IO_RETRY` re-runs a throwing node with the same input
(`retry.ts:27-33`), so attempt 1's error and attempt 2's success are two entries under one
hash, and replay reproduces both — including the retry.

**Errors are recorded, successes are not the only story.** A run that failed live has to
replay as failing, or the cassette set can only encode happy paths. Only `name`, `message`
and `status` are kept, after a redaction pass, because a Google SDK error can carry the
request URL and a URL can carry a key.

**Vectors are float32.** `semantic_facts.embedding` is `vector(768)`
(`migrations/0001_semantic_facts.sql:13`) and pgvector's `vector` is an array of `float4`,
so a float32 cassette loses nothing the database would not lose on the way in — and the
query vector is cast the same way by `embedding <=> $1::vector`. The saving is not
cosmetic: measured over 768 dimensions, one vector is 16,345 bytes as a JSON float array
and 4,096 as base64 float32. At eighteen vectors a trial that is 303 KB against 76 KB, and
the cassette set is committed.

### Wiring

`packages/agent-cassette` exports one interface and two implementations of it:

```ts
export interface Deck {
  readonly mode: 'record' | 'replay';
  resolve<R>(
    call: { seam: Seam; label?: string; request: unknown },
    live: () => Promise<R>,
  ): Promise<R>;
}
export class CassetteRecorder implements Deck {} // calls live(), appends, writes on close
export class CassettePlayer implements Deck {} // never calls live(); throws on a miss
```

`RunsService` gains one method and nothing else:

```ts
/** Wraps the model half of the dependency set. The service does not know what a cassette is. */
setModelDecorator(decorate: (deps: ModelDeps) => ModelDeps): void;
```

applied inside `getDeps` between the axis switch and the assembly of `retrieve` and
`reflect` (`runs.service.ts:90-110`), so the memory half is untouched. It sits alongside
the existing `setDeps` (`runs.service.ts:78-80`), which replaces the whole set and is what
the service spec uses; the two do not overlap.

In replay mode the decorator ignores its argument and returns a `ModelDeps` built entirely
from the player. **No Gemini client is constructed at all**, so "replay never falls through
to a live call" is a structural property of the wiring rather than a promise the player
makes. `run-eval.ts` additionally subscribes to the `undici:request:create` diagnostics
channel and fails the run if any request reaches `generativelanguage.googleapis.com` —
`fetch` and the LangChain client both go through undici, so one subscription covers both.

### Where cassettes live, and how many trials there are

`packages/eval-harness/datasets/memory-recall/cassettes/<taskId>.trial-<n>.json`, resolved
by a helper the harness exports next to `EVAL_DATASETS_DIR` — the P1-A lesson about not
spelling a dataset path twice applies unchanged.

The subdirectory is not decoration. `loadSuite` reads every `.json` in the dataset
directory and parses each as a task spec (`dataset.ts:125-135`), so a cassette dropped
beside a task file makes the suite throw on a Zod error. `readdirSync` is not recursive and
`cassettes` does not end in `.json`, so a subdirectory is skipped.

Under replay, a task runs as many trials as it has cassettes, capped below
`Suite.trialsPerTask`. `Task` gains an optional `trialsPerTask` override and the runner
honours it (`harness.ts:89`). Replaying one cassette five times would report
`pass^k = pass@k` and present a single sample as a reliability measurement.

### What replay stops measuring

Stated in the design because it is the part a reader will otherwise assume away.

A replayed suite is a **regression test against a frozen sample**, not a measurement of the
agent. `pass^k` over five replayed trials reproduces the recorded run's `pass^k` exactly and
will keep reproducing it until the cassettes are re-recorded. It catches a change in the
graph, the prompts' effect on branching, the memory writes, the graders and the retrieval
path. It cannot catch the model getting worse — that is P1-E — and it cannot catch the
client breaking, as above.

This is why `ModelAxis` gains `'replay'` rather than replay being made to look like `live`.
`detectAxes` reads `EVAL_CASSETTE_MODE` alongside the two variables it already reads
(`axes.ts:15-23`), `SuiteReport` gains a `replay` block naming the cassette set's
`recordedAt` and `gitSha`, and the Markdown summary prints it under the axis line. A grader
that must not be trusted on a replayed trial says `requires: { model: 'live' }` and the
existing refusal stops the suite before the first trial (`axes.ts:59-69`).

### Determinism is a prerequisite, and it is not free

The tie-breaking defect in the Problem section is in scope because replay does not work
without fixing it, and the fix is two `ORDER BY` clauses. Two things about it are worth
being exact on:

- **It is not reachable by today's dataset.** Each task seeds one pgvector fact and no
  `:Fact` nodes, so `expandFromSeeds` returns nothing and `retrievedContext` has one
  element. There is no tie to break yet.
- **It becomes reachable the moment a task seeds a second fact**, which P2-B's ablation
  requires. Fixing it here, while the cassettes that depend on it are being recorded, is
  cheaper than debugging a flaky replay later — and the Neo4j half is proven unstable
  across resets, which is the harder half to diagnose after the fact.

The pgvector half was probed the same way and was stable across three delete-and-reinsert
cycles. It gets the tiebreaker anyway, because "stable in a probe" and "guaranteed" are
different claims and only one of them can be relied on by a cassette.

### Layout

```
packages/agent-cassette/
  src/
    types.ts        Seam, CassetteSchema, DecisionSchema, header
    hash.ts         canonical JSON + sha256 over { seam, label, request }
    vector.ts       Float32Array <-> base64
    redact.ts       key-shaped strings out of a recorded error
    recorder.ts     CassetteRecorder
    player.ts       CassettePlayer, CassetteMissError
    index.ts
  package.json
  vitest.config.ts

apps/agent-service/src/eval/
  cassette-deps.ts  ModelDeps <-> Deck, both directions
```

## Acceptance criteria

- [x] `packages/agent-cassette` exists, builds, typechecks, lints, and is listed by
      `yarn workspaces list`. Its only runtime dependency is `zod`.
- [x] `Seam`, `CassetteSchema`, `Deck`, `CassetteRecorder`, `CassettePlayer` and
      `CassetteMissError` are exported from the package root.
- [x] `EVAL_CASSETTE_MODE=record yarn eval` on model `live` / memory `live` writes one
      cassette per trial, schema-valid against `CassetteSchema`, and the suite's own
      reports are unchanged in shape. Verified 2026-09-10: `EVAL_CASSETTE_MODE=record
EVAL_TRIALS=1 yarn eval` wrote two cassettes, and the three reports carry the same
      keys they did on the stub run beside a new `replay` block that a recording run does
      not set.
- [x] Both tasks in `datasets/memory-recall/` have at least one committed cassette recorded
      on the live model axis. The five-trial set is **not** required: recording it needs
      about forty `generateContent` calls against a 20-request free-tier quota, and P1-C
      owns the pipeline that would run it. One trial of each, recorded 2026-09-10 at
      `021c6f2` for eight `generateContent` and twenty-one `embedContent` calls; the
      recording run itself passed every grader on both tasks.
- [x] `EVAL_CASSETTE_MODE=replay yarn eval` with `GOOGLE_API_KEY` **unset** reproduces the
      recorded trials' per-grader results exactly, on memory `live`. Verified 2026-09-10:
      all twenty-one grader results identical to the recording run's, in 2s against the
      recording's 83s. Run with `GOOGLE_API_KEY=` rather than unset, because `run-eval.ts`
      loads the repository root `.env` and unsetting the shell variable does not reach it —
      `detectAxes` and `getDeps` both treat an empty value as absent.
- [x] A replayed run makes no request to `generativelanguage.googleapis.com`, asserted at
      runtime by the `undici:request:create` subscription, not by inspecting a bill. Both
      replay runs reported none. The subscription is itself unit-tested by publishing on
      the channel, because an empty violation list is also what a watcher subscribed to the
      wrong channel name produces.
- [x] Two consecutive replays of the same cassette set produce identical `eval-report.json`
      after masking `startedAt`, `finishedAt`, `runId` and `latencyMs` — **and the run id
      where `episodic_row_written` interpolates it into its explanation string**, which the
      four named fields do not cover and which the criterion did not anticipate. With that
      one substitution the two reports are byte-identical; without it they differ in
      exactly those two strings and nowhere else.
- [x] A miss throws `CassetteMissError` naming the seam, the request hash, and a diff of
      the recorded request against the actual one. Unit-tested.
- [x] Replay refuses, with one unit test each: a header whose `axes.model` is not `live`; a
      `chatModel`, `embeddingModel` or `embeddingDimensions` that differs from the running
      configuration; a `formatVersion` that is not `1`.
- [x] Recording refuses when `detectAxes().model !== 'live'`. Verified by running
      `GOOGLE_API_KEY= EVAL_CASSETTE_MODE=record yarn eval`: it fails before the first
      trial with `cassette recording refused: model=stub memory=live is not a live run`.
- [x] A cassette in which one seam's first entry is an error and its second is a success
      replays as two attempts, reproducing the `IO_RETRY` retry. Unit-tested against a
      synthetic cassette.
- [x] No committed cassette contains a string matching `AIza[0-9A-Za-z_-]{35}`, asserted by
      a unit test that walks the cassette directory. The test also refuses an empty
      directory, which is what it would otherwise have kept passing over.
- [x] Recorded vectors round-trip through base64 float32 with equality, and a recorded
      trial's cassette is under 128 KB. Asserted over the committed files: 93.9 KB and
      48.3 KB, and every recorded vector re-encodes to the bytes in the file.
- [x] `ModelAxis` includes `'replay'`; `SuiteReport` carries the cassette set's
      `recordedAt` and `gitSha`; the Markdown summary prints them beside the axis line, the
      JUnit properties carry them on the same test suite as the `pass^k` they qualify, and
      the runner refuses both a replay with no provenance and provenance on a run that was
      not replaying.
- [x] A task runs at most as many trials as it has cassettes under replay, and the report
      says the count it used. The replay runs above were `EVAL_TRIALS` at its default of
      five and one trial per task, with `TaskReport.trialsPerTask` reading 1 beside the
      suite's 5.
- [x] `loadSuite` still loads exactly two tasks with the cassette directory present —
      a regression test, because `dataset.ts:125` reads every `.json` in that directory.
      Asserted twice: against the shipped dataset, and against a temporary one holding two
      task files and a `cassettes/` full of `.json`.
- [x] `expandFromSeeds` and `searchByCosine` each order by a unique secondary key, and an
      integration test asserts the graph query returns the same order across three
      delete-and-reseed cycles — the sequence that produced three different orders before
      the change.
- [x] `turbo.json`'s `eval` task declares `EVAL_CASSETTE_MODE`, `EVAL_TRIALS` and
      `EVAL_OUTPUT_DIR`, confirmed by the same probe that found them missing — the `eval`
      script replaced with `node -p` reported all three present — and by
      `EVAL_TRIALS=1 yarn eval` running one trial per task.
- [x] `docs/adr/0005-*.md` records the decision seam over the transport, is listed in the
      ADR index, and names the defect class replay makes invisible: everything between the
      wire and the value a seam returns — `parseExtraction`, `l2Normalize`, the
      `embedContent` response check — because the recorded value is the parsed one.
- [x] `docs/STATUS.md` gains a row for zero-cost replay (row 18), and
      `.context/conventions.md` says what a cassette is recorded against and the list of
      changes that force a re-record.
- [x] The package README states which axes each committed cassette was recorded on and that
      a replayed `pass^k` is a frozen sample, not a reliability measurement.

## What shipped, and where it diverged from the design

Measured 2026-09-10, memory `live` throughout:

| Run                | Axis     | Result                     | Wall clock |
| ------------------ | -------- | -------------------------- | ---------- |
| recording, 1 x 2   | `live`   | 100%, every grader on both | 83s        |
| replay of that set | `replay` | identical, all 21 results  | 2s         |
| replay again       | `replay` | byte-identical report      | 2s         |

Eight `generateContent` and twenty-one `embedContent` calls bought the set. The
per-task split is worth recording because the Problem section's arithmetic was
built on the first task only: `memory-recall-001` costs three and fourteen,
`tool-use-001` costs **five** and seven, because its `act` node loops over three
`web-search` selections and each iteration is another `selectTool` call. A
five-trial set is therefore forty `generateContent` calls, not thirty.

Three places where the implementation is not what the Design section describes,
each deliberate:

- **The axis is built lazily when a decorator is installed.** The design says the
  replay decorator "ignores its argument", which makes "no Gemini client is
  constructed" true only while `GOOGLE_API_KEY` happens to be absent — the axis
  switch would have run first. `getDeps` now hands the decorator a `ModelDeps`
  that constructs the real one on first use, so ignoring the argument is what
  makes the claim structural. A unit test counts chat-client constructions on
  both paths, because a client that is constructed and never used makes no
  request either and proves nothing about the next change.
- **The provenance reaches the report through `EvalHarnessOptions`, not through
  `AgentHarness`.** The design says `SuiteReport` gains a `replay` block and does
  not say how it gets there. The cassette headers are files the wiring has
  already opened, and widening the adapter interface for a value it would only
  pass through makes every implementor pay for one adapter's bookkeeping. The
  runner refuses both halves of the lie instead: a `replay` axis with no
  provenance, and provenance on a run that was not replaying.
- **The trial index is counted in `AgentServiceHarness`, off `reset`.** Same
  reasoning, and the runner's fixed order — reset, run, capture, grade — is what
  makes counting resets the same as counting trials.

The open question the design left is closed: `cassette-deps.test.ts` runs the same
task twice through a recorder and asserts the request hashes match, so the premise
that no recorded request depends on the `runId` is established by running rather
than by reading five call sites.

One thing the criteria did not anticipate. Two consecutive replays are identical
after masking `startedAt`, `finishedAt`, `runId` and `latencyMs` **and** the run
id where `episodic_row_written` interpolates it into its explanation string. The
four named fields do not cover a uuid inside a grader's prose, and a future
comparison that masks only those four will see a false difference in exactly two
strings. P1-D, which compares reports against a baseline, inherits that.

## Risks and open questions

- **A prompt edit invalidates every cassette, and that is the design working.** Change the
  string at `plan.node.ts:6` or `extraction.ts:3-4` and the request hash moves, every
  replay misses, and the set has to be re-recorded against a live key. The alternative —
  keying on a normalized shape so a prompt edit still replays — is worse: it returns the
  old answer for a new prompt and calls it a pass. The mitigation is ergonomic, not
  structural: the miss error prints the diff, and `EVAL_CASSETTE_MODE=record` regenerates.
  The honest cost is that the one kind of pull request this makes more expensive is a
  prompt change, and that is a common kind of pull request in an agent repository.
- **Re-recording needs a key and a quota, and neither is in CI.** Whoever re-records pays
  the forty-call cost, and the free tier does not cover it in a day. P1-C inherits the
  question of whether the pipeline re-records or fails; this PRD only has to leave the
  failure legible.
- **A stale cassette and a real regression look the same from the exit code.** A miss and a
  failed grader both fail the run. They need to be distinguishable in the summary — a miss
  is a chore, a grader failure is a defect — and if they are not, the first stale set
  teaches everyone to ignore the signal. The reporter change is small; forgetting it is the
  risk.
- **Replay could be reproducible for the wrong reason.** If the cassettes were recorded
  before the tie-break fix and replay passes anyway, that proves the current dataset never
  produced a tie — not that the ordering is deterministic. Record the set after the fix, or
  the criterion measures nothing.
- **The premise that no recorded request depends on the `runId` was established by
  reading five call sites, not by running.** It holds at HEAD; a node that starts putting
  the run id into a prompt breaks replay silently, in the sense that every trial after it
  misses on the first decision. A test that runs the same task twice and asserts the
  request hashes match would catch it, and belongs with the implementation.
- **Zero repository dependencies is a claim the wiring can quietly break.** The moment
  `agent-cassette` imports `@repo/eval-harness` for `ModelAxis`, or `@repo/memory-core` for
  `EMBEDDING_DIMENSIONS`, the package stops being liftable and starts being a second place
  the eval types live. The header carries `embeddingDimensions` as data for exactly this
  reason.
- **Sizing.** `L` assumes the determinism prerequisite is the only surprise. P0-A's lesson
  is that a defect found by reading is one defect and the count is known only after the
  thing runs — and the two facts in the Problem section that were found by running rather
  than reading, the stripped `EVAL_TRIALS` and the unstable Cypher ordering, are both
  evidence for that lesson rather than against it.

## References

- LangGraph `RetryPolicy` semantics, which the retry-replay entry depends on:
  https://langchain-ai.github.io/langgraphjs/reference/interfaces/langgraph.RetryPolicy.html
- pgvector storage format (`vector` is `float4`), which is why the cassette is float32:
  https://github.com/pgvector/pgvector#vector-type
- Node `diagnostics_channel` and undici's `undici:request:create`, the no-network
  assertion: https://nodejs.org/api/diagnostics_channel.html#undicirequestcreate
- Turborepo strict environment mode, the reason a documented knob can silently not exist:
  https://turborepo.com/docs/crafting-your-repository/using-environment-variables
- VCR, as the transport-level alternative the ADR argues against:
  https://github.com/vcr/vcr
