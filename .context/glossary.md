# Glossary

## Three-Brain Memory Model

- **Working Memory:** Per-run, in-process state held in the LangGraph `AgentState` object.
  Destroyed at run completion. No external I/O.
- **Episodic Memory:** Session-scoped turn history persisted in Postgres via Drizzle ORM.
  Retention is currently unbounded. Raw material for Semantic promotion.
- **Semantic Memory:** Long-term knowledge stored across two complementary indices — a Neo4j
  knowledge graph for symbolic traversal and a pgvector collection for dense similarity search.

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

- **RRF (Reciprocal Rank Fusion):** Merge strategy that combines ranked lists from multiple
  sources. Score = Σ(1 / (k + rank_i)) where k is a smoothing constant (typically 60).
  Intended to merge Neo4j graph traversal results with pgvector similarity results; the
  implementation keys the two lists differently and so interleaves them instead. See
  ADR 0002.
- **Hybrid retrieval:** Querying both Neo4j and pgvector, then merging via RRF.

## Observability

- **OTel span:** An OpenTelemetry trace span measuring the duration and metadata of an
  operation. Each graph node produces one span.
- **Trace:** A tree of spans representing one complete request.
- **Correlation ID:** A UUID propagated across all services and log lines for a single
  request, set via `x-correlation-id` header or auto-generated.

## Scoping Hierarchy

- **Run:** A single invocation of the LangGraph graph. Identified by `runId` (UUID).
- **Session:** A logical conversation spanning multiple runs. Identified by `sessionId` (UUID).
  Episodic memory is scoped to sessions.
- **Turn:** A single user→assistant exchange within a run. Episodic rows are indexed by
  `turnIndex` within a session.

## Where the words and the code disagree

Several entries above name a design this repository has not finished building. `docs/STATUS.md`
is the per-capability matrix that says which is which, and it is the file to trust.
