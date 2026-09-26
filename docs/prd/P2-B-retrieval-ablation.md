---
id: P2-B
title: Hybrid retrieval evaluation and the graph/vector/hybrid ablation
tier: 2
status: accepted
size: L
depends_on: [P1-A, P1-B, P2-A]
blocks: [P4-B]
issue: null
superseded_by: null
---

# P2-B · Hybrid retrieval evaluation and the graph/vector/hybrid ablation

## Problem

ADR 0002 accepts the cost of a second store "on the theory that their failure modes are
uncorrelated and the union has meaningfully higher recall than either alone", and says the
record is provisional until that is measured (`0002-neo4j-and-pgvector-rather-than-one-store.md:31-39`).
ADR 0004 repeats it after fixing fusion (`0004-one-candidate-universe-for-fusion.md:116-118`).
`docs/STATUS.md:45` (row 15) marks RRF fusion `implemented`, which is a claim that fusion
executes, not that it helps. Nothing in the repository measures whether it helps, and the
current evaluation data cannot.

**Neither evaluation task reaches the graph retriever.** `CypherNeo4jReader.expandFromSeeds`
returns `:Fact` nodes reached through `(:Concept)<-[:MENTIONS]-(:Fact)`
(`neo4j.reader.ts:40-50`). The task seed format has concepts, relationships and pgvector
rows and nothing else (`types.ts:194-219`); `PgNeo4jSeedManager.applySeed` writes concepts,
relationships and pgvector facts and never calls `mergeFact` (`seed-manager.ts:86-90`).
Measured on 2026-09-26 against empty `pgvector/pgvector:pg16` and `neo4j:5-community`
containers, seeding each task exactly as `AgentServiceHarness.reset` does
(`agent-harness.ts:112-122`):

| Task                | `:Concept` | `:Fact` | `MENTIONS` | Linker seeds             | Graph, linker seeds | Graph, seeded concept ids | Hybrid sources |
| ------------------- | ---------- | ------- | ---------- | ------------------------ | ------------------- | ------------------------- | -------------- |
| `memory-recall-001` | 2          | 0       | 0          | `["what"]`               | 0                   | 0                         | `pgvector`     |
| `tool-use-001`      | 1          | 0       | 0          | `["search","langgraph"]` | 0                   | 0                         | `pgvector`     |

Both task files already say this about themselves (`memory-recall-001.json:5`,
`tool-use-001.json:73`), and P1-B handed the missing seed format to this PRD
(`P1-B-agent-cassette.md:121-124`).

**The graph path on the live axis is gated by a seed linker that cannot produce most entity
ids.** `retrieve` derives seed ids from the query by keeping capitalized words longer than
two characters, lowercasing them, and deleting every character outside `[a-z0-9-]`
(`retrieve.node.ts:12-20`). The ids come from the model: `EXTRACTION_PROMPT` asks for an
`"id"` and specifies no convention (`extraction.ts:3-4`). The two committed cassettes hold
the only live extractions in the repository (`memory-recall-001.trial-0.json:68`,
`tool-use-001.trial-0.json:164`). Of the 41 entity ids in them, 34 contain `_` —
`sys_stateful_agent`, `tech_pgvector` (`memory-recall-001.trial-0.json:78`, `:98`) — and
the linker deletes `_`, so no query can produce them. Seven can be produced: `langgraph`,
`changelog`, `improvements`, `deprecations`, `examples`, `summary`, `plan`. A multi-word
concept cannot be produced either way: `Prior Authorization` becomes
`["prior", "authorization"]`.

**The graph ranks by hop distance only.** Score is `1.0 / (1.0 + distance)`, ordered by
`score DESC, contentHash` and cut at `LIMIT 50` (`neo4j.reader.ts:48-50`). `reflect` links
every fact of a run to every entity of that run's extraction — `entityIds` is the whole
extraction's list (`reflect.node.ts:81`, `:95-100`), not the entities the fact mentions. So
one seed that matches reaches every fact of every run that mentioned it, all at distance 1.
Probed with three facts written the way `reflect` writes them: a query naming one of the
three entities returned all three at score `0.5`, in content-hash order. Within one hop
distance the graph's order is the order of sha256 digests.

**Fused candidates lose their provenance.** `rrfMerge` keeps the first candidate it sees
under a key and sums scores into it (`retrieval-facade.ts:73-77`), and the facade passes
the pgvector list first (`retrieval-facade.ts:110`). A fact both retrievers found is
reported as `source: 'pgvector'`. `source` therefore cannot be used to ask what the graph
contributed.

**The vector query no longer uses its index.** The tie-break P1-B added for determinism
(`3b696d5`, #44) orders by `embedding <=> $1::vector, content_hash`
(`pgvector.reader.ts:60`, `:65`). Probed on 2026-09-26 against 5,000 rows, pgvector 0.8.6:
the distance-only query plans as `Index Scan using semantic_facts_embedding_hnsw`; both
production variants plan as `Seq Scan` + `Sort`, and still do with `enable_seqscan` and
`enable_sort` off, so the index cannot serve that order at all. Every vector search is
exact. For this PRD that is convenient — exact search is deterministic — but it means any
latency this PRD reports is for a sequential scan, and the HNSW index
(`migrations/0001_semantic_facts.sql:22-23`, `docs/STATUS.md` row 6) is built and unused.

**The metrics were promised on an interface that does not fit them.** P1-A and the harness
README both say retrieval metrics are "P2-B, built on the `Grader` interface"
(`P1-A-eval-harness.md:72-73`, `packages/eval-harness/README.md:163`). A `Grader` grades one
agent trial — `grade(transcript, outcome): Promise<Score>` — into a pass or fail
(`types.ts:163-188`). A retrieval benchmark has no trial, no transcript and no threshold;
its unit is a ranked list per query, averaged.

## Why it matters

The README calls the two-index design "the intended architectural differentiator"
(`README.md:179`) and argues for it (`README.md:188`), and a
claim about retrieval quality has a standard form: a labelled query set, `Recall@k`, `MRR`
and `nDCG@k` per system, and the ablation that removes each component — the protocol TREC
and BEIR use, and the one hybrid-search write-ups are expected to show. ADR 0002 commits to
exactly that and to superseding itself if the result goes the wrong way. A reviewer reading
this repository will ask whether the second store earns its keep; the answer today is "not
measured", and the evidence above suggests that on the deployed path the graph contributes
almost nothing. An architecture repository that measures its own premise and reports the
result it got — including an unflattering one — is making the argument the rest of the
repository makes about evaluation.

## Scope

- **A seed format that writes graph facts**, for both the ablation corpus and agent tasks:
  `SeedApplication.graphFacts`, applied through `CypherNeo4jWriter.mergeFact`, and an
  optional `graphFacts` array in a task's `expectedSeeds`.
- **A labelled retrieval dataset**: a synthetic corpus written as `reflect`-shaped
  episodes, and a query set with relevance labels and gold seed entities, in four strata
  fixed before the first run.
- **Recorded embeddings**: every corpus fact and query embedded once through the production
  embedder, committed as float32, so the ablation runs in CI with no key.
- **The metrics**, as pure functions in `packages/eval-harness`: `Recall@k`, reciprocal
  rank, binary `nDCG@k`, and a seeded paired bootstrap.
- **The ablation runner**, `yarn eval:retrieval`: vector-only, graph-only and hybrid over
  the live stores, reported per stratum, with the diagnostic conditions that separate the
  graph store from the seed linker.
- **A pre-registered decision rule** for ADR 0002, stated in this PRD before any number
  exists, and the ADR that records whichever outcome the rule selects.
- **One agent task that exercises the graph path** end to end, with a recorded cassette,
  so the seed-format change has a consumer and the graph path is proven to reach `plan`'s
  prompt.
- The documentation the result moves: `docs/STATUS.md` (row 15 and a new row), the
  harness README's retrieval line, `README.md:188`, and `.context/conventions.md`.

### Non-goals

- **Fixing the seed linker, or the extraction's id convention.** The ablation measures the
  deployed linker and, separately, the store with the linker taken out. If the gap between
  those is the finding, fixing it is new work. **No PRD owns it today**; the ADR this PRD
  writes names it, and a PRD is opened then rather than now, because its shape depends on
  the number.
- **Per-fact `MENTIONS` in `reflect`.** Same reasoning. The diagnostic table measures what
  per-fact edges would buy; changing `reflect` is **unowned** until the ADR above says it is
  worth doing.
- **Restoring HNSW use under the tie-break.** Found here, outside this PRD's question, and
  not needed by it. It is not a defect but a trade, which
  [ADR 0006](../adr/0006-deterministic-retrieval-order-over-the-vector-index.md) records
  along with the conditions that reopen it — see the risks section.
- **An end-to-end answer-quality ablation** — the agent run once per query per condition,
  with a retriever switched off, and its answer graded. It needs `generateContent` per query per
  condition, and it only has a question to answer if the retrieval-level result shows a
  difference. **Unowned**; this PRD's ADR recommends one if and only if the result
  warrants it.
- **Wiring the ablation into CI.** `yarn eval:retrieval` runs with no key against
  compose-started stores; which pipeline tier runs it is **P1-C**.
- **Gating on the numbers.** The ablation is a measurement with a one-time decision rule,
  not a regression gate. Comparing a later run against this one is **P1-D**, which may
  reuse the bootstrap written here.
- **Graph session isolation.** `searchByCosine` is session-scoped by default
  (`pgvector.reader.ts:59`); `expandFromSeeds` has no session predicate and `:Fact` carries
  no session (`seed-manager.ts:36-40` says so). In production the hybrid can therefore
  return, through the graph, another session's fact that the vector path would have
  filtered. The ablation database holds one session, so this does not affect its numbers.
  **[P4-B](P4-B-memory-poisoning-red-team.md) owns it**, since a fact written in one session
  and read in another is a memory-poisoning path. P4-B reuses this PRD's `graphFacts` seed
  format and `graph-recall-001`, which is why it depends on this one.
- **A different embedding task type.** `createGeminiEmbedder` sends no `taskType`
  (`gemini-embedder.ts:35-39`), so queries and facts are embedded identically. That is the
  deployed configuration and the ablation measures it as deployed.

## Design

### Retrieval-level, not end-to-end

The ablation is a **retrieval-level benchmark**: query text in, a ranked list of content
hashes out, scored against labels. No chat model is in the loop.

- **It is the question ADR 0002 asks.** "The union has meaningfully higher recall than
  either alone" is a claim about retrieval. An end-to-end score measures retrieval through
  `plan`, `act`, `distill` and a grader, and a difference in retrieval can be absorbed or
  amplified by any of them.
- **It is deterministic, so it needs no trials.** Given fixed stores and fixed query
  vectors, both readers are total orders (`neo4j.reader.ts:49`, `pgvector.reader.ts:60`,
  `:65`) and the vector search is exact (Problem, above). One run is the measurement; the
  uncertainty that matters is over queries, which a bootstrap handles.
- **It fits the quota.** An end-to-end run costs three to five `generateContent` calls
  (`P1-B-agent-cassette.md:458-463`); three conditions over a hundred queries is roughly a
  thousand against a 20-request daily limit (`packages/eval-harness/README.md:130`).
- **What it cannot show** is whether a retrieval gain reaches the answer. That is the
  unowned end-to-end ablation above, and one agent task — below — proves only that the
  graph path reaches the prompt at all.

It does not go through `EvalHarness` or `Grader`. There is no transcript to grade and no
threshold that would make a `Recall@10` of 0.62 a pass or a fail; forcing it into that shape
would mean inventing both. What it reuses is the harness's vocabulary — every number names
the axes that produced it — and its reporter pattern.

### Axes

Two, reported in every output, following P1-A's rule that a number which does not say what
produced it is not a measurement:

| Axis       | Values               | What it means                                                           |
| ---------- | -------------------- | ----------------------------------------------------------------------- |
| memory     | `live` (only)        | Postgres and Neo4j, reset and seeded; the runner refuses without both   |
| embeddings | `recorded` \| `live` | vectors from the committed file, or `createGeminiEmbedder` called fresh |

The chat model is not an axis here because nothing calls it. `recorded` is the default and
the only value CI will use; `live` exists to produce the recording.

### Dataset

`packages/eval-harness/datasets/retrieval-ablation/`, a separate directory from
`memory-recall/` because `loadSuite` parses every `.json` in a dataset directory as a task
(`dataset.ts:198-216`).

**Corpus — `corpus.json`.** Episodes shaped like the `Extraction` `reflect` consumes, plus
one field `reflect` does not have:

```ts
export const CorpusEpisodeSchema = z.object({
  episodeId: z.string().uuid(),
  entities: z.array(z.object({ id: z.string(), label: z.string(), description: z.string() })),
  relationships: z.array(
    z.object({ fromId: z.string(), toId: z.string(), type: z.string(), confidence: z.number() }),
  ),
  facts: z.array(
    z.object({
      /** Authoring handle, e.g. "e07-f3". Labels refer to this; the hash is computed. */
      id: z.string(),
      text: z.string(),
      /** The entities this fact is about. `reflect` does not record this; see "Graph shape". */
      mentions: z.array(z.string()).min(1),
    }),
  ),
});
```

Target size: about 50 episodes and 300 facts, of which roughly half answer no query and
exist as distractors. Domain: fictional payer operations — invented payers, plans,
policies, deadlines, and ICD-10-CM codes where a code is needed. Fictional so that the
embedding model has no pretraining knowledge linking two entities that only the graph
links; payer-shaped because ADR 0003 makes that the repository's vertical, and inside its
limits: no CPT (`0003-payer-domain-with-licensing-and-phi-as-the-boundary.md:31-33`) and no
realistic case drawn from memory (`:34-36`).

**Entity ids follow the convention the live model produces**, which the cassettes show is
`snake_case` with a type prefix (`memory-recall-001.trial-0.json:78`). That choice decides
how often the deployed linker can match, so it is taken from the only evidence of what
production writes rather than picked; the oracle-seed conditions below measure the graph
without depending on it.

**Queries — `queries.json`.**

```ts
export const LabelledQuerySchema = z.object({
  id: z.string(),
  stratum: z.enum(['paraphrase', 'relational', 'entity-distractor', 'no-entity']),
  text: z.string(),
  /** Fact handles whose text answers the question. Closed set; see "Labels". */
  relevant: z.array(z.string()).min(1),
  /** The entity ids a perfect linker would return for this query. */
  goldSeeds: z.array(z.string()),
});
```

Four strata, 50 queries each, 200 in all, fixed now:

| Stratum             | Constructed so that                                                                                       | Favours by design |
| ------------------- | --------------------------------------------------------------------------------------------------------- | ----------------- |
| `paraphrase`        | the answer restates the query in different words and names the same entity                                | vector            |
| `relational`        | the query names entity A, the answer mentions B, A–B is a `RELATES_TO` edge, and the query never names B  | graph             |
| `entity-distractor` | the query names an entity that five or more facts mention, one or two of which answer it                  | neither           |
| `no-entity`         | the query names no entity in capitalized form — how a user asks "what's the deadline for urgent appeals?" | vector            |

Two strata favour vector, one favours graph, one favours neither, and the table says so,
because a synthetic set is always constructed toward something and the defence is to name
what. The headline number is the unweighted mean over all 200 queries; the per-stratum
table is reported beside it and is the one a reader should trust over the headline.

### Labels, and keeping them from being circular

A label is circular when it is derived from something one of the measured systems also
uses. Three ways that happens here, and what prevents each:

- **Labels computed from the vector space** ("relevant = cosine above t") make vector-only
  correct by definition. Prevented structurally: labels are written before any vector
  exists. The dataset and the embedding file are separate commits, the dataset commit
  first, and the report prints the dataset's sha256 so a later label edit is visible.
- **Labels computed from the graph** ("relevant = reachable from the seed") do the same for
  the graph. Prevented by the closed-answer rule: every query is written so that exactly
  the labelled facts answer it — "what is the urgent-appeal deadline for Harbor Mutual
  Silver?", not "tell me about Harbor Mutual" — and relevance is a judgement about the
  question, never a query against the corpus.
- **Queries written by copying the answer** make paraphrase secretly lexical, which favours
  whichever retriever rewards overlap. Measured rather than promised: the report prints
  mean token overlap (Jaccard over lowercased word sets) between each query and its
  relevant facts, per stratum.

Missing labels — a fact that answers the query and was not labelled — are the usual
failure of a hand-labelled set. After the first run, the top ten of every condition are
pooled, unlabelled members are shuffled with their source stripped, and the owner
adjudicates them blind to which condition retrieved them (TREC-style pooling). The report
carries metrics under both label sets. A label changed by adjudication is a separate
commit.

Authoring is text, not an API call: no `generateContent` is spent building the set. If the
implementing session drafts it with a model, that model must not be Gemini, the family that
embeds it.

### Recorded embeddings

`datasets/retrieval-ablation/recorded/embeddings.json`:

```ts
export const EmbeddingFileSchema = z.object({
  header: z.object({
    formatVersion: z.literal(1),
    embeddingModel: z.string(), // must equal EMBEDDING_MODEL (embedding.ts:25)
    embeddingDimensions: z.number().int().positive(), // must equal EMBEDDING_DIMENSIONS (:19)
    recordedAt: z.string().datetime(),
    gitSha: z.string().length(40),
    datasetSha256: z.string().length(64),
  }),
  /** sha256(text) -> base64 float32, as returned by the production embedder. */
  vectors: z.record(z.string().length(64), z.string()),
});
```

- **Recorded through `createGeminiEmbedder`**, the function `retrieve` and `reflect` both
  use (`runs.service.ts:185`, `:191`), one call per text — not `batchEmbedContents`, which
  is a different client path whose output this repository has never compared with
  `embedContent`'s. That is about 420 calls.
- **It is a different quota from the one that constrains the suite.** The 20-request limit
  recorded in the harness README is `generateContent` on `gemini-2.5-flash`
  (`packages/eval-harness/README.md:130`); embeddings go to
  `gemini-embedding-001:embedContent` (`gemini-embedder.ts:32`). The repository records no
  daily limit for `embedContent`; the largest recorded use is P1-B's recording run, which
  made twenty-one such calls and passed
  (`P1-B-agent-cassette.md:381`). So the recorder is **resumable**: it skips any text
  already in the file, writes after every call, and on the first 429 stops and says how many
  remain. A quota wall costs a day, not the recording.
- **Encoded with `encodeFloat32Base64`** from `@repo/agent-cassette`
  (`agent-cassette/src/index.ts:32`), for the reason P1-B gives: `vector(768)` is `float4`,
  so nothing the database keeps is lost. 420 vectors at 4,096 bytes of base64 each is about
  1.7 MB, committed. The file sits under `recorded/` and that path is added to
  `.prettierignore`, which already excludes cassettes for the same reason.
- **The reader lives in `apps/agent-service/src/eval/`**, beside `cassette-deps.ts`, because
  `@repo/eval-harness` does not import `@repo/agent-cassette` on purpose
  (`dataset.ts:58-61`).
- **Replay refuses** a file whose model, dimensions or `datasetSha256` differ from the
  running configuration, or which lacks a vector for any fact or query.

### Graph shape

`reflect` links each fact to every entity of its run (`reflect.node.ts:81`). The corpus
records per-fact `mentions`, which `reflect` does not. The seeder builds the graph both
ways:

- **`reflect`-shaped** — every fact of an episode `MENTIONS` every entity of the episode.
  This is the graph production writes, and every primary condition runs on it.
- **per-fact** — each fact `MENTIONS` only its own `mentions`. A diagnostic: what the graph
  could do if `reflect` recorded which entity a fact is about.

Both go through `SeedApplication.graphFacts` → `mergeFact`, after concepts, because
`mergeFact`'s `MATCH (c:Concept {id: eid})` silently links nothing to a concept that does
not yet exist (`neo4j.writer.ts:95`). All facts share one `sessionId` and the query passes
it, as `retrieve` does (`retrieve.node.ts:44-50`), so session scoping is a no-op on this
database rather than a variable.

### Conditions

Each condition is a function from a labelled query to a ranked list of content hashes,
built from the same classes the service constructs:

| Condition                | Call                                                                 | Table      |
| ------------------------ | -------------------------------------------------------------------- | ---------- |
| `vector`                 | `PgPgvectorReader.searchByCosine(q, topK, { sessionId })`            | primary    |
| `graph`                  | `CypherNeo4jReader.expandFromSeeds(linker(text), hopDepth)`          | primary    |
| `hybrid`                 | `HybridRetrievalFacade.retrieve({ …, seedEntityIds: linker(text) })` | primary    |
| `graph·oracle`           | `expandFromSeeds(goldSeeds, hopDepth)`                               | diagnostic |
| `hybrid·oracle`          | `retrieve({ …, seedEntityIds: goldSeeds })`                          | diagnostic |
| `graph·oracle·per-fact`  | as `graph·oracle`, on the per-fact graph                             | diagnostic |
| `hybrid·oracle·per-fact` | as `hybrid·oracle`, on the per-fact graph                            | diagnostic |
| `union`                  | vector list ∪ graph list, unranked                                   | diagnostic |

`linker` is `extractSeedEntityIds`, which is module-private today (`retrieve.node.ts:12`)
and gets exported, not copied — a copy would measure a linker nobody runs. Defaults are the
service's: `topK` 10, `hopDepth` 2 (`retrieval-facade.ts:9-10`). `hopDepth` 1 and 3 are
reported in the diagnostic table. The primary table is the deployed system; the diagnostic
table answers _why_. If `hybrid` loses and `hybrid·oracle` wins, the store is sound and the
linker is the defect. If both lose, the premise is wrong.

`union` is not a retriever. Its recall is the ceiling fusion could reach, so the gap
between it and `hybrid` is what RRF lost and the gap between it and `vector` is what the
graph found that the vector path did not. That last number, split per stratum, is the
direct test of ADR 0002's "uncorrelated failure modes": for each relevant fact, whether it
was found by vector only, graph only, both, or neither.

Provenance is computed from the two reader lists, not read from `source`, for the reason in
the Problem section.

### Metrics and statistics

`packages/eval-harness/src/retrieval/metrics.ts`, pure:

```ts
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number;
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number; // MRR@topK when averaged
export function ndcgAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number; // binary gain, log2 discount
```

Reported per condition at k ∈ {1, 3, 5, 10}, plus: the fraction of queries on which a
condition returned nothing (`expandFromSeeds` returns `[]` for no seeds,
`neo4j.reader.ts:20-23`); latency p50/p95 on the local stores, labelled as a sequential
scan; and the characters of retrieved context at `topK`, as the prompt-size proxy for the
"token cost" ADR 0002 asks for, because `plan` interpolates every candidate into its prompt
(`plan.node.ts:29-30`) and counting tokens would need a model call.

`packages/eval-harness/src/stats/paired-bootstrap.ts`: per-query paired differences, 10,000
resamples, a seeded PRNG, 95% percentile interval. In `stats/` rather than `retrieval/`
because P1-D needs the same thing.

**Tie sensitivity.** The graph's order within a hop distance is the order of sha256 digests
(Problem, above), which is arbitrary with respect to relevance, and RRF turns that order
into score. Every metric for `graph` and `hybrid` is therefore partly a property of the
hash function — `MRR` and `nDCG` through order, `Recall@k` whenever a tie straddles
position k. The runner re-sorts each graph list's ties by `sha256(salt ‖ hash)` for twenty
fixed salts, recomputes `rrfMerge` (exported and pure, `retrieval-facade.ts:64`) in memory,
and reports the min–max range of every metric beside the value at the production
tie-break. It cannot re-sort across the graph reader's `LIMIT 50`
(`neo4j.reader.ts:50`); a tie cut there is reported as a count, not re-ranked. The decision
rule is applied at the production tie-break, because that is what the service does, and the
range is printed next to it.

### The decision rule, pre-registered

Stated here, accepted with this PRD, before any number exists, so that the number cannot
move the rule:

- **Metric:** `Recall@10` over all 200 queries, pre-adjudication labels.
- **Comparison:** `hybrid` against the better of `vector` and `graph`.
- **Hybrid earns its keep** if the point difference is at least **+0.05** and the lower
  bound of the 95% paired bootstrap interval is above 0.
- **Hybrid does not** if the upper bound is below +0.05.
- **Otherwise inconclusive**, and reported as that — not rounded toward either side.
- **The same rule, applied to the diagnostic pair**, decides whether `hybrid·oracle` earns
  its keep against the better of `vector` and `graph·oracle`. That is what separates the
  second and third rows below.

What each outcome does:

| Outcome                                 | ADR 0002                                                                                              | Also                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `hybrid` earns its keep                 | A new ADR records the measurement and ends "provisional"                                              | —                                                                                                                    |
| `hybrid` does not; `hybrid·oracle` does | A new ADR supersedes 0002: the premise holds for the store, and the deployed path does not realise it | The ADR names the linker (and per-fact edges, if the diagnostic says so) as the work, unowned until a PRD is written |
| neither does                            | A new ADR supersedes 0002: the premise did not hold on this data                                      | Which store to keep is that ADR's decision, not this PRD's                                                           |
| inconclusive                            | 0002 stays provisional, with the interval recorded in a new ADR that says so                          | The report says what sample size would resolve it                                                                    |
| `hybrid` below `vector`                 | As "neither", stated as a loss rather than as "no gain"                                               | —                                                                                                                    |

In every row the measured numbers go into `docs/STATUS.md`, the harness README and
`README.md:188` as they came out. The reading in the Problem section predicts the second or
third row. This PRD is not written to avoid that, and it does not fix the linker mid-
measurement to avoid it either — a fix made after seeing the number is a new condition
measured against a new baseline, in a new PRD.

### The agent task

`datasets/memory-recall/graph-recall-001.json`, `retrievalPath: "hybrid"`. Its seed holds
one concept whose id the linker can produce (`langgraph` is an id in a live extraction,
`tool-use-001.trial-0.json:174`), one `graphFacts` entry that mentions it and is absent from
`pgvector`, and one ordinary `pgvector` fact. Its query names the concept capitalized.
A new code grader, `retrieved_from_source`, passes when `retrievedContext` holds at least
one candidate with `source: 'neo4j'` — which, given `rrfMerge`'s provenance rule, is only
possible for a fact the graph alone returned, and is exactly the fact the seed put there.

Adding a task changes two things that are asserted today: `dataset.test.ts:216-219`
expects exactly two tasks, and under replay a task with no cassette gets zero trials
(`dataset.ts:63-67`). The first becomes three; the second is met by recording one
cassette, which costs three to five `generateContent` calls. The two existing tasks' seeds
are not touched, so their cassettes remain valid.

### Layout

```
packages/memory-core/src/inspect/seed-manager.ts   SeedApplication.graphFacts -> mergeFact
packages/eval-harness/
  src/types.ts                                    TaskSeeds.graphFacts
  src/graders/code.ts                             retrieved_from_source
  src/retrieval/dataset.ts                        corpus + query schemas, loader, validation
  src/retrieval/metrics.ts                        recallAtK, reciprocalRank, ndcgAtK
  src/retrieval/report.ts                         AblationReport, JSON + Markdown
  src/stats/paired-bootstrap.ts
  datasets/retrieval-ablation/corpus.json
  datasets/retrieval-ablation/queries.json
  datasets/retrieval-ablation/recorded/embeddings.json
  datasets/memory-recall/graph-recall-001.json
  datasets/memory-recall/cassettes/graph-recall-001.trial-0.json
apps/agent-service/
  src/agent/nodes/retrieve.node.ts                export extractSeedEntityIds
  src/eval/agent-harness.ts                       reset() applies graphFacts
  src/eval/embedding-file.ts                      record (resumable) / replay
  src/eval/run-retrieval-ablation.ts              the runner
  package.json                                    "eval:retrieval"
turbo.json                                        eval:retrieval task and its env
docs/adr/NNNN-*.md                                the outcome, whichever it is
```

`eval:retrieval`, not `test:eval`: `agent-eval.yml:47` runs `yarn turbo test:eval` across
every workspace, and P1-A's reasoning for not declaring that name applies unchanged. The
turbo task declares `DATABASE_URL`, `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`,
`GOOGLE_API_KEY`, `EVAL_OUTPUT_DIR` and `EVAL_EMBEDDINGS_MODE`, because `envMode: strict`
drops anything undeclared (`turbo.json:40-52` is the precedent, and P1-B found it the hard
way).

## Acceptance criteria

Each criterion names the axis it is verified on. "Pure" means a unit test with no store and
no network.

- [ ] `SeedApplication` accepts `graphFacts`, and `applySeed` writes them through
      `mergeFact` after concepts. **Memory live:** an integration test seeds a fact
      mentioning a concept and `expandFromSeeds([thatConcept], 1)` returns it at score 0.5.
- [ ] `TaskSeeds` accepts an optional `graphFacts` array; `AgentServiceHarness.reset`
      applies it and `restoreToSeed` keeps its hashes. **Pure** (schema) and **memory live**
      (a reset followed by a second reset leaves the same `:Fact` set).
- [ ] `recallAtK`, `reciprocalRank` and `ndcgAtK` match hand-computed values on a fixture
      that includes an empty list, no relevant items, and ties. **Pure.**
- [ ] The paired bootstrap returns identical intervals for identical input and seed, exactly
      `[0, 0]` for two identical systems, and an interval excluding 0 for a fixture in which
      one system wins on every query. **Pure.**
- [ ] The retrieval dataset loads and validates: 200 queries, 50 per stratum; every
      `relevant` handle and every `goldSeeds` id resolves; no two facts share text. **Pure.**
- [ ] The dataset commit precedes the embedding-file commit in `git log`, and the report
      prints the dataset's sha256. **Reviewer, from history.**
- [ ] `EVAL_EMBEDDINGS_MODE=record` writes a vector for every fact and query through
      `createGeminiEmbedder`, resumes without re-embedding what is already recorded, and
      makes no `generateContent` request. **Embeddings live**, with the request count
      reported by the recorder.
- [ ] Replay refuses a file whose `embeddingModel`, `embeddingDimensions` or
      `datasetSha256` differs, or which is missing any vector — one unit test each. **Pure.**
- [ ] `yarn eval:retrieval` with `GOOGLE_API_KEY=` produces `ablation-report.json` and
      `ablation-summary.md` with the primary table (`vector`, `graph`, `hybrid`) at k ∈ {1,
      3, 5, 10} for `Recall`, `nDCG`, and `MRR`, overall and per stratum, and makes no
      request to `generativelanguage.googleapis.com`. **Memory live, embeddings recorded.**
- [ ] The same report carries the diagnostic table — the four oracle conditions, `union`,
      `hopDepth` 1 and 3 — the vector/graph/both/neither split of relevant facts, the
      empty-result fraction, latency p50/p95, context characters, per-stratum query–label
      overlap, and the tie-sensitivity range for every metric on `graph` and `hybrid`.
      **Memory live, embeddings recorded.**
- [ ] The report states both axes, the embedding file's `recordedAt` and `gitSha`, and the
      plan of the vector query (`EXPLAIN`), so a reader can see it was a sequential scan.
      **Memory live, embeddings recorded.**
- [ ] Two consecutive runs from empty stores produce byte-identical reports after masking
      timestamps and latencies. **Memory live, embeddings recorded.**
- [ ] The blind pooling pass is done, and the report carries metrics under the
      pre-registered and the adjudicated labels. **Reviewer.**
- [ ] The decision rule above is applied to the pre-registered labels and the outcome is
      recorded in a new ADR listed in `docs/adr/README.md` — whichever row it lands in.
      **Reviewer, against the committed report.**
- [ ] `graph-recall-001` passes `retrieved_from_source` on **model live, memory live** in the
      recording run, and on **model replay, memory live** from its committed cassette. The
      stub model axis runs it too, and is not what this criterion is verified on: the point
      is that the graph fact reaches `plan`'s prompt under the model that is deployed.
- [ ] `docs/STATUS.md` row 15 cites the measurement; a new row records the ablation as a
      capability; `README.md:188` and `packages/eval-harness/README.md:163` state the result
      rather than the plan. **Reviewer.**
- [ ] `.context/conventions.md` says where retrieval labels come from, that they are frozen
      before a run, and that an embedding file is re-recorded when `EMBEDDING_MODEL`,
      `EMBEDDING_DIMENSIONS` or the dataset changes. **Reviewer.**

## Risks and open questions

- **The hybrid may not beat vector-only, and the Problem section predicts it will not on
  the deployed path.** That is not a risk to this PRD — the decision table says what
  happens — but it is a risk to how the result is read. The mitigation is the oracle
  conditions: without them a loss would say "drop Neo4j" when it might mean "fix a
  nine-line heuristic". With them, the report distinguishes the two.
- **The margin is a judgement.** +0.05 `Recall@10` is this PRD's proposal for "a margin
  that justifies the operational cost"
  (`0002-neo4j-and-pgvector-rather-than-one-store.md:37-38`). It has to be agreed before
  acceptance, because agreeing it after the run is the thing pre-registration prevents.
  **Agreed at review, 2026-09-26: +0.05 stands.**
- **The query count decides how often the answer is `inconclusive`.** With a per-query
  standard deviation σ in the paired difference, the interval's half-width is about
  1.96σ/√n. The draft proposed 120 queries, which at σ = 0.3 gives ±0.054 — the same size as
  the margin. **Raised at review, 2026-09-26, to 200 (50 per stratum)**, which gives ±0.042
  at the same σ. The rule keeps its `inconclusive` outcome, and the report prints σ and the
  n that would resolve it. Growing the set later is allowed; relabelling it is not.
- **The corpus's id convention decides the primary `graph` number.** Taken from 41 ids in
  two live extractions, which is thin evidence of what the model does in general. The
  oracle conditions are independent of it; the primary ones are not.
- **Whether to build the graph by running the production `distill` over the corpus text
  instead of hand-authoring extractions.** That graph would be exactly what production
  writes, ids and all, but costs one `generateContent` per episode — about fifty, over
  three days of quota — and makes the corpus depend on a stochastic extraction that labels
  would then have to follow. **Decided at review, 2026-09-26: hand-authored episodes.** A
  `distill`-built corpus is a separate measurement of the extractor, not of the stores, and
  is unowned until this PRD's ADR says the linker or the extraction is the work.
- **Who adjudicates the pooled candidates.** The implementing session wrote the labels and
  cannot be blind to them. **Decided at review, 2026-09-26:** a separate agent session that
  is given each query and the shuffled, source-stripped pool, and never the labels, the
  condition names or the corpus file. The report says the adjudicator was a model and not a
  person, and names the model, because pooled adjudication by a model is weaker evidence
  than by a domain expert and a reader should be able to discount it.
- **Vector search is a sequential scan since #44.** Found while drafting this PRD and
  outside its scope. It does not bias the ablation — exact search is the best the vector
  path can do, and its latency is labelled. Since drafting, ADR 0006 has recorded it as a
  deliberate trade: the index-preserving query shapes were measured and none is
  deterministic, including over-fetch with an exact re-rank, which returned a different
  set after an index rebuild over identical rows. `docs/STATUS.md` row 6 is `stubbed` for
  that reason, and the ADR names what reopens it.
- **The tie-break makes rank metrics partly a function of sha256.** Reported as a range
  rather than hidden. A tie-aware fusion — giving tied candidates a shared rank — would be a
  change to `rrfMerge` and therefore to the system under test; it is not made here.
- **Recorded embeddings freeze the model.** A later change behind the same
  `gemini-embedding-001` id would not show up in a replayed ablation, which is the same
  limitation P1-B states for cassettes, and P1-E's canary is the answer to it there too.
- **Sizing.** `L`, against the index's `M`. The graph path with more than a handful of
  facts has never run in this repository, and `.agents/prd-author.md` says to size code
  that has never run as unknown. The known work — a seed-format change, a 300-fact corpus and
  200 closed-answer queries written by hand, a resumable recorder, eight conditions, and an
  ADR — is already past five days before the first surprise.

## References

- Cormack, Clarke, Büttcher, "Reciprocal Rank Fusion outperforms Condorcet and individual
  rank learning methods", SIGIR 2009 — the `k = 60` in `retrieval-facade.ts:45`.
- Järvelin, Kekäläinen, "Cumulated gain-based evaluation of IR techniques", TOIS 2002 —
  `nDCG`.
- Thakur et al., "BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information
  Retrieval Models", NeurIPS Datasets and Benchmarks 2021 — the per-dataset, per-metric
  reporting shape.
- Voorhees, "The Philosophy of Information Retrieval Evaluation", CLEF 2001 — pooling and
  its known bias toward the pooled systems.
- Efron, Tibshirani, _An Introduction to the Bootstrap_, 1993 — the paired percentile
  interval.
- pgvector, on which queries an HNSW index can serve:
  https://github.com/pgvector/pgvector#hnsw
