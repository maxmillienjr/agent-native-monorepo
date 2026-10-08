# Glossary

## Three-Brain Memory Model

- **Working Memory:** Per-run, in-process state held in the LangGraph `AgentState` object.
  Destroyed at run completion. No external I/O.
- **Episodic Memory:** Session-scoped turn history persisted in Postgres via Drizzle ORM.
  Retention is currently unbounded. Raw material for Semantic promotion.
- **Semantic Memory:** Long-term knowledge distilled from runs. `reflect` writes it to two
  indices, a pgvector collection and a Neo4j knowledge graph, and retrieval reads only the
  pgvector collection (ADR 0009). The graph is kept for an explanation role not yet measured.

## LangGraph

- **Node:** A function `(state: AgentState) => Promise<Partial<AgentState>>` that performs
  one step of the agent loop. Each node has an OTel span.
- **Edge:** A directed connection between nodes. Can be unconditional or conditional
  (routed by a function that inspects state).
- **State:** The accumulated data flowing through the graph. Defined by `AgentStateSchema`.
- **StateGraph:** The LangGraph class that compiles nodes and edges into a runnable graph.
- **START / END:** Special sentinel nodes marking graph entry and exit points.

## Neo4j / Cypher

- **Node:** A graph entity with labels and properties (e.g., `(:Concept {id, label})`).
- **Relationship:** A directed edge between nodes (e.g., `[:RELATES_TO {confidence}]`).
- **MERGE:** Cypher clause that creates a node/relationship only if it doesn't already exist.
  Used instead of `CREATE` to ensure idempotent writes.
- **Pattern matching:** Cypher's `MATCH (a)-[:REL]->(b)` syntax for graph traversal.

## pgvector

- **`vector` column type:** Postgres column storing fixed-dimension float arrays.
- **`<=>` operator:** Cosine distance operator for similarity search.
- **HNSW index:** Approximate nearest neighbor index for fast vector search.
  `semantic_facts_embedding_hnsw` exists and no query uses it: both `<=>` queries break
  distance ties on the content hash, which an HNSW scan cannot serve, so every `<=>` query
  is a sequential scan and a sort. ADR 0006 records why.
- **Content hash:** SHA-256 of fact text, used as upsert key for idempotent writes.

## Retrieval

- **Vector-only retrieval:** What `retrieve` does: one session-scoped cosine search over
  `semantic_facts`, returned in the reader's order by `VectorRetrievalFacade`. A decision,
  not a gap — see hybrid retrieval.
- **RRF (Reciprocal Rank Fusion):** Merge strategy that combines ranked lists from multiple
  sources. Score = Σ(1 / (k + rank_i)) where k is a smoothing constant (typically 60). It
  merged the graph and vector lists until ADR 0009, keyed on the fact's content hash
  (ADR 0004). Today `rrfMerge` lives in `@repo/eval-harness`, and only the retrieval
  ablation calls it.
- **Hybrid retrieval:** Querying both Neo4j and pgvector, then merging via RRF. The service
  did this until ADR 0009. P2-B's ablation found it no better than vector search on the
  deployed path and 0.145 Recall@10 worse with perfect seeds, so it was removed from the
  request path. `yarn eval:retrieval` still measures it, as history.

## Observability

- **OTel span:** An OpenTelemetry trace span measuring the duration and metadata of an
  operation. Each graph node produces one span, opened with `withNodeSpan`.
- **Trace:** A tree of spans sharing one trace id. One run is one trace, rooted at the
  `invoke_agent agent-service` span `RunsService` opens around the graph. No HTTP
  instrumentation is registered, so there is no server span above the run. A caller that
  sends `traceparent` gets the run in its own trace: the service extracts it on every route,
  and the gateway forwards it (P5-A).
- **GenAI semantic conventions:** The OpenTelemetry attribute vocabulary for model calls,
  agents, tools and evaluation results. This repository emits it from
  `@repo/telemetry/genai`, pinned to one commit of the conventions repository; the pin and
  the upgrade procedure are in `.context/conventions.md`.
- **Evaluation event:** A `gen_ai.evaluation.result` log record, one per grader result,
  emitted by `EvalHarness` through the Logs API and parented to the trial's `invoke_agent`
  span.
- **Correlation ID:** A UUID propagated across all services and log lines for a single
  request, set via `x-correlation-id` header or auto-generated.

## Scoping Hierarchy

- **Run:** A single invocation of the LangGraph graph. Identified by `runId` (UUID).
- **Session:** A logical conversation spanning multiple runs. Identified by `sessionId` (UUID).
  Episodic memory is scoped to sessions.
- **Turn:** A single user→assistant exchange within a run. Episodic rows are indexed by
  `turnIndex` within a session.
- **Principal:** The caller a bearer token names, from `SERVICE_CREDENTIALS`, or
  `anonymous` when the service runs open. A2A tasks belong to one.
- **Task (A2A):** One message's run, as A2A names it. Its id is the `runId`.
- **Context (A2A):** A2A's conversation id. Not a `sessionId`: the session is derived from
  the principal and the context, so two principals with one context id have two sessions.

## A2A

- **Agent Card:** The JSON document at `/.well-known/agent-card.json` that tells another
  agent what this one does, where to call it and what credential to present. Signed when
  keys are configured.
- **JWKS:** The public keys the card's signatures verify against, at
  `/.well-known/jwks.json`.
- **TCK:** The A2A Technology Compatibility Kit, `a2aproject/a2a-tck`, run in CI at a
  pinned commit. A conformance suite, not a certification; none exists for A2A.

## Where the words and the code disagree

Several entries above name a design this repository has not finished building. `docs/STATUS.md`
is the per-capability matrix that says which is which, and it is the file to trust.
