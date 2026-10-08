# Architecture

## What This Repo Is

`agent-native-monorepo` is an extraction of production patterns from a proprietary agentic
platform, sanitized for public consumption. It is **not** a tutorial, starter kit, or SaaS
template. It exists to demonstrate architectural thinking in two scarce domains simultaneously:

1. **Senior monorepo engineering** — Yarn 4 workspaces, Turborepo build orchestration,
   shared TypeScript configs, Zod schemas as the source of truth for cross-package types.
2. **Production agentic systems** — LangGraph state machines with non-trivial memory
   architecture and OpenTelemetry instrumentation.

> **This document describes the design. `docs/STATUS.md` records what is wired.** They
> agree on the memory tiers since P2-A: `MemoryModule` constructs the pool, the driver, the
> four adapters, the facade and the checkpointer, and `RunsService` injects them. Read the
> matrix before you rely on a sentence here anyway — it carries the per-capability status
> and this document does not.

## System Overview

```
┌─────────────┐     ┌─────────────┐     ┌──────────────────────────────┐
│   console    │────▶│   gateway    │────▶│      agent-service           │
│  (React/Vite)│     │  (Express)   │     │   (NestJS 11 + LangGraph)   │
└─────────────┘     └─────────────┘     └──────────┬───────────────────┘
                                                    │
                                          ┌─────────┴─────────┐
                                          │    memory-core     │
                                          │  (unified facade)  │
                                          └───┬───────┬───────┘
                                              │       │
                                   ┌──────────┘       └──────────┐
                                   ▼                              ▼
                          ┌────────────────┐           ┌─────────────────┐
                          │ Postgres 16    │           │   Neo4j 5       │
                          │ + pgvector     │           │   Community     │
                          │ (Episodic +    │           │ (Knowledge      │
                          │  Dense Search) │           │  Graph)         │
                          └────────────────┘           └─────────────────┘
```

## The Three-Brain Memory Model

The memory system is divided into three tiers with distinct scopes, persistence strategies,
and access patterns. All three tiers are exposed through `packages/memory-core`, and all
three are reached by a live request: one `POST /runs` leaves rows in `episodes` and
`semantic_facts` and `:Concept` and `:Fact` nodes in the graph. See `docs/STATUS.md`
rows 1-4.

### Working Memory (Per-Run)

- **Scope:** In-process, ephemeral — destroyed at run completion.
- **Implementation:** LangGraph `AgentState` object. No external I/O.
- **Purpose:** Accumulates intermediate reasoning, tool outputs, and retrieved context
  within a single agent invocation.

### Episodic Memory (Session-Scoped)

- **Scope:** Persisted across runs, scoped to a `session_id`.
- **Implementation:** Postgres table via Drizzle ORM.
- **Retention:** Unbounded. There is no expiry column and no cleanup job; a TTL is planned
  and unowned (`docs/STATUS.md` row 5).
- **Purpose:** Full turn history — both sides of it. `plan` appends the assistant's turn to
  `state.messages` before `reflect` persists them.
- **Natural key:** `(session_id, turn_index)`, written `ON CONFLICT DO NOTHING`. `reflect`
  writes the whole client-supplied history on every run, so keying on `run_id` would return
  each turn once per run. `run_id` stays as a column recording which run first persisted the
  turn. First write wins: an edited and re-sent turn is dropped, not updated.

### Semantic Memory (Long-Term)

Two indices, both written by the `reflect` node. **Only pgvector is read on a request.**
Retrieval is vector-only by decision, after a negative measurement: P2-B's ablation found
that fusing the graph's list with the vector list added nothing on the deployed path and
lowered Recall@10 by 0.145 with perfect seeds, and ADR 0009 took the graph out of the read
path.

- **pgvector Collection:** Dense embeddings, searched by exact cosine distance with the
  content hash as a tiebreaker. This is retrieval: `VectorRetrievalFacade` returns this
  search, in the reader's order, to `plan`. Scoped to the requesting session unless the
  query opts out. The column carries an HNSW index (`vector_cosine_ops`) that the tiebroken
  query cannot use — ADR 0006 records that trade.
- **Neo4j Knowledge Graph:** Typed nodes (`:Concept`, `:Fact`) joined by `:MENTIONS`, plus
  `:RELATES_TO` between concepts. Written on every run and read by no request. It is kept
  for an explanation role — which concepts a retrieved fact mentions, and how they connect
  to the question's — so `docs/STATUS.md` row 15 is `stubbed`. P2-D measures that role.
  Stage 1 is `good` and stage 2 decides whether the graph stays or goes (ADR 0012, proposed).
  Every graph write carries its session (P2-D's M1). A `:Fact` keeps its first writer's
  `sessionId`, as pgvector does. `MENTIONS` and `RELATES_TO` carry the session in their
  merge key. Concepts stay global. Both graph reads take a required session scope, with no
  cross-session form. `CypherNeo4jReader` serves the ablation, and `CypherNeo4jExplainer`
  serves the explanation measurement. Both are unwired. Uniqueness constraints on
  `:Concept(id)` and `:Fact(contentHash)`, and range indexes on `:Fact(sessionId)` and
  `RELATES_TO(sessionId)`, are installed at boot — `MERGE` is not an upsert without the
  constraints.

The dimension is one exported constant, `EMBEDDING_DIMENSIONS`, and every schema, DDL,
fixture and stub derives from it. It is 768 because pgvector refuses an HNSW index above
2000 dimensions, so `gemini-embedding-001` is asked for a truncated output and the result
is L2-normalized — a Matryoshka vector below its native width is not unit-norm.

The two writes are sequential, not atomic: `reflect` loops over Postgres, then Neo4j, then
pgvector. Each write is individually replay-safe and `reflect` is a function of
`state.extraction`, so a retried attempt writes exactly what the first attempt wrote. The
set of them is still not one transaction — the guarantee is convergence under replay, not
exactly-once. ADR 0001 explains why.

**Why there were two.** ADR 0002 ran both on the theory that dense search and graph
traversal fail on different questions, so their union, merged by Reciprocal Rank Fusion,
recalls more than either. ADR 0004 made that fusion real by giving both readers one universe
of facts keyed on the content hash. P2-B measured the premise against pre-registered labels
and it did not hold, so ADR 0009 superseded 0002. The fusion survives only inside
`yarn eval:retrieval`, which reproduces that measurement; ADR 0004 is moot on the request
path, and `reflect` still writes the `:Fact` copy it introduced.

```
Working Memory ──[reflect]──▶ Episodic (Postgres)
                              │
                              └──[reflect]──▶ Semantic
                                               ├── Neo4j (entities + relationships; not read)
                                               └── pgvector (distilled fact embeddings)
                                                     │
                              retrieve ◀──[cosine]───┘
```

## LangGraph Topology

The agent runs as a compiled `StateGraph` with seven nodes:

```
START → ingress → retrieve → plan → act ⟲ (loop) → distill → reflect → egress → END
```

- **act** self-loops while `stepCount < maxSteps && shouldContinue`. Its results go to
  `toolOutputs`, and no prompt reads that channel: `plan` runs first, and its response is
  already the assistant's answer. `selectTool` sees the plan and the tool names, and not
  the previous call's output. P4-C owns both halves of that.
- **distill** extracts from every message, including the assistant's own turn, so what
  `reflect` promotes to semantic memory is mostly the model's plan restated. P4-B proposes
  changing that.
- **distill** makes the extraction model call and writes `extraction` into state. It exists
  so that **reflect** can be retried: a node is only safe to re-run when it is a function of
  its input state, and a `reflect` that extracted its own entities was not.
- **reflect** is the sole writer to Episodic and Semantic tiers.
- Every node that performs I/O — `retrieve`, `plan`, `act`, `distill`, `reflect` — carries a
  `retryPolicy`. `ingress` and `egress` do not, because they do no I/O.
- The graph is compiled with a `PostgresSaver` when the memory axis is configured. The
  `thread_id` is the `runId`, minted in `RunsService` before the invoke: a run is the unit
  that gets resumed and audited, and putting a session's runs on one thread would make each
  run resume into the previous one's channel values.
- A state machine (not a chain) was chosen for fault tolerance: nodes are the unit a
  checkpointer can resume from, and the write adapters are idempotent (Cypher MERGE,
  pgvector upsert on content hash) so that a resumed node is safe to re-run.
- **Both halves are switched on.** `buildAgentGraph` compiles with the `PostgresSaver` when
  one is configured (`graph/graph.ts:84`) and `IO_RETRY` is attached to the five I/O nodes.
  ADR 0001 records the choice of checkpointer and why it is not the same thing as durable
  execution: resume, not exactly-once.

## The Run Record and Audit Replay

The checkpoints are a run's trace, not its inputs: they hold no request body, no retried
attempt, no commit and no retrieval query (ADR 0007). So every run on the configured memory
axis, on both graphs, also writes a **run record** to Postgres beside them:

- `run_records`: the body as received, the commit (`GIT_SHA` in the image, the working tree
  otherwise), the chat and embedding models, which axis served the model half, when the
  request arrived, and the outcome.
- `run_decisions`: one row per decision, appended as it resolves, at the cassette's seams
  plus `memory.retrieve`. A retried call is two rows, the error and then the value.

The record is written by `RunRecorder`, which wraps the dependency set a graph is about to
receive in a `PersistingDeck` — the cassette's `Deck`, writing rows instead of a file
(`src/agent/model/decision-seam.ts` is where both record). It is not a memory tier:
nothing a graph is given can read it, and it lives in `memory-core` only because it is
written with the same role, under the same migrator.

`audit:replay <runId>` re-executes a run at its recorded commit with every input served
from the record — the model half and retrieval from a `DecisionQueue`, `reflect`'s writers
capturing — and compares every checkpoint with the recorded history. It proves the record
complete and consistent with the checkpoints, and derives what the run wrote; it cannot
prove either was not edited, which is P3-C's ledger. A record that cannot be written fails
the prior-authorization request closed and leaves a chat run complete with a `partial`
record.

```
POST /runs ─▶ RunRecorder.open ─▶ graph ──decision──▶ PersistingDeck ─▶ run_decisions
                                    │                                   (as it resolves)
                                    └──super-step──▶ PostgresSaver ─▶ checkpoints
audit:replay ◀── run_records + run_decisions + checkpoints  (read-only pool)
```

## NestJS 11 Microservice

The LangGraph graph is hosted inside a NestJS 11 microservice (`apps/agent-service`):

- **POST /runs** — Request/response mode. Waits for `egress`, returns `RunResponse`.
- **POST /runs/stream** — Streaming mode. Emits SSE events per node completion.
- **Global concerns:** ZodValidationPipe, AuditInterceptor (structured logging),
  LoggingInterceptor (correlation ID via AsyncLocalStorage), HttpExceptionFilter.
- **Observability:** One trace per run under an `invoke_agent` root, one span per graph
  node beneath it, OTLP HTTP export. Model calls, embeddings and tool executions have
  spans of their own in the OpenTelemetry GenAI vocabulary, with token usage on each model
  call; content capture is off and an attribute allowlist holds it off. The pgvector reader
  carries a child span for its search, and `MemoryModule` constructs it, so a live trace on
  the configured memory axis shows `memory.pgvector.search` under `agent.node.retrieve`.
  The Neo4j reader's `memory.neo4j.expand` span appears in no run, because no request
  constructs that reader since ADR 0009.
