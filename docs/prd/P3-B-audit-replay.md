---
id: P3-B
title: Deterministic replay for audit reconstruction
tier: 3
status: draft
size: L
depends_on: [P2-A, P1-B]
blocks: [P3-C]
issue: null
superseded_by: null
---

# P3-B · Deterministic replay for audit reconstruction

## Problem

An auditor asks: reconstruct exactly what the agent saw and decided in run X six months ago.
Today the repository keeps two things about a production run, and neither answers that.

**The checkpoint history is the trace of a run, not its inputs.** The graph compiles with a
`PostgresSaver` (`graph.ts:107`, constructed at `memory/memory.module.ts:110-120`) under
`thread_id = runId` (`runs.service.ts:282`, `:292`). Two `POST /runs` were made on
2026-09-26 against fresh `pgvector/pgvector:pg16` and `neo4j:5-community` containers, model
axis `stub`, one session, the README's request body. Each run left nine rows in
`checkpoints` (steps -1 to 7), 37 in `checkpoint_blobs` and 28 in `checkpoint_writes`, and
`getStateHistory` returns the channel values of every super-step as readable JSON (blob
type `json`). What the rows do not hold:

- **The request.** The input checkpoint's `__start__` blob is `{"runId":"6d4c…"}` and
  nothing else. The request body is a closure argument (`graph.ts:45`) parsed inside
  `ingress` (`ingress.node.ts:15`); only the fields `ingress` copies into state survive.
- **Retries.** A probe graph on the same saver with a node that threw once and then
  succeeded under a `retryPolicy` left a history indistinguishable from a first-attempt
  success — no error, no attempt count. A node that exhausted its retries left one
  `__error__` write holding only the last attempt's message. Every attempt of a node in
  this graph makes model calls (`IO_RETRY` is on all five I/O nodes, `retry.ts:27-33`),
  so a run's history does not say how many answers the model gave.
- **Model inputs and identity.** The prompt `plan` sent is built from state
  (`plan.node.ts:28-35`) and could be rebuilt — but only with the prompt template of the
  code that ran, and no production artifact records which code ran. The image copies
  `dist`, `node_modules` and `packages` and no `.git` (`apps/agent-service/Dockerfile:30-35`);
  `GIT_SHA` appears in no Dockerfile, compose file or workflow. The only `git rev-parse` is
  in the eval wiring (`src/eval/cassette-deps.ts:172-173`). `CHAT_MODEL`
  (`runs.service.ts:63`) is a constant of that same unrecorded code.
- **The query embedding.** `retrieve` passes it to the facade and keeps only the
  candidates (`retrieve.node.ts:41-54`).

**The stores cannot be re-queried and do not record who wrote them.** Run 2's
`retrievedContext` held the fact run 1 had written, so the same request retrieves
differently depending on when it is sent: retrieval is an input to be recorded, not a
function to be re-run. And after both runs, `semantic_facts` held one row whose
`episode_id` was run 1's, and `episodes` held two rows, both run 1's; run 2 appears in
neither. That is by design — the pgvector upsert keeps the first `episode_id`
(`pgvector.writer.ts:34`), the `:Fact` sets `episodeId` only `ON CREATE`
(`neo4j.writer.ts:90-92`), and episodic writes are first-write-wins
(`episodic.repo.ts:57`) — so "what did run X write" cannot be read from memory.

**The decisions exist only in evaluation.** `packages/agent-cassette` records every model
decision at the `ModelDeps` seam (ADR 0005), but only in `EVAL_CASSETTE_MODE=record`, into a
committed JSON file, buffered until `close()` (`recorder.ts:114-121`), under a header that
requires `taskId`, `trialIndex` and axes of literally `live`/`live`
(`packages/agent-cassette/src/types.ts:46-57`). Production records nothing at that seam.

**And the rows are mutable.** The saver upserts checkpoints with `ON CONFLICT … DO UPDATE`
and ships `DELETE … WHERE thread_id = $1` (`@langchain/langgraph-checkpoint-postgres@0.1.3`,
`dist/sql.js:55-60`, `:73-75`; `deleteThread` at `dist/index.js:487`). Nothing in `apps` or
`packages` calls `getStateHistory` or `deleteThread` today.

## Why it matters

HIPAA's technical safeguards require "mechanisms that record and examine activity in
information systems that contain or use electronic protected health information" (45 CFR
§ 164.312(b)), and a Medicare Advantage organization keeps its records for ten years from
the end of the contract period or the completion of an audit (42 CFR § 422.504(d)); Medicaid
managed care plans keep theirs for no less than ten years (42 CFR § 438.3(u)). The
determination P3-A types carries "a specific reason for every denial" — an auditor or an
appeal will ask what the tool that assisted it actually read. A trace (P2-C) is sampled and
lossy; an episodic table is first-write-wins; a checkpoint history omits the request and the
retries. ADR 0001 names the checkpointer as "the substrate P3-B's audit replay is built on"
(`docs/adr/0001-langgraph-over-a-durable-execution-engine.md:29-31`). This PRD builds on it
and shows what the substrate lacks.

## Scope

- **A run record**, persisted in Postgres beside the checkpoints for every run on the
  configured memory axis: the request as received, the code identity, the model identities,
  and every decision at ADR 0005's seam plus every retrieval read, appended as each one
  resolves.
- **The seam moved into production.** The `DecisionCall` builders and the
  `recordingModelDeps` / `replayModelDeps` pair leave `src/eval/cassette-deps.ts` for
  `src/agent/model/decision-seam.ts`, so production and evaluation record through one
  spelling of each request.
- **A sixth seam, `memory.retrieve`**, for the run record only. The cassette's `SEAMS` stay
  five: evaluation replays the model axis and keeps memory live (ADR 0005), and nothing
  about that changes.
- **Code identity in the image**: a `GIT_SHA` build argument on the agent-service
  Dockerfile, passed by compose and CI, read into the record's header.
- **`audit:replay <runId>`**, compiled into the image: it re-executes the run at its
  recorded commit with every input served from the record, and compares every super-step
  against the recorded checkpoint history. `--read-only` prints the reconstruction without
  re-executing.
- **ADR 0007**, recording what an audit record is and why it differs from a cassette.
- **"Before real data"** in `.context/conventions.md`: the preconditions a deployment on real
  member data must meet for this record, and who owns them.
- `docs/STATUS.md` gains a row; `.context/architecture.md` gains the run record.

### Non-goals

- **Making the record tamper-evident.** Every table here, the checkpoints included, can be
  rewritten by whoever holds the service's credentials. Replay proves a record is complete
  and consistent; it cannot prove it is unaltered, because a consistent edit to both the
  decisions and the checkpoints passes. **P3-C** commits each run record to a hash chain.
- **Deleting anything.** Checkpoints are retained without bound today and so is the run
  record. A retention ceiling needs a delete path, and a delete path in an audit store is an
  integrity event the ledger has to record — **P3-C**, if review wants one (see open
  questions).
- **An HTTP surface over the record.** Who may read a run's prompts is an access-control
  question with no authenticated caller in this repository yet. **P3-D** owns the first
  reviewer-facing surface; until then the command is an operator tool.
- **Interrupts, sends or subgraphs.** Nothing here changes the graph's topology. An
  approval pause is **P4-C**'s, and P5-C's note that such a graph may not cite its
  cross-version checkpoint check does not arise here — see "Replay runs at the recorded
  commit".
- **Whether the model would decide the same today.** That is drift, **P1-E**. Replay serves
  the recorded answer by construction.
- **Revisiting first-write-wins episodes.** P2-A handed this here
  (`docs/prd/P2-A-wire-memory-core.md:221-226`). The record answers it without a schema
  change: an edited, re-sent turn is in the request of the run that sent it, so the audit
  never reads `episodes`. The episodic table keeps its semantics.

## Design

### A run is a function; the checkpoints are its trace

`reflect` is written to be "a function of `state.extraction`" (`reflect.node.ts:15-18`), and
ADR 0005 argues that freezing the seam table determines a run. Put together: given the code
at a commit, the request, the answers at the model seam and the retrieval reads, every state
transition is determined. The checkpoint history is that function's trace. So production
persists the arguments, and replay re-evaluates the function and checks the trace.

Every source of variation in a run, and what happens to it:

| Input                                   | Where it enters                                               | Recorded or recomputed                                                                               |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Request body                            | `graph.ts:45`, parsed at `ingress.node.ts:15`                 | Recorded — not in any checkpoint                                                                     |
| `runId`                                 | `randomUUID()`, `runs.service.ts:282`                         | Recorded (header and state)                                                                          |
| `plan`, `selectTool`, `extractEntities` | `ModelDeps`                                                   | Recorded at the seam, every attempt                                                                  |
| Embeddings (query and facts)            | `ModelDeps.embed`                                             | Recorded at the seam                                                                                 |
| Tool output                             | `act.tool` seam                                               | Recorded. `web-search` is a pure stub (`runs.service.ts:87-94`) but P4-C's tools will not be         |
| Retrieval candidates                    | `retrievalFacade.retrieve`, `retrieve.node.ts:44-50`          | Recorded (`memory.retrieve`). Depends on store state at that instant; cannot be recomputed           |
| Code, prompts, `CHAT_MODEL`             | the build                                                     | Recorded as `gitSha`; replay refuses any other commit                                                |
| Wall clock                              | `createdAt: new Date()`, `reflect.node.ts:74`; checkpoint ids | Not recorded. Reaches Neo4j and checkpoint metadata, never a state channel; excluded from comparison |
| Retry backoff jitter                    | `IO_RETRY`, `retry.ts:31`                                     | Not recorded. Affects timing only                                                                    |
| Memory writes                           | `reflect`                                                     | Recomputed. A function of recorded inputs; replay captures the calls instead of performing them      |

Tied retrieval scores no longer reorder (`3b696d5`, ADR 0006), but that matters less here
than in evaluation: the candidates are read from the record, not from the store.

### What production persists

Two tables in a migration `0002_run_records.sql` in `packages/memory-core`:

```sql
CREATE TABLE run_records (
  run_id uuid PRIMARY KEY,           -- = checkpoint thread_id
  session_id uuid, correlation_id text NOT NULL,
  request jsonb NOT NULL,            -- the body as received, before any parse
  git_sha text,                      -- null only on a build with no GIT_SHA and no .git
  chat_model text NOT NULL, embedding_model text NOT NULL, embedding_dimensions int NOT NULL,
  model_axis text NOT NULL,          -- 'live' | 'stub' | 'replay' — what actually ran
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  outcome text                       -- 'success' | 'partial' | 'error'; null while running
);
CREATE TABLE run_decisions (
  run_id uuid NOT NULL REFERENCES run_records, ordinal int NOT NULL,
  format_version int NOT NULL,       -- the cassette format the decision was written in
  decision jsonb NOT NULL,           -- a DecisionSchema value from @repo/agent-cassette
  PRIMARY KEY (run_id, ordinal)
);
```

`session_id` is nullable because a request that fails `RunRequestSchema` is still a run the
service received. The record is opened before the invoke, each decision is inserted as it
resolves — not buffered, because the run an auditor most wants is the one that crashed —
and the row is closed with the outcome in a `finally`.

**The decision reuses the cassette's `DecisionSchema`; the record does not reuse the
cassette.** What carries over from P1-B is the seam, the request builders, the canonical
hash, the queue-per-key replay semantics that make a retried error followed by a success
replayable, the float32 vector codec and the key redaction. What does not carry over is the
header — `taskId`, `trialIndex` and axes pinned to `live`/`live` describe an evaluation
trial, and a production run on the stub model axis is still a run that happened — nor the
file sink, nor buffering until `close`. The seam enum for the record is
`[...SEAMS, 'memory.retrieve']`, validated by a record-side extension of `DecisionSchema`, so
a cassette can never contain a retrieval and a record always can.

**Why the record lives in `memory-core`.** `.agents/reviewer.md:18-19` forbids a database
call outside `packages/memory-core`, and the record is written by the same role, into the
same database, under the same migrator (`src/migrate.ts:25-27`) as the episodic table. It is
not a memory tier: nothing in `GraphDeps` can read it, and the architecture document says
so. P3-C reaches the opposite conclusion for its ledger, and the difference is the database
role — see P3-C.

**`PersistingDeck`** implements the cassette's `Deck` against a `RunRecordRepository`. It
is layered outside any evaluation decorator (`runs.service.ts:178-179`), so an evaluation
run on the configured memory axis is recorded like any other, with `model_axis` naming what
served it.

### Code identity

The Dockerfile gains `ARG GIT_SHA` and `ENV GIT_SHA=$GIT_SHA` in the runner stage; compose
passes `${GIT_SHA:-}` and `ci.yml`/`e2e.yml` pass `${{ github.sha }}`. Under `tsx` with no
variable set, the service calls the existing `gitHead()` and records the sha with a `dirty`
flag. A record whose `git_sha` is null is kept, and replay refuses it by name.

### Replay runs at the recorded commit

```
node dist/audit/replay.js <runId> [--read-only] [--json]
```

1. Load the record, its decisions and the checkpoint history for `thread_id = runId`.
2. Refuse (exit 2) unless the running build's sha equals `git_sha`, printing the sha. In a
   deployment that means running the command in the image tagged with it.
3. `--read-only` stops here and prints the reconstruction: the request, each super-step's
   node and state delta, and the decisions consumed between consecutive checkpoints.
4. Otherwise build `GraphDeps` entirely from the record: the model half is
   `replayModelDeps(player)`, retrieval is a facade served by the same player, and the
   `reflect` writers capture their calls. Nothing is written to any store, and no model
   client is constructed — the signature argument P1-B makes for `replayModelDeps`.
5. Invoke with the recorded request and `correlationId` on a `MemorySaver`, same
   `thread_id`. Compare checkpoint by checkpoint: `next` and the canonical JSON
   (`canonicalJson`) of the channel values. Checkpoint ids, `ts` and metadata are excluded.
6. Exit 0 only if every checkpoint matches, the counts match, and the player has no
   unconsumed decision. Exit 1 names the first divergent step and prints the channel diff.
   The report lists the memory writes the run made, derived from the captured calls.

Replaying at the recorded commit removes cross-version checkpoint compatibility from the
problem: the LangGraph that reads the history is the one that wrote it. The price is that
the table's migrations must be additive-only, so an old build can still read the newer
schema; that rule goes into `.context/conventions.md`.

**Prototype, 2026-09-26.** A scratch script (deleted) rebuilt `buildAgentGraph` from
`dist`, served retrieval from run 2's recorded checkpoint and the stub's answers for the
model seams, captured the writes, and compared its `MemorySaver` history against run 2's
Postgres history with `canonicalJson`: 9 of 9 checkpoints identical. With `plan`'s answer
changed to another string, steps 3 to 7 diverged and -1 to 2 did not. That is the stub
axis, where the answers were typed in rather than recorded; the acceptance criteria below
require the record to supply them.

### What replay proves

It proves the record is **complete** — no unrecorded input influenced any state transition
— and **consistent** with the checkpoints, and it derives what the run wrote to memory. It
does not prove the record is **unaltered**, which is P3-C, and it does not re-exercise the
model client: a defect between the wire and the seam is invisible, as ADR 0005 says of
cassettes, and for an audit that is the right cut — the record holds what the agent acted
on.

### How this differs from P1-B, precisely

| Question         | P1-B cassette                               | P3-B run record                                        |
| ---------------- | ------------------------------------------- | ------------------------------------------------------ |
| What it answers  | Does today's graph still behave this way?   | What did run X do, and is the record complete?         |
| Written when     | Deliberately, `EVAL_CASSETTE_MODE=record`   | Every run on the configured memory axis                |
| Stored           | Committed JSON, one file per trial          | Postgres, beside the checkpoints, one row per decision |
| Seams            | The five model seams                        | The five model seams plus `memory.retrieve`            |
| Memory on replay | Live, reset and re-seeded; writes performed | Reads served from the record; writes captured          |
| Code on replay   | Whatever is checked out — that is the test  | The recorded commit, or refuse                         |
| Checked against  | Graders over the outcome                    | The recorded checkpoint history, step by step          |
| Contents         | Synthetic fixtures, read in public          | Whatever a caller sent — PHI in a real deployment      |

ADR 0005 described P3-B's artifact as "the checkpointer's rows, written by a run nobody
planned to replay". The first half is kept — the rows are what replay checks — and the
second is the finding: those rows alone cannot be replayed, because the request, the
retries and the retrieval reads are not in them. ADR 0007 records this and ADR 0005's
consequence gains a one-line pointer to it; ADR 0005's decision is unchanged.

### Content, and who owns it for real data

The run record holds prompts, so it holds whatever members' data a request carried. The
checkpoints already hold the messages and retrieved context, so this is the same class of
data in more rows, not a new one. ADR 0003 limits this repository to synthetic data, and
this PRD writes the preconditions a deployment on real data must meet into a "Before real
data" section of `.context/conventions.md`: encryption at rest for the run-record and
checkpoint tables (volume encryption, or envelope encryption of `request` and `decision`
under a KMS key); read access logged, for example with `pgaudit` on `SELECT` against those
tables, since reading prompts is itself "activity" under § 164.312(b); a separate
read-only role for audit readers; and a retention policy that meets the ten-year floors
above. **The deploying covered entity owns those controls**, and this repository cannot
evidence them — P4-A's catalogue lists them as `procedural`. P2-C left opt-in content
capture open; the content store it asked for is this record, which every node span already
references by `run_id`, so no content goes on a span (P3-C records that decision).

## Acceptance criteria

- [ ] `packages/memory-core/migrations/0002_run_records.sql` creates `run_records` and
      `run_decisions`; integration tests on live Postgres cover a round trip, an idempotent
      re-open of the same `run_id`, and an append after the run failed.
- [ ] `recordingModelDeps` and `replayModelDeps` live in
      `src/agent/model/decision-seam.ts`; `src/eval/cassette-deps.ts` imports them, and
      `EVAL_CASSETTE_MODE=replay yarn eval` reproduces the same per-grader results as `main`.
      Model `replay` / memory `live`.
- [ ] `packages/agent-cassette`'s `SEAMS` still has five members, and a unit test asserts a
      `CassetteSchema` parse rejects a `memory.retrieve` decision while the record schema
      accepts one.
- [ ] One `POST /runs` on memory `live` leaves one `run_records` row whose `request` equals
      the body sent under `canonicalJson`, and whose decisions are, in order,
      `embed`, `memory.retrieve`, `plan.callLlm`, `act.selectTool`,
      `distill.extractEntities`, then one `embed` per fact. Model `stub` / memory `live`.
- [ ] A run whose `plan` throws once and then succeeds leaves two `plan.callLlm` decisions,
      an error then a value, while its checkpoint history shows one; replay exits 0. Model
      `stub` with an injected fault / memory `live`.
- [ ] `audit:replay` exits 0 on a run recorded on memory `live` for each of model `stub` and
      model `replay`; the latter serves the committed cassettes' recorded Gemini answers, so
      the replayed decisions are ones a real model produced, with no request to
      `generativelanguage.googleapis.com`.
- [ ] Mutation tests: editing one decision's response exits 1 naming the first divergent
      step; deleting one decision exits 1 with a miss; adding one exits 1 with an
      unconsumed decision; editing one checkpoint blob exits 1 at that step.
- [ ] `audit:replay` exits 2 with the recorded sha in its message when the build's sha
      differs, and when `git_sha` is null.
- [ ] `docker build --build-arg GIT_SHA=$(git rev-parse HEAD)` produces an image whose runs
      record that sha, and `node dist/audit/replay.js` runs inside it.
- [ ] Replay makes no write to Postgres or Neo4j: row and node counts before and after are
      equal.
- [ ] `docs/adr/0007-*.md` exists and is indexed; ADR 0005's audit-replay consequence links
      to it.
- [ ] `.context/conventions.md` has a "Before real data" section and the additive-only rule
      for run-record migrations; `docs/STATUS.md` has a row, `implemented`, citing the
      replay test.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Risks and open questions

- **Sized `L`, not the index's `M`.** A migration and repository, the seam moved across a
  package boundary, a sixth seam, a build argument in three places, a replay command, and
  two memory-live acceptance axes. The comparison was prototyped on the stub axis; the
  record that feeds it has never existed, and the first real record may show an input this
  table missed.
- **The premise could be wrong in one place: an unrecorded input nobody has listed.** The
  table above is exhaustive for the graph at `77e3191`. A future node that reads the clock
  into state, calls `Math.random`, or reads a store outside the facade breaks replay, and
  the mutation tests cannot detect an input nobody recorded. The protection is structural:
  replay constructs no store client and no model client, so an unrecorded read fails loudly
  rather than silently reading today's data. A new seam is added the way this PRD adds
  `memory.retrieve`.
- **Parallel branches would make step order a question.** The graph has one path through
  every super-step. A fan-out (P4-C's approval gate, or `Send`) would need the comparison
  to key on task ids rather than position.
- **Recording cost.** About twenty decision rows per run, 4 KB per embedding. At the
  cassette sizes (`packages/agent-cassette/README.md`, 48-94 KB per trial) that is tens of
  kilobytes per run, unbounded, beside checkpoints that are already unbounded.
- **P1-F bumps the cassette format to version 2.** The record embeds `DecisionSchema`, so
  whichever lands second adopts the other's schema; the record stores `format_version` per
  row so an old row stays readable.
- **Open question — retention.** Keep everything (this draft), or add a prune command
  bounded by a retention period? Deleting a record is an integrity event: if review wants
  one, P3-C must record deletions as ledger entries, and this PRD grows by one command.
- **Open question — fail open or closed on a record write.** This draft fails the run if
  opening the record fails (before any work is done) and logs, without failing, if a later
  append fails, leaving `finished_at` null so the gap is queryable. A payer deployment may
  want every run without a complete record to fail; that changes the error contract of
  `POST /runs`.
- **The regulatory reading is a portfolio's, not counsel's.** § 164.316(b)(2)(i)'s six years
  applies to the documentation the Security Rule requires, not to every log line, and this
  PRD does not claim otherwise.

## References

- 45 CFR § 164.312(b), (c)(1), https://www.law.cornell.edu/cfr/text/45/164.312
- 45 CFR § 164.316(b)(2)(i), https://www.law.cornell.edu/cfr/text/45/164.316
- 42 CFR § 422.504(d), https://www.law.cornell.edu/cfr/text/42/422.504
- 42 CFR § 438.3(u), https://www.law.cornell.edu/cfr/text/42/438.3
- LangGraph.js persistence and `getStateHistory`, `@langchain/langgraph@0.4.10`;
  `@langchain/langgraph-checkpoint-postgres@0.1.3`, `dist/sql.js` and `dist/migrations.js`.
- `docs/adr/0001-langgraph-over-a-durable-execution-engine.md`,
  `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md`,
  `docs/adr/0006-deterministic-retrieval-order-over-the-vector-index.md`.
- `docs/prd/P1-B-agent-cassette.md` — the seam and format this reuses.
