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
prove either was not edited, which is the decision ledger's job, below. A record that cannot be written fails
the prior-authorization request closed and leaves a chat run complete with a `partial`
record.

```
POST /runs ─▶ RunRecorder.open ─▶ graph ──decision──▶ PersistingDeck ─▶ run_decisions
                                    │                                   (as it resolves)
                                    └──super-step──▶ PostgresSaver ─▶ checkpoints
audit:replay ◀── run_records + run_decisions + checkpoints  (read-only pool)
```

## The Decision Ledger

A run record proves what a run did, and not that nobody edited it afterwards. With
`LEDGER_DATABASE_URL` set, `packages/decision-ledger` keeps a hash chain that commits to
each record (P3-C, ADR 0013):

- **Five kinds of entry.** `run.recorded` holds a SHA-256 digest of the `run_records` row,
  its decisions in order and every checkpoint, read back after the run. Every run on either graph
  appends one after its record closes. `disposition.recommended` holds what the
  prior-authorization graph recommended, citing its run's entry. `determination.attested`
  holds a clinician's signed determination, citing that recommendation.
  `reviewer-key.registered` and `reviewer-key.revoked` hold the keys those signatures are
  checked against, registered from `REVIEWER_REGISTRY` at boot.
- **Salted commitments.** Each entry commits to `SHA-256(salt ‖ payload)` with 16 random
  bytes of salt, and `entry_hash` covers the row and the previous entry's hash. The chain
  can leave the database without disclosing anything. A payload can be withheld under a
  retention policy and the entry still verifies.
- **A writer that cannot rewrite.** The service writes as `ledger_writer`, which holds
  `SELECT` and `INSERT` only. A trigger stops the owner, and boot refuses a role that could
  rewrite the ledger. A database administrator in replica mode is stopped by nothing in
  the database, so `ledger:anchor` time-stamps the head with an RFC 3161 authority through
  `openssl`, and the token is the commitment that leaves.
- **Split failure policy.** The chat path fails open: it logs, and the verifier lists the
  run as uncommitted. `$submit` and the determination route fail closed with a 503, because
  they return a recommendation or a determination.
- **Outside the graph.** A lint rule forbids `@repo/decision-ledger` under `src/agent/`.
  The agent can neither write the ledger nor read it.

`ledger:verify` checks the chain, the commitments, the signatures, the anchors and each
digest against today's record and checkpoints. It exits 1 naming the first failure by seq
and run. `--chain-only` needs only the package, over the database or a JSONL export.

```
run settles ─▶ RunLedger.commitRun ─▶ digest(run_records, run_decisions, checkpoints)
                                       └─▶ Ledger.append ─▶ ledger_entries + ledger_payloads
$submit ─▶ run.recorded ─▶ disposition.recommended ─▶ prior_auth_cases.recommendation_seq
decide ──beforeCommit──▶ determination.attested (signature re-checked) ─▶ case decided
ledger:anchor ─▶ head entry_hash ─▶ RFC 3161 TSA ─▶ ledger_anchors
```

## The Prior-Authorization Case Layer

A prior authorization outlives the agent's run on it: it pends, waits days for a clinician
and may be appealed. ADR 0010 puts that above the graph, as ADR 0001 anticipated, rather
than pausing a thread with `interrupt()`.

- **The graph finishes.** The prior-authorization graph ends at `dispose`, inside the
  `$submit` exchange. Its checkpoints under `thread_id = caseId` record what the agent read
  and found.
- **The case is a row.** `prior_auth_cases`, in `packages/memory-core/src/cases/`, holds the
  request, the disposition, the clock, the response in force and, once decided, the
  determination and who signed it. Postgres on the configured memory axis; on the
  unconfigured one, an in-process store that boot announces at `warn` as
  `review.cases.volatile`.
- **The queue is ordered by the clock alone**, deadline then receipt then case id, through
  `compareCases`, whose only input holds no field a finding could reach.
- **A clinician decides; the service verifies.** A determination carries an Ed25519
  signature over P3-C's attestation payload, checked against the public keys in
  `REVIEWER_REGISTRY`. The service holds no private key. The case is decided once, under a
  row lock, and with a ledger configured the signed determination is appended to it before
  the row commits.
- **The run record closes before the case is written.** Both fail `$submit` closed with a 503. A failed record leaves no case, and a failed enqueue leaves a closed record with no
  case beside it, so the queue never holds a request whose answer was not sent.
- **The sweep flags and never decides.** A case past its deadline gets
  `overdue_flagged_at` and a `review.case.overdue` span event, and stays pended.

## NestJS 11 Microservice

The LangGraph graph is hosted inside a NestJS 11 microservice (`apps/agent-service`):

- **POST /runs** — Request/response mode. Waits for `egress`, returns `RunResponse`.
- **POST /runs/stream** — Streaming mode. Emits SSE events per node completion.
- **POST /fhir/Claim/$submit**, **POST /fhir/Claim/$inquire**, **GET /fhir/metadata** —
  the prior-authorization surface (P3-D, P3-E), shaped after Da Vinci PAS 2.2.1. `$submit`
  runs a second, four-node graph (`intake → lookup → assess → dispose`) inline, and enqueues
  a case before it answers.
- **GET /review/cases**, **GET /review/cases/:caseId**,
  **POST /review/cases/:caseId/determination** — the clinician review surface (P3-E).
- **POST /a2a/jsonrpc**, **GET /.well-known/agent-card.json**, **GET /.well-known/jwks.json**
  — the A2A v1.0 server and its discovery documents (P5-A). Below.
- **Global concerns:** bearer authentication, then the JSON body parser, then W3C trace
  context, all Express middleware mounted by `configureApp` ahead of every route; then, for
  Nest controllers only, AuditInterceptor (structured logging), LoggingInterceptor
  (correlation ID via AsyncLocalStorage) and HttpExceptionFilter. There is no global pipe:
  each controller validates its own body. There is no CORS.
- **Observability:** One trace per run under an `invoke_agent` root, one span per graph
  node beneath it, OTLP HTTP export. Model calls, embeddings and tool executions have
  spans of their own in the OpenTelemetry GenAI vocabulary, with token usage on each model
  call; content capture is off and an attribute allowlist holds it off. The pgvector reader
  carries a child span for its search, and `MemoryModule` constructs it, so a live trace on
  the configured memory axis shows `memory.pgvector.search` under `agent.node.retrieve`.
  The Neo4j reader's `memory.neo4j.expand` span appears in no run, because no request
  constructs that reader since ADR 0009.
  An inbound `traceparent` parents the run's root, so a caller's trace continues into the
  run; the gateway forwards it and opens no span of its own.

## Service Authentication

Every route except `GET /health` and the two `/.well-known` documents needs a bearer token
when `SERVICE_CREDENTIALS` is set (ADR 0014). The rule denies by default, so a route added
later is covered without being named. The service holds `principal:sha256hex` pairs, never
a token, and the check is at the service rather than the gateway because compose publishes
the service's own port.

- **Three states, like the model and memory axes.** Unset runs open: every caller is the
  principal `anonymous`, boot logs `auth.open` at `warn`, and the Agent Card declares no
  security. Malformed exits 1 naming the variable. Set requires a token.
- **The compose stack runs authenticated**, with two demo principals, `console` and `tck`.
  The console's nginx adds the console's token when the container starts, so it is in no
  bundle. Anyone who reaches the console's port uses it; the console has no user login.
- **What a principal can see.** On the A2A surface a task belongs to the principal that
  created it. `POST /runs` still lets an authenticated caller name any `sessionId`; ADR 0014
  states that as a residual.

## Agent2Agent (A2A)

`apps/agent-service/src/a2a/` serves A2A v1.0 over JSON-RPC, on `@a2a-js/sdk`'s request
handler mounted as Express middleware, not as Nest controllers. One endpoint,
`/a2a/jsonrpc`, also takes the v0.3 method names, because ADK for TypeScript 2.1.0 speaks
v0.3 (P5-B depends on that).

```
A2A message ─▶ RunExecutor ─▶ rebuildHistory (episodic, read-only)
                    │
                    └─▶ RunsService.run ─▶ graph ─▶ reflect writes the new turns
                         (runId = taskId)
```

- **A task is a run.** The SDK mints the task id, the executor passes it as the `runId`, so
  it is the checkpointer's `thread_id` and the run record's id. `/runs`, `/runs/stream`,
  the evaluation harness and the executor all go through `RunsService.run`.
- **A context is a session, per principal.** The session id is a UUIDv5 over the principal
  and the `contextId` (`contextSessionId`), so a principal who learns another's context id
  gets a different conversation. The history is rebuilt from episodic memory, which must
  hold exactly turns `0..n-1`; a gap or an over-long context fails the task rather than
  letting `reflect`'s `ON CONFLICT DO NOTHING` drop the new turn. Runs in one session are
  serialized in process. On the stub memory axis there is nothing to read, so every message
  is a conversation of one.
- **Every task ends terminal.** `COMPLETED` (an outcome of `partial` still completes, and
  says so in metadata) or `FAILED`, whose message names the node and never the error. A
  message naming a finished task is `-32004`, and `CancelTask` on a running one is `-32002`.
- **Tasks live in memory.** `GetTask` after a restart answers not-found, though the run's
  checkpoints and record exist. Two replicas would lose tasks between them.
- **The card is signed once, at boot,** by every key in `A2A_CARD_SIGNING_KEYS`, with ES256
  and the RFC 7638 thumbprint as `kid`; `/.well-known/jwks.json` publishes the public
  keys. With no key it is served unsigned. The card holds no empty value, because the SDK's
  canonical form drops empty values the specification keeps, and the service spec checks
  every signature with the SDK's verifier and with `jose` over RFC 8785. A caller that sends
  no `A2A-Version` gets the v0.3 card, unsigned.
- **Conformance** is the TCK at a pinned commit, MUST level, JSON-RPC, against the compose
  stack, with its expected failures listed in `scripts/tck-expected.txt`. There is no A2A
  certification to claim.
