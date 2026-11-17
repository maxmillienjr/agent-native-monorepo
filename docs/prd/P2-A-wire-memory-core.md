---
id: P2-A
title: Wire memory-core into the service; add checkpointing and retry
tier: 2
status: shipped
size: L
depends_on: [P0-A]
blocks: [P1-A, P2-B, P3-B, P4-C]
issue: null
superseded_by: null
---

# P2-A · Wire memory-core into the service; add checkpointing and retry

## Problem

`apps/agent-service` never constructs an adapter from `packages/memory-core`. Both
dependency sets in `runs.service.ts` pass the graph closures instead: the live set returns
`[]` from `retrieve` (`runs.service.ts:56-61`) and writes nothing in `reflect`
(`runs.service.ts:84-96`); the stub set returns two literals (`runs.service.ts:120-136`)
and writes nothing (`runs.service.ts:153-174`). Eight rows of `docs/STATUS.md` — 1, 2, 3,
4, 6, 13, 15 and 16 — are that one fact.

Seven further facts follow from it, each verified at HEAD:

1. **Nothing owns the schema.** There is no `drizzle.config.ts`, no migrations directory,
   and no `CREATE TABLE` on any application path. `episodes` is created only inside
   `packages/memory-core/test/episodic.integration.test.ts:24`; `semantic_facts` is created
   in two integration tests, in `scripts/seed-eval-fixtures.mjs:37`, and by
   `PgPgvectorWriter.ensureTable` (`pgvector.writer.ts:24-35`), which nothing calls outside
   tests. Five hand-rolled copies of two tables: four of `semantic_facts`, one of
   `episodes`.
2. **The embedding dimension is a literal in six places on the application path, and
   thirteen across the repository.** `pgvector.writer.ts:11` (Zod),
   `pgvector.writer.ts:29` (DDL), `retrieval-facade.ts:6` (Zod),
   `scripts/seed-eval-fixtures.mjs:40` (DDL) and `:88` (fixture vectors), plus the stub
   embedding at `runs.service.ts:116`. Seven more are in test files — `graph.test.ts:11`,
   `semantic.integration.test.ts:31,106` and
   `retrieval-facade.integration.test.ts:37,88,117,135`. The acceptance criterion below is
   repo-wide, so all thirteen are in scope. The model that produced 768,
   `text-embedding-004` (`runs.service.ts:34`), is retired for `embedContent`, so
   `POST /runs` returns 500 whenever `GOOGLE_API_KEY` is set.
3. **The graph compiles with no checkpointer and no retry.** `graph.ts:64` is
   `return graph.compile()` with no argument, and `retryPolicy` occurs zero times in
   source. A transient Neo4j error fails the run.
4. **The episodic write is a bare `INSERT`** (`episodic.repo.ts:34-44`) into a table with
   no unique constraint beyond its surrogate key (`episodic/schema.ts:3-12`). A replayed
   run duplicates every turn. ADR 0001 names this as the first of its two tracked
   obligations.
5. **RRF cannot fuse, and changing the key does not fix it.** `retrieval-facade.ts:47`
   keys on `entityId ?? content`, and Neo4j candidates always carry `entityId` while
   pgvector candidates never do. The deeper reason is that the two readers return different
   kinds of object: `neo4j.reader.ts:29-38` returns `:Concept` nodes, `pgvector.reader.ts:22-28`
   returns fact rows. Two lists drawn from disjoint universes cannot intersect under any
   key. `:Fact` and `:Session` node labels are documented at `README.md:169` and
   `.context/architecture.md:67` and are written zero times; `MERGE (c:Concept)`
   (`neo4j.writer.ts:39`) is the only label the writer produces.
6. **Vector search reads across every session.** `pgvector.reader.ts:22-28` has no `WHERE`
   clause, although `RetrievalQuerySchema` accepts `sessionId` (`retrieval-facade.ts:10`)
   and `retrieve.node.ts:49` passes it. `topK` and `hopDepth` are validated by
   `RunRequestConfigSchema` (`run-request.schema.ts:4-8`) and then dropped: `ingress.node.ts:31`
   carries `maxSteps` and nothing else, and `retrieve.node.ts:47-48` hardcodes `topK: 10`
   and `hopDepth: 2`.
7. **The assistant's turn never enters `state.messages`.** `plan.node.ts:42-48` returns
   `currentPlan` and token counts; no node writes `messages` after `ingress`. Verified by
   running the service: `POST /runs` on the stub set returns
   `"messages":[{"role":"user","content":"What is LangGraph?"}]` and no assistant turn, and
   `currentPlan` appears in no field of `RunResponse` (`egress.node.ts:25-33`). Episodic
   memory is specified as "Full turn history" (`.context/architecture.md:61`);
   `reflect.node.ts:44-54` would persist half of one.

Two request-path defects sit on the same code and were handed here by P0-B and by this
review:

- `POST /runs/stream` writes its first SSE frame before a node can fail, so
  `GlobalHttpExceptionFilter` writing a JSON body onto the committed response throws
  `ERR_HTTP_HEADERS_SENT` and the client is left with a stream that stops after `ingress`.
- A request without an `x-correlation-id` header returns 500, not 400.
  `runs.controller.ts:19` binds the header to a `string`, `ingress.node.ts:22` passes it to
  `seedWorkingMemory`, and `working-memory.helpers.ts:12` requires
  `correlationId: z.string()`, so the Zod parse at `working-memory.helpers.ts:26` throws.
  Verified against `yarn dev` on the stub set: `POST /runs` with no header returns
  `{"statusCode":500}`. The README quickstart does not set the header and does not hit
  this, because it goes through the gateway, which mints one at
  `apps/gateway/src/middleware/correlation-id.middleware.ts:5`. Port 3000 is documented as a
  service URL in the README's Full-Stack Docker table and has no such middleware.

  The service is one line short, not missing the concept. `LoggingInterceptor` already
  mints an id when the header is absent (`logging.interceptor.ts:16`), sets it as the
  response `x-correlation-id` header (`:20`), stores it on `req.correlationId` (`:23`) and
  runs the handler inside `runWithCorrelationId` (`:26`). The one thing it does not do is
  write it back to `req.headers`, which is exactly what the gateway middleware does at
  `correlation-id.middleware.ts:7`. So `@Headers('x-correlation-id')` in
  `runs.controller.ts:19` still binds `undefined` while a perfectly good id sits on the
  same request.

## Why it matters

This is the PRD that turns the architecture from a design into a system. Every claim the
repository makes about memory — three tiers, hybrid retrieval, idempotent replay-safe
writes, child spans under the retrieve node — is currently a claim about
`packages/memory-core` in isolation, and `docs/STATUS.md` says so in eight rows. A reader
who greps for the thing the README calls "the architectural differentiator" finds an
adapter with an integration test and no caller.

It is also the dependency root for the rest of the backlog. P1-A's fourth acceptance
criterion is a grader asserting that `reflect` wrote an episodic row and MERGEd an entity,
which is asserting against a stub until this lands. P2-B's ablation has nothing to ablate
while retrieval returns literals. P3-B's audit reconstruction is built on checkpointer
state history. P4-C's compensation logic assumes writes it can compensate.

ADR 0001 chose LangGraph's checkpointer over a durable execution engine and recorded two
obligations that follow: every side-effecting write must be idempotent under replay, and
irreversible external effects need an approval gate rather than a retry. The first is this
PRD. The second is P4-C.

## Scope

- **A composition root.** A `MemoryModule` in `apps/agent-service` that constructs the pg
  pool, the Neo4j driver, the four adapters and the retrieval facade from environment
  configuration, holds them as singletons, and closes them on shutdown.
- **Schema ownership.** Drizzle migrations for `episodes` and `semantic_facts`, run before
  the app listens; a Neo4j constraint bootstrap; the HNSW index; the episodic natural key.
  The four hand-rolled DDL sites collapse onto the migration.
- **One embedding dimension.** `EMBEDDING_DIMENSIONS` exported from `packages/memory-core`
  and referenced by every schema, every DDL, the seed script and the stubs, plus a
  replacement for `text-embedding-004`.
- **Checkpointing.** `@langchain/langgraph-checkpoint-postgres`, with `runId` minted before
  the invoke and used as `thread_id`.
- **Retry.** A `retryPolicy` on the I/O nodes, and a graph shape in which retrying a node
  replays identical writes rather than re-deciding what to write.
- **Fusion that fuses.** `:Fact` nodes in Neo4j keyed by content hash, so both retrievers
  return candidates from one universe and RRF sums scores.
- **Session-scoped retrieval**, with an explicit opt-out, and `topK`/`hopDepth` reaching
  the facade from the request.
- **The assistant turn in `messages`**, so episodic memory records a conversation.
- **The two request-path defects** above.
- **The documentation the change moves**: `docs/STATUS.md` rows 1, 2, 3, 4, 6, 13, 15 and
  16; the memory sections of `README.md` and `.context/architecture.md`; the episodic
  guidance in `.agents/memory-author.md:39-42`, which tells an author that episodic writes
  need no upsert and that `reflect` should check for existing rows — neither of which
  survives this PRD.

### Non-goals

- Measuring whether hybrid retrieval beats either single store. This PRD makes fusion
  real; **P2-B** measures it and decides whether ADR 0002 survives.
- OpenTelemetry GenAI semantic conventions and evaluation events. The child spans here keep
  their current `memory.*` names; renaming them to `gen_ai.*` is **P2-C**.
- Any evaluation of the wired system. **P1-A** owns the harness, and its outcome graders
  are the first thing that can assert these writes actually happened.
- `interrupt()`, human-in-the-loop pauses, and an API surface over checkpoint history.
  This PRD installs the checkpointer; **P3-B** builds audit reconstruction on it.
- Approval gates for irreversible tool effects — ADR 0001's second obligation, and
  **P4-C**'s.
- Upgrading to LangGraph 1.x. **P5-C**. See the dependency note below.

## Design

### Two axes, not one

`RunsService.getDeps` currently switches the whole dependency set on `GOOGLE_API_KEY`
(`runs.service.ts:23`). Model availability and database availability are independent, and
conflating them means a developer with Postgres but no API key gets stub memory. They
split:

| Axis   | Selector                     | Present                            | Absent                |
| ------ | ---------------------------- | ---------------------------------- | --------------------- |
| Model  | `GOOGLE_API_KEY`             | Gemini chat + embeddings           | Deterministic stubs   |
| Memory | `DATABASE_URL` + `NEO4J_URI` | Real adapters, checkpointer, retry | Stub memory, no saver |

The absent-memory branch is load-bearing, not a convenience: P0-A's acceptance criterion
that both README quickstart curls succeed against a clone with no `.env` must survive this
PRD, and `test/runs.e2e-spec.ts` boots the app with no databases. `docker compose --profile full`
sets both variables (`docker-compose.yml:42-43`), so the compose stack and `e2e.yml` move
onto the real path, which is where the wiring gets exercised.

Adapters are provided by explicit token — `@Inject(EPISODIC_REPOSITORY)` — because they are
interfaces with no runtime value to infer, and because `.context/conventions.md:85-89`
records that `yarn dev` runs through tsx, esbuild does not implement
`emitDecoratorMetadata`, and an implicit constructor parameter is injected as `undefined`
on the dev path only.

### Schema

Two mechanisms, because there are two stores and the checkpointer owns a third schema:

- **Postgres application tables** — `packages/memory-core/migrations/`, generated by
  `drizzle-kit` from `episodic/schema.ts` plus a hand-written `semantic_facts` migration
  (Drizzle has no first-class `vector` column type here), applied by
  `drizzle-orm/node-postgres/migrator` in `main.ts` before `app.listen`. This deletes
  `PgPgvectorWriter.ensureTable`, the two test DDL blocks, and
  `scripts/seed-eval-fixtures.mjs:36-45`.
- **Postgres checkpointer tables** — `PostgresSaver.setup()` owns `checkpoints`,
  `checkpoint_blobs` and `checkpoint_writes`. Not ours; called once at boot.
- **Neo4j** — `ensureSemanticConstraints(driver)` in `packages/memory-core`, run at boot:
  ```cypher
  CREATE CONSTRAINT concept_id IF NOT EXISTS FOR (c:Concept) REQUIRE c.id IS UNIQUE
  CREATE CONSTRAINT fact_hash  IF NOT EXISTS FOR (f:Fact)    REQUIRE f.contentHash IS UNIQUE
  ```
  `MERGE` without a uniqueness constraint is not safe under concurrency — two concurrent
  transactions can each create the node.

The episodic natural key is `(session_id, turn_index)`, and the write becomes
`ON CONFLICT (session_id, turn_index) DO NOTHING`. `run_id` stays as a column, recording
which run first persisted the turn, but it is not part of the key.

`(run_id, turn_index)` was the first answer, on the premise that a turn belongs to exactly
one run. That premise is false in this codebase. `reflect.node.ts:44-54` writes _every_
message in `state.messages`, which is the client-supplied conversation history, so run 2 of
a session re-writes turn 0 under a fresh `run_id`. Keyed on `run_id`, `findBySession`
(`episodic.repo.ts:50-59`, which filters on `session_id` alone) returns turn 0 N times
after N runs. Episodic memory is specified as "full turn history"
(`.context/architecture.md:61`); returning the same turn once per run is not that.

Keying on `session_id` also satisfies replay-identity strictly more strongly than keying on
`run_id` did: the same turn lands on the same row within a run, across a resumed run, and
across a re-send. Nothing in the app calls `findBySession` today, so this breaks nothing
now — it is cheaper to get right before a caller exists than after.

**Accepted consequence:** with `DO NOTHING`, first write wins. A client that edits turn 0
and re-sends the history gets its edit dropped rather than persisted. For an append-only
episodic log that is the defensible behaviour — the log records what was first seen — but
it means `episodes` is not a mirror of the client's current history. **P3-B owns
revisiting this**, because an audit trail is the first consumer that cares about the
difference.

### Embedding dimension, and why it is the same decision as the HNSW index

`docs/STATUS.md` rows 6 and 16 read as independent. They are not. Measured against
`pgvector/pgvector:pg16`, which ships pgvector 0.8.2:

```
CREATE TABLE t (e vector(3072));
CREATE INDEX ON t USING hnsw (e vector_cosine_ops);
ERROR:  column cannot have more than 2000 dimensions for hnsw index
```

`vector(768)` indexes. `halfvec(3072)` indexes, with `halfvec_cosine_ops`. So the
replacement model's output dimension decides whether row 6 is a one-line migration or a
column type change.

`@langchain/google-genai@0.2.18` cannot help: `GoogleGenerativeAIEmbeddingsParams`
(`node_modules/@langchain/google-genai/dist/embeddings.d.ts`) exposes `model`, `taskType`,
`title`, `stripNewLines`, `apiKey` and `baseUrl`, and no output-dimension field. The
version that does is `@langchain/google-genai@2.3.0`, whose peer dependency is
`@langchain/core ^1.2.9` — the P5-C upgrade.

The approach, therefore: keep the LangChain adapter for chat, and call
`models/gemini-embedding-001:embedContent` directly for embeddings with
`outputDimensionality` set to `EMBEDDING_DIMENSIONS` and the returned vector L2-normalized,
since Matryoshka-truncated outputs are not unit-norm. `EMBEDDING_DIMENSIONS` stays 768, so
every existing literal remains correct once it stops being a literal, and HNSW on
`vector(768)` works today.

```ts
// packages/memory-core/src/semantic/embedding.ts
export const EMBEDDING_DIMENSIONS = 768;
```

The fallback, if `outputDimensionality` is not accepted: `EMBEDDING_DIMENSIONS` becomes
3072 and the column becomes `halfvec(3072)`. That is one constant and one migration —
which is the entire point of introducing the constant, and the reason it lands before the
model does.

### Checkpointer and thread identity

`@langchain/langgraph-checkpoint-postgres@^0.1.3`, **not** `^1.0.5`. The 1.x line
peer-depends on `@langchain/core ^1.1.44`; this repo is on `@langchain/core@0.3.80` and
`@langchain/langgraph-checkpoint@0.1.3`, and `0.1.3` of the saver declares
`@langchain/core >=0.2.31 <0.4.0` and `@langchain/langgraph-checkpoint ^0.1.2`. P5-C bumps
both together.

`thread_id` is the `runId`, not the `sessionId`. A run is the unit that gets resumed,
replayed and audited; session continuity is Episodic memory's job, and putting every run of
a session on one thread would make each run resume into the previous run's channel values.
This requires the `runId` to exist before the invoke, so it moves out of
`ingress.node.ts:17` and into the service:

```ts
const runId = randomUUID();
const compiled = buildAgentGraph(deps, body, correlationId);
const result = await compiled.invoke({ runId }, { configurable: { thread_id: runId } });
```

`ingressNode` takes `state.runId` instead of minting one.

The correlation-id defect is **not** fixed here. Defaulting it at this call site with
`correlationId || randomUUID()` would mint a _second_ id, disagreeing with the one already
in the response header, the log line and the `AsyncLocalStorage` context — one request,
two ids, which is worse than the 500. The fix is one line in `LoggingInterceptor`,
mirroring `apps/gateway/src/middleware/correlation-id.middleware.ts:7`:

```ts
// logging.interceptor.ts, beside the existing res.setHeader and req.correlationId writes
req.headers['x-correlation-id'] = correlationId;
```

The interceptor stays the single place an id is minted, and every consumer — header,
logger, ALS, `@Headers()` — sees the same value.

### Splitting the LLM call out of the write

A `retryPolicy` on `reflect` as it stands would re-run `extractEntities`
(`reflect.node.ts:59`) on every attempt: a second model call, and an entity set that may
differ from the one whose writes half-succeeded. Retrying a node is only replay-safe when
the node is a function of its input state, and `reflect` is not.

Split the extraction out, keeping the write node named `reflect` so that the invariant in
`CLAUDE.md` — reflect is the only place that promotes data to Episodic or Semantic memory —
stays true as written:

```
START → ingress → retrieve → plan → act ⟲ → distill → reflect → egress → END
```

- **`distill`** — one LLM call, no I/O, returns `extraction` into state.
- **`reflect`** — episodic insert, Neo4j MERGE, pgvector upsert. Reads `state.extraction`.
  Pure I/O over idempotent operations, so attempt _n_ writes exactly what attempt 1 wrote.

The checkpoint between them means a crash after extraction resumes at `reflect` without
paying for the model call again.

Two mechanical requirements, both of which have bitten this repo before:

- `extraction` is added to `AgentStateAnnotation` (`graph.ts:18-31`) as well as to
  `AgentStateSchema`. A key absent from the annotation is dropped between nodes, and the
  failure mode is a `reflect` that silently writes nothing.
- `distill` must not collide with a channel name. It does not today; `extraction` is the
  channel and `distill` is the node, which is the separation P0-A's rename established and
  `graph/graph.test.ts` guards.

The conditional edge at `graph.ts:57-60` retargets `reflect` → `distill`.

### Retry policy

```ts
const IO_RETRY: RetryPolicy = {
  maxAttempts: 3,
  initialInterval: 200,
  backoffFactor: 2,
  jitter: true,
  retryOn: (e) => !(e instanceof z.ZodError) && !isClientError(e),
};
```

Applied to `retrieve`, `plan`, `act` and `reflect`; not to `ingress` or `egress`, which do
no I/O. `retryOn` excludes validation failures and 4xx model errors — retrying a malformed
request three times spends latency to reach the same answer. `retryPolicy` is available on
`addNode` at the pinned `@langchain/langgraph@0.4.10`
(`node_modules/@langchain/langgraph/dist/graph/state.d.ts:22`), so this needs no upgrade.

**This collides with a written convention, and the convention is the thing that has to
move.** `.context/conventions.md:90-93` says "Containing failure inside the node is the
intent," names `retrieve` and `reflect` propagating I/O errors as the gap, and tells the
next reader not to widen it. A `retryPolicy` only ever fires on a thrown error: a node that
catches its own I/O failure and returns `Partial<AgentState>` makes `retryOn` unreachable
and the policy a decoration. Left as is, the next session closes the "gap" in good faith
and silently deletes retry.

The convention is right about the outcome and wrong about the mechanism. This PRD amends it
to draw the line where it belongs: **I/O nodes throw so the policy can see the failure;
containment happens once, at the graph boundary**, where an exhausted retry becomes a run
with a failed `outcome`, a terminal SSE frame, and a checkpoint left intact for resume —
never an unhandled rejection. Contained is not the same as swallowed, and the current
wording does not distinguish them.

### The stream error frame

`StreamEventSchema` (`run-response.schema.ts:19-31`) is `{ node, delta?, state? }` — no
error channel — so "a terminal SSE frame identifying the failure" is a contract change, not
an implementation detail. `StreamEvent` gains an optional `error`:

```ts
error: z.object({ node: z.string(), message: z.string() }).optional(),
```

Overloading `node` with a sentinel value was the alternative and is rejected: an implicit
protocol carried in a `z.string()` is exactly the kind of thing a reader has to run the
code to discover.

The reason this needs saying out loud is `docs/STATUS.md` row 14, which already records
`delta` and `state` as declared in the schema and emitted zero times. Adding a third
never-emitted optional field would make that row worse. So the acceptance criterion below
requires an **observed** frame, not a declared field, and row 14 shrinks rather than grows.

### What "atomic" becomes

`docs/STATUS.md` row 4 asks for semantic writes that are atomic across the two indices.
ADR 0001 already decided against the mechanism that would provide it: "Checkpointing is not
durable execution... It does not give exactly-once side effects." The guarantee this PRD
delivers instead is **convergence under replay** — every write in `reflect` is idempotent,
`reflect` is a function of `state.extraction`, and the retry policy re-runs it until it
completes or the run fails with the checkpoint intact for a later resume. A crash between
the Neo4j write and the pgvector write leaves the indices disagreeing until the retry, not
permanently.

Row 4's capability text changes to say that, rather than being ticked. If the window
between writes turns out to matter, the fix is an outbox and it is a new PRD, not a silent
reinterpretation of this one.

### Making RRF fuse

`reflect` gains a `:Fact` write alongside the existing `:Concept` writes:

```cypher
MERGE (f:Fact {contentHash: $contentHash})
  ON CREATE SET f.text = $text, f.episodeId = $episodeId
WITH f UNWIND $entityIds AS eid
MATCH (c:Concept {id: eid}) MERGE (f)-[:MENTIONS]->(c)
```

`expandFromSeeds` returns `:Fact` nodes reachable from the seed concepts within `hopDepth`,
carrying `contentHash`. `PgvectorReader.searchByCosine` already selects `content_hash`
(`pgvector.reader.ts:22`) and starts returning it. `RetrievalCandidate` gains
`contentHash`, and `rrfMerge` keys on it. Both lists now describe facts, so a fact found by
both paths has its two reciprocal ranks summed — which is what the README claims and what
`rrfMerge`'s own unit test already assumes.

`RetrievedContextItemSchema` (`packages/shared-types/src/memory.schema.ts:9-15`) duplicates
`RetrievalCandidateSchema` field for field. `contentHash` is added to both; consolidating
them is not this PRD's.

This also makes `:Fact` true at `README.md:169` and `.context/architecture.md:67`. `:Session`
is not written by this PRD and comes out of both files.

### Scoping and configuration

`searchByCosine` takes the `sessionId` already carried by `RetrievalQuerySchema` and adds
`WHERE session_id = $3`. The default is session isolation, because the alternative default
leaks one session's facts into another's context. `RetrievalQuery` gains
`crossSession: boolean` (default `false`) for the case where long-term semantic recall is
the point — P2-B's ablation will want it, and a session-scoped store cannot demonstrate
long-term memory.

`RunRequestConfig.topK` and `.hopDepth` reach the facade: `ingress` carries them into state
beside `maxSteps`, and `retrieve.node.ts:47-48` reads them instead of its literals.

### Layout

```
packages/memory-core/
  migrations/
    0000_episodes.sql            generated from episodic/schema.ts
    0001_semantic_facts.sql      vector column, HNSW index
  src/
    migrate.ts                   runMigrations(pool)
    semantic/
      embedding.ts               EMBEDDING_DIMENSIONS
      neo4j/neo4j.constraints.ts ensureSemanticConstraints(driver)

apps/agent-service/src/
  memory/
    memory.module.ts             pool, driver, adapters, facade, checkpointer
    memory.tokens.ts             injection tokens
    memory.config.ts             env → config, Zod-validated
  agent/nodes/distill.node.ts    LLM extraction, no I/O
```

## Acceptance criteria

- [x] With `DATABASE_URL` and `NEO4J_URI` set, `POST /runs` writes: after one run, an
      `episodes` row exists for every turn in `state.messages`, at least one `:Concept`
      exists in Neo4j, and at least one `semantic_facts` row exists. Verified on **both**
      model axes. It held on the stub axis at first ship and failed on the live one; see
      "Post-ship correction".
- [x] With both variables unset, `POST /runs` and `POST /runs/stream` behave exactly as they
      do at HEAD, and `yarn turbo test:service` passes with no database available.
- [x] With `DATABASE_URL` or `NEO4J_URI` set but the store unreachable, the service fails
      loudly — a failed migration or driver connect stops boot, and a store that dies after
      boot fails the run rather than falling back to the stub set. Selecting no-op writers
      because a configured database is missing is the defect this PRD removes; it must not
      return as a runtime path.
- [x] `yarn turbo test:integration` and `packages/memory-core/test/` create no tables of
      their own; the migration is the only DDL for `episodes` and `semantic_facts`, and
      `scripts/seed-eval-fixtures.mjs` runs it rather than issuing its own `CREATE TABLE`.
- [x] Running the same `runId` through `reflect` twice produces one `episodes` row per
      turn, one `:Concept` per entity, and one `semantic_facts` row per fact.
- [x] `\d semantic_facts` on a migrated database shows an HNSW index on `embedding`.
- [x] `SHOW CONSTRAINTS` on a bootstrapped Neo4j lists a uniqueness constraint on
      `:Concept(id)` and on `:Fact(contentHash)`.
- [x] The literal `768` appears in no `.ts` or `.mjs` file outside
      `packages/memory-core/src/semantic/embedding.ts`.
- [x] With `GOOGLE_API_KEY` set, `POST /runs` returns 200 and a `RunResponse`, and the
      embedding it stores has `EMBEDDING_DIMENSIONS` components. Verified 2026-08-29 against
      live Postgres, Neo4j and Gemini: 18 `semantic_facts` rows at `vector_dims` 768 and L2
      norm exactly `1.000000`. See "Post-ship correction" for why the first attempt at this
      criterion reported a leaked key.
- [x] `graph.compile()` is called with a checkpointer when a database is configured, and
      `SELECT count(*) FROM checkpoints WHERE thread_id = <runId>` is non-zero after a run.
- [x] Killing the process between `distill` and `reflect` and re-invoking with the same
      `thread_id` completes the run with one model call in `distill`, not two.
- [x] Every node that performs I/O is registered with a `retryPolicy`; a `retrieve` whose
      Neo4j driver fails twice and succeeds on the third attempt yields a successful run.
- [x] _(Landed here rather than in P2-D, so P2-D is removed from the index.)_ A fact reachable from
      a seed concept in Neo4j and returned by pgvector for the same query appears once in
      `retrievedContext`, with a score equal to the sum of its two reciprocal ranks.
- [x] A run in session A does not retrieve a `semantic_facts` row written in session B,
      unless `crossSession` is set.
- [x] A request with `config: { topK: 3, hopDepth: 1 }` produces a
      `memory.pgvector.search` span with `topK` reflecting 3 and a `memory.neo4j.expand`
      span with `hopDepth` 1.
- [x] A trace of one `POST /runs` shows `memory.pgvector.search` and `memory.neo4j.expand`
      as children of `agent.node.retrieve`, and `memory.neo4j.mergeEntity` and
      `memory.pgvector.upsert` as children of `agent.node.reflect`.
- [x] `RunResponse.messages` contains the assistant turn, and `reflect` writes it to
      `episodes`.
- [x] `POST /runs` with no `x-correlation-id` header returns 200, and the response's
      `x-correlation-id` header is a generated UUID that also appears in the run's log
      lines. (`RunResponse` has no correlation-id field and does not gain one — the header
      is the transport, and widening the response contract is not in this PRD's scope.)
- [x] A node failure during `POST /runs/stream` emits a terminal SSE frame carrying
      `error: { node, message }` and closes the stream; the log contains no
      `ERR_HTTP_HEADERS_SENT`. The frame is asserted from an observed response, not from
      the schema, and `docs/STATUS.md` row 14 is updated to record `error` as emitted.
- [ ] `docs/STATUS.md` rows 1, 2, 3, 6, 13 and 16 are `implemented` with evidence that
      resolves, and row 4's capability text states convergence under replay rather than
      atomicity. Row 15 moves to `implemented` here, or to P2-D's ownership if the fusion
      work is split. **Met except for row 16**, which stays `broken` for the reason above —
      the same credential, not a second defect. Rows 1, 2, 3, 6, 13 and 15 are
      `implemented`; row 4 is restated as convergence under replay; row 11 is restated too,
      because "nodes never throw" and a retry policy cannot both hold. **P1-E** owns
      closing row 16.
- [x] `.agents/memory-author.md`'s episodic guidance describes the natural key, and
      `:Session` is gone from `README.md` and `.context/architecture.md`.
- [x] `.context/conventions.md:90-93` distinguishes throwing from swallowing, so that a
      later reader "fixing" `retrieve` or `reflect` to contain their own I/O errors cannot
      turn the retry policy into a no-op without contradicting the written convention.
- [x] `.env` is read by the service, and a variable the ambient environment overrides is
      named in a boot warning rather than silently ignored.
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Post-ship correction

This PRD was marked `shipped` with twenty-one of twenty-three criteria met, and reopened
the same day. Two of the ticks were wrong, for one shared reason: **acceptance was verified
on the stub model axis, and the live model axis was never exercised.**

The proximate cause was environmental. A shell profile on the author's machine exported a
revoked `GOOGLE_API_KEY`, and nothing on the Node path read `.env` — `yarn dev` is bare
`tsx src/main.ts` — so the fresh key in the file was never used and every live call returned
`403 PERMISSION_DENIED`. Criterion 9 was recorded as blocked on a credential and handed to
P1-E. It was not: the key was fine, and the service was reading a different one.

With a working key the live axis exposed a second defect that the stub axis structurally
could not. `distill` parsed the model response with
`try { JSON.parse(...) } catch { return EMPTY_EXTRACTION }`, and `gemini-2.5-flash` wraps
JSON in a ` ```json ` fence unless `responseMimeType: application/json` is set. So every
live extraction threw, every catch returned an empty set, and `reflect` wrote none of it —
no `:Concept`, no `:Fact`, no `semantic_facts` row — while the run reported
`outcome: "success"`. Criterion 1 held on the stub axis, whose canned extraction always
parses, and failed on every live run.

That is the same defect this PRD exists to remove, in a place it did not look: a silent
fallback that makes a broken path report success. The added criterion about a
configured-but-unreachable store closed one instance of it in the memory axis; this one was
in the model axis, where nothing was watching.

**The lesson for the next PRD is about acceptance, not about JSON.** A criterion verified on
a stub is verified against the half of the system that cannot fail. Where a PRD names two
independent axes — as this one's own Design section does — the criteria have to say which
axis they were checked on, and a criterion that can only be checked on one of them is not
met.

## Risks and open questions

- **`L` is the floor, not the estimate.** Every deliverable here is code that has never
  executed against a database from the application path. P0-A was sized `S` on two known
  defects and took nine commits, because six more were only visible once the one in front
  was cleared. The same shape applies with more surface: the first `docker compose --profile full up`
  that runs migrations, a checkpointer, and two live stores in one boot sequence will find
  things this document does not list.
- **The embedding replacement is now verified against the live service.** Measured
  2026-08-29 against `models/gemini-embedding-001:embedContent`:

  | `outputDimensionality` | HTTP | returned length | L2 norm    |
  | ---------------------- | ---- | --------------- | ---------- |
  | `768`                  | 200  | 768             | `0.583182` |
  | `3072` (native)        | 200  | 3072            | `1.000000` |

  So `EMBEDDING_DIMENSIONS = 768`, the column is `vector(768)`, HNSW indexes it, and the
  `halfvec(3072)` fallback is not needed. The measurement also settles a detail that was
  inference: a Matryoshka-truncated vector comes back at norm 0.58, not 1.0, while the
  native 3072 output is exactly unit-norm. **L2-normalizing after truncation is required,
  not defensive.** `vector_cosine_ops` would tolerate the un-normalized vector, but the
  stored representation should be canonical, and a later switch to inner-product ops
  silently returns wrong distances if it is not.

  The paragraph below is retained for the record of what was assumed before the check.

- **What this claim looked like before it was measured.**
  `text-embedding-004` being retired is verified (P0-A observed the 500). That
  `gemini-embedding-001` accepts `outputDimensionality` and returns a truncatable
  Matryoshka embedding is from its documentation, not from a call — this repository has no
  API key. If it were wrong, the `halfvec(3072)` fallback above would apply and the HNSW
  criterion would still hold. The check was cheap and the migration it decides is not, which
  is why it ran before implementation rather than during it.
- **Splitting `distill` out of `reflect` is decided — and the draft undersold why.** It
  adds a node to public vocabulary — SSE `StreamEvent.node`, the `agent.node.*` span name,
  the console's colour map, the topology diagrams in `README.md` and
  `.context/architecture.md`. The draft argued the cheaper alternative merely "costs a model
  call," since every write is idempotent. That is idempotency **per write**, which is not
  convergence **per node**. `reflect` derives its pgvector key from the extracted text
  (`reflect.node.ts:81`: `sha256(fact.text)`). If attempt 2 extracts a fact worded even
  slightly differently, its hash differs, the upsert has nothing to collapse onto, and the
  row lands _in addition to_ attempt 1's. Same for a `:Concept` id the model renders
  differently on the second pass. Retry on the current `reflect` is not convergent, so a
  `retryPolicy` on it does not deliver the guarantee "What atomic becomes" claims. That is
  a correctness argument, not an aesthetic one, and it is why the split is in scope rather
  than deferred.

  One mechanical note for the implementer: `shouldContinueActing` (`edges.ts:3`) returns
  `'act' | 'reflect'`. Change the return type and the literal to `'act' | 'distill'` and add
  a plain `distill → reflect` edge. Keeping the conditional-edge key as `reflect` while
  mapping it to the `distill` node would work and would be the next reader's trap.

- **Making RRF fuse is the largest single item and the most separable.** `:Fact` nodes, a
  new relationship, a changed reader query, a changed candidate shape in two packages, and
  the fixture and seed script that follow. If this PRD needs to be cut, that is the piece
  to lift out. **P2-D is reserved for it** — a row exists in the index so the split can
  happen mid-flight without inventing an id, and if the work lands here instead, P2-D is
  deleted from the index rather than left as a ghost. Everything else here is wiring; this is a schema change to the knowledge graph.
- **Session-scoped retrieval narrows recall by design.** A default of session isolation
  means semantic memory stops being long-term across sessions unless a caller opts in,
  which is in tension with the tier's stated purpose. The real boundary is a tenant, and
  this repository has no tenant concept. `crossSession` is the honest interim: it makes the
  choice explicit at the call site rather than implicit in a missing `WHERE` clause.
- **The compose stack moves onto the real path.** Once `DATABASE_URL` and `NEO4J_URI`
  select real adapters, `docker compose --profile full` and `e2e.yml` start exercising
  migrations, the checkpointer and both stores. That is the point, and it also means a
  migration failure becomes a failed healthcheck and a red E2E job. Boot ordering —
  migrate, then `setup()`, then listen — has to be right the first time or the container
  never reports healthy.
- **This PRD does not depend on P5-C, and the sequencing graph in `docs/prd/README.md` says
  it does.** Verified at the pinned versions: `retryPolicy` exists on `addNode`
  (`@langchain/langgraph@0.4.10`), `compile()` accepts a `checkpointer`, and
  `@langchain/langgraph-checkpoint-postgres@0.1.3` is peer-compatible with
  `@langchain/core@0.3.80`. The spine is corrected in the same change as this file. P5-C
  becomes cheaper after this PRD rather than a prerequisite for it, because the checkpointer
  and the embeddings adapter get upgraded together.

## References

- ADR 0001, `docs/adr/0001-langgraph-over-a-durable-execution-engine.md` — the checkpointer
  choice, and the two obligations it creates.
- ADR 0002, `docs/adr/0002-neo4j-and-pgvector-rather-than-one-store.md` — RRF with `k = 60`,
  and the note that the premise is unmeasured until P2-B.
- pgvector index dimension limits: https://github.com/pgvector/pgvector#indexing
- Reciprocal Rank Fusion, Cormack et al. 2009:
  https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf
- Matryoshka Representation Learning, Kusupati et al. 2022:
  https://arxiv.org/abs/2205.13147
- LangGraph persistence and thread semantics:
  https://langchain-ai.github.io/langgraphjs/concepts/persistence/
