---
id: P2-D
title: Measure the graph's explanation role, or remove it (ADR 0009's fallback)
tier: 2
status: in-progress
size: M
depends_on: [P1-A, P1-B, P2-B]
blocks: [P2-E]
issue: 100
superseded_by: null
---

# P2-D · Measure the graph's explanation role, or remove it (ADR 0009's fallback)

## Problem

ADR 0009 took the graph out of retrieval and kept it for one candidate role: "answering,
for a retrieved fact, which concepts it mentions and how they connect to the concepts in the
question" (`0009-the-second-store-after-the-retrieval-ablation.md:149-151`). It names the
measurement that would justify the role: a labelled set of (question, answer fact, gold
concept path), path precision and recall, and only if those are good, an answer-level
comparison of `plan` with and without the path in its prompt (`:160-164`). Its condition for
the fallback is explicit: "C follows if P2-D's measurement does not meet its own rule, or if
P2-D is closed without one" (`:228-231`). This PRD is that measurement. Five facts about the
repository decide its shape.

**Nothing computes a path.** `CypherNeo4jReader.expandFromSeeds` returns `:Fact` candidates
scored by hop distance, and the path it traversed is discarded (`neo4j.reader.ts:60-81`).
No other graph read exists apart from the eval-only `RunInspector` counts
(`run-inspector.ts:71-75`). `VectorRetrievalFacade` reads pgvector alone
(`retrieval-facade.ts:56-63`), and `docs/STATUS.md` row 15 is `stubbed` for the role
(`STATUS.md:45`).

**The stored graph does not record which concepts a fact mentions.** `reflect` builds one
list of every entity the run's extraction produced (`reflect.node.ts:78`) and passes it to
`mergeFact` for every fact of the run (`:92-97`). The extraction cannot do better, because
its fact shape is `{ text }` with no attribution (`state.ts:30`), and the prompt asks for
none (`extraction.ts:3-4`). So `(:Fact)-[:MENTIONS]->(:Concept)` means "this concept was
extracted in the same run", not "this fact mentions it". ADR 0004 specifies the second
meaning: `reflect` writes a `:Fact` node "and links it to the concepts it mentions"
(`0004-one-candidate-universe-for-fusion.md:31`). The code and the record disagree, and no
document says so. In P2-B's corpus, counted on 2026-10-08 without reading any label, an
episode has 3.0 entities and a fact mentions 1.21, on average. The `reflect` shape thus
links each fact to about 2.5 times as many concepts as it mentions
(`retrieval/dataset.ts:406-411` builds both shapes).

**Concepts and edges are shared by every session, and M1 scopes only facts.**
`mergeFact` writes no session (`neo4j.writer.ts:31-36`, `:101-102`). `mergeRelationship`
merges an edge on `(from, to, type)` and overwrites its `episodeId` on match (`:134-141`).
`mergeEntity` overwrites a concept's label on match (`:58-60`). P4-B handed its graph session
filter, M1, to this PRD (`P4-B-memory-poisoning-red-team.md:206-226`). As specified, M1 adds
`sessionId` to `:Fact` and filters the reader on `f.sessionId`. That is sufficient for a
reader that returns facts, because the traversal it filters is internal. An explanation
returns the traversal itself, so its concept ids and edge types become output. Under M1 as
written, an explanation for session B's fact could cross an edge only session A wrote.

**The store's cost is unchanged since ADR 0009.** Neo4j runs as a compose service
(`docker-compose.yml:18-29`) and as a service container in both `agent-eval.yml` jobs that
start stores (`agent-eval.yml:98-104`, `:198-204`) and in `e2e.yml` (`:22-25`). At
`69f3787`, 54 tracked files other than Markdown name it (`git grep -il neo4j`, excluding
docs and the lockfile), and 36 Markdown files do.

**`yarn eval:retrieval` runs in no pipeline, and P2-D owns the question.** P2-B left the tier
to P1-C, which shipped first (`.context/conventions.md:106-107`). CTL-EVAL-04's note and
`docs/STATUS.md` row 23 hand the decision here (`governance/controls.yaml:203`,
`STATUS.md:53`). It still runs: on 2026-10-08 at `69f3787`, against fresh `pgvector:pg16` and
`neo4j:5-community` containers with `GOOGLE_API_KEY=` empty, it finished in 52 seconds of
wall-clock time. Its adjudicated summary matched the committed one in every line except
latencies and one heading the code renamed after the report was committed ("the path
deployed until ADR 0009").

## Why it matters

ADR 0002 accepted the second store's cost on a premise and promised to give it up if the
premise failed. P2-B measured it, the premise failed, and ADR 0009 kept the store anyway for
a role nobody had measured. It is only honest with a named measurement and a fallback
(`0009-...md:156-158`). An architecture that keeps a component on a promise is repeating the
trap that record names. NIST AI RMF 1.0 asks that a system's output be "explained,
validated, and documented" and interpreted in context (MEASURE 2.9). A graph path that
explains a retrieved fact is that kind of claim, and it has the same standard of evidence
as a retrieval claim: labels fixed before the run, a metric, and a rule. If the role
survives, the repository can show why a payer-operations answer cites the fact it cites. If
it does not, the repository removes the largest operational cost it carries for one
feature. Both outcomes are useful. Keeping the store without a result is not.

## Scope

- **Labels, committed before any explanation code exists.** For each of the 201 pairs of
  (query, pre-registered relevant fact) in P2-B's dataset, a gold concept path. For the 50
  relational queries, an answer key: the short strings a correct answer must contain.
- **M1, extended to edges.** `sessionId` on `:Fact` as P4-B specified, and on `MENTIONS` and
  `RELATES_TO` as part of their merge key. `reflect` and the seed manager pass it.
- **An explanation reader in `memory-core`**, `CypherNeo4jExplainer.explain`, which takes a
  session scope and has no unscoped form. It returns at most three concept paths per fact.
- **A question-concept linker** that matches question text against the labels of concepts
  the session has written, with no model call.
- **`yarn eval:explanation`**, a model-free runner over P2-B's corpus and live stores. It
  reports path precision and recall for four conditions and applies stage 1 of the rule.
- **Stage 2, conditional on stage 1:** an answer-level comparison of `plan` with and without
  the paths, recorded once and replayable with no key.
- **A pre-registered decision rule** (below), applied in code, and the ADR that records the
  outcome, whichever row it is.
- **The CI-tier decision for `eval:retrieval`**, recorded where the question is now open.
- **The specification P2-E inherits** for either outcome. Under C that means what removal
  touches; under keep, what wiring needs.

### Non-goals

- **Executing the outcome.** Removing Neo4j, or putting the explanation on the request path,
  is **P2-E**. This PRD writes the specification for both branches, and the ADR selects one.
  Removal touches 54 non-Markdown files and every CI job that starts a store. Wiring
  re-records every cassette. Neither belongs in a measurement PRD's review.
- **Changing `reflect` to per-fact `MENTIONS`.** Not taken first, for the reasons under
  "Graph shape" below. If the outcome is keep, **P2-E** decides whether to take it, at the
  cost stated there. Under C it is moot.
- **Measuring the extractor.** Building the graph by running `distill` over the corpus would
  measure the model's ids, edges and attribution as well as the store. P2-B declined it at
  review on 2026-09-26 for cost and stochasticity (`P2-B-retrieval-ablation.md:714-720`), and
  that reasoning holds. **Declined, not deferred.** The ADR states that the result is under
  an oracle extractor.
- **Putting the graph back in retrieval.** ADR 0009's "What a positive result would need" is
  the specification for any PRD that tries (`0009-...md:199-219`). **Declined here.** This
  PRD does not reopen it.
- **Per-session fact identity** (P4-B's open question 2). It stays where P4-B's ADR leaves it.
  A measured loss reopens it as its own PRD.
- **M2 and M3.** **P4-B**, unchanged.
- **A vector-only retrieval benchmark kept after removal.** **Declined.** The deployed path is
  held by the facade's integration tests and by the replay cassettes, whose keys include
  `plan`'s retrieved context.

## Design

### Two stages, and the asymmetry they are built on

Stage 1 is model-free and deterministic. It scores the paths the explainer returns against
gold paths. Stage 2 runs only if stage 1 is `good`. It asks whether `plan` answers better
with the paths than without them, and it costs `generateContent` calls.

Stage 1 runs on a hand-authored corpus, so the extractor is an oracle: concept ids, edges and
per-fact mentions are exactly what the author wrote. The question linker is also favoured,
because P2-B's loader requires every relational query to name its concept A by its exact
label (`retrieval/dataset.ts:331-336`). Both advantages push stage 1 toward `good`.
**So a stage-1 failure is conclusive, and a stage-1 pass is weak evidence.** That is the
asymmetry ADR 0009 needs: removal is the default, and a pass only earns the stage that costs
quota. Stage 2 is the evidence that could keep the graph.

### Labels

`packages/eval-harness/datasets/retrieval-ablation/explanation-labels.json`, beside the
corpus it refers to, in a commit that precedes any commit containing the explainer's Cypher or
the runner. The report prints its sha256 beside the dataset's.

```ts
export const ConceptPathSchema = z.object({
  /** Concept ids from a question concept to a concept the fact mentions. Length 1 = the fact mentions it. */
  concepts: z.array(z.string()).min(1),
  /** RELATES_TO types between consecutive concepts; length = concepts.length - 1. */
  edgeTypes: z.array(z.string()),
});

export const ExplanationLabelsSchema = z.object({
  /** sha256 of corpus.json + queries.json, as P2-B prints it; the loader refuses a mismatch. */
  datasetSha256: z.string().length(64),
  pairs: z.array(
    z.object({
      queryId: z.string(),
      factHandle: z.string(), // a pre-registered `relevant` handle
      gold: z.array(ConceptPathSchema), // empty = the correct explanation is none
    }),
  ),
  answerKeys: z.record(z.string(), z.array(z.string()).min(1)), // relational query id -> alternatives
});
```

**Gold paths are derived from the strata construction, not judged.** The loader already
enforces that a relational query names A, that its answer fact mentions some B and never A,
and that A–B is a `RELATES_TO` edge (`retrieval/dataset.ts:330-350`). The gold path for a
relational pair is every `[A, type, B]` that satisfies that construction. For `paraphrase`
and `entity-distractor` pairs it is `[A]` for each gold seed the fact mentions. For
`no-entity` it is empty. A script derives the file, and the derived file is committed and
reviewed, not regenerated. This is what makes the extractor an oracle: the corpus that seeds
the graph is the corpus the gold comes from. It is stated as the design rather than hidden.

**Answer keys are authored by hand**, from the relevant fact's text, before any stage-1
number exists, for all 50 relational queries. A key is a short string that a correct answer
must contain, such as a number of business days, with alternatives for the forms a number
can take. The loader checks that every alternative occurs in the fact's text and not in the
query's. As in P2-B, they are not drafted with a Gemini model.

### M1, extended to edges

P4-B's specification, as inherited, plus the two edges an explanation exposes:

```cypher
// mergeFact
MERGE (f:Fact {contentHash: $contentHash})
  ON CREATE SET f.text = $text, f.episodeId = $episodeId, f.sessionId = $sessionId
  ON MATCH SET f.text = $text
WITH f UNWIND $entityIds AS eid
MATCH (c:Concept {id: eid})
MERGE (f)-[:MENTIONS {sessionId: $sessionId}]->(c)

// mergeRelationship
MERGE (a:Concept {id: $fromId}) MERGE (b:Concept {id: $toId})
MERGE (a)-[r:RELATES_TO {type: $type, sessionId: $sessionId}]->(b)
```

`FactWriteSchema` and `RelationshipWriteSchema` gain a required `sessionId`. `reflect` passes
`state.sessionId`. `SeedApplication` and `TaskSeeds` take theirs from the seed's session.
`ensureSemanticConstraints` adds a range index on `:Fact(sessionId)` and a relationship
property index on `RELATES_TO(sessionId)`. Facts keep P4-B's first-writer rule, so they agree
with pgvector (ADR 0004). Edges become per session, because an edge is only safe to show to
the session that wrote it.

Concepts stay global, keyed on `id`. The explainer returns ids and edge types, never labels
or descriptions, since `mergeEntity` makes those last-writer-wins (`neo4j.writer.ts:58-60`).
An id that sits on an edge the requesting session wrote was written by that session.

Nothing is deployed, so no backfill is written. A `:Fact` or edge with no `sessionId` matches
no scoped read. P2-B's corpus is one session (`corpus.json`'s `sessionId`), so its graph and
its ablation numbers are unchanged. A criterion holds that.

### The explainer

```ts
// packages/memory-core/src/semantic/neo4j/neo4j.explainer.ts
export interface ExplanationScope {
  readonly sessionId: string; // required; there is no crossSession for this read
}
export interface ConceptPath {
  readonly concepts: readonly string[];
  readonly edgeTypes: readonly string[];
}
export interface Neo4jExplainer {
  explain(
    questionConceptIds: readonly string[],
    factContentHashes: readonly string[],
    scope: ExplanationScope,
  ): Promise<ReadonlyMap<string, readonly ConceptPath[]>>;
}
```

For each fact the session owns, it takes the concepts the fact mentions through in-session
`MENTIONS` edges. It finds the shortest path, at most two `RELATES_TO` hops, from any question
concept to each of them, over in-session edges only. It returns at most three paths per fact,
ordered by length and then by the joined id sequence, so the order is total. A length-0 path
means the fact mentions a question concept directly. The span is `memory.neo4j.explain`, with
`gen_ai.operation.name` `search_memory` and counts only, as its siblings have
(`neo4j.reader.ts:12-14`).

**Question linker.** `linkQuestionConcepts(text, scope)` returns the ids of in-session
concepts whose label occurs in the text as a whole-word, case-insensitive match. Longest
matches win, and matches may not overlap, so "Harbor Mutual Silver" links the plan and not
the payer "Harbor Mutual". The label is read from the global concept node. That is a residual
cross-session influence on which concept is chosen, though not on what is returned (see
Risks). The rest of the read is scoped. ADR 0009 requires a linker of this kind to land after
M1 (`0009-...md:206-209`), and this design keeps that order.

### Graph shape, and why `reflect` is not changed first

The decisive condition runs on the graph shape `reflect` writes. Per-fact `MENTIONS` is a
diagnostic, as it was in P2-B. Changing `reflect` first was considered and rejected:

- **On this corpus per-fact is circular.** The gold paths are derived from the same per-fact
  `mentions` the per-fact graph is built from. Its recall is 1 by construction, which is why
  it is used below as a check on the explainer and not as evidence.
- **Making per-fact real costs a re-record and an unmeasured model.** The extraction would
  need a `mentions` field in `ExtractionSchema` and in `EXTRACTION_PROMPT`. That changes
  `distill`'s request, so both cassettes miss on replay. Re-recording them costs about eight
  `generateContent` calls (P1-F's 2026-10-08 recording), and P1-D's replay baseline is then
  regenerated. Whether the model attributes facts correctly would still be unmeasured, since
  no labelled extraction set exists.
- **ADR 0004 is not affected either way.** Per-fact linking is what its text already says
  (`0004-...md:31`), so taking it later corrects the code to the record and supersedes
  nothing. The `:Fact` copy is the same under both shapes. Edges written before the change
  would persist, because `MERGE` never deletes. That is moot with nothing deployed, and the
  ablation reseeds from empty.

### Conditions

All four run on P2-B's corpus, seeded through `PgNeo4jSeedManager` with
`graphFacts(dataset, shape)`. The scope is the corpus session.

| Condition                 | Graph shape | Question concepts      | Role                                                |
| ------------------------- | ----------- | ---------------------- | --------------------------------------------------- |
| `explain`                 | `reflect`   | `linkQuestionConcepts` | **decisive**: the explainer as it would ship        |
| `explain·oracle`          | `reflect`   | `goldSeeds`            | diagnostic: separates the linker from the shape     |
| `explain·per-fact`        | per-fact    | `linkQuestionConcepts` | diagnostic: what attribution would buy              |
| `explain·per-fact·oracle` | per-fact    | `goldSeeds`            | construction check: must equal its computable bound |

**The construction check runs first.** On relational pairs, `explain·per-fact·oracle` must
score path recall equal to the bound the loader computes from each pair's gold count. That
bound is 1.000 unless a pair has more than three gold paths. If it does not, the explainer has
a defect, and the runner stops without printing any other condition. This is the only point
at which the explainer may be fixed after a run, and the report says whether it was.

### Metrics

Per (query, fact) pair, over the paths `R` returned (at most three) and the gold set `G`,
where a path matches when its concepts and edge types are equal in either direction:

- **Path precision@3** = |R ∩ G| / |R|, and 0 when R is empty and G is not.
- **Path recall@3** = |R ∩ G| / min(|G|, 3).
- **Hit@1**: the first path is gold. Reported only.
- **Abstention** on `no-entity` pairs: R is empty. Reported only.

The metrics are averaged per stratum. **The rule reads the relational stratum only**: 50
pairs, one per query, under the pre-registered labels. In the other strata the gold path is
`[A]`, a fact naming the question's concept, which the fact's own text already shows to
`plan`. Intervals come from `pairedBootstrap(values, zeros)` (`stats/paired-bootstrap.ts:65`):
10,000 resamples, seed `0x5eed`, 95% percentile. `pairsToResolve` prints the n an
inconclusive result would need (`:124`). Pure functions in
`packages/eval-harness/src/retrieval/explanation.ts`.

### The decision rule, pre-registered

Stated before any path or answer exists. The only corpus statistics computed while drafting
were the label-free counts in the Problem section.

**Stage 1, on `explain`, relational stratum, pre-registered labels:**

- **`good`** if the 95% lower bound of mean path recall@3 is at least **0.70** _and_ the
  95% lower bound of mean path precision@3 is at least **0.50**.
- **`not good`** if either upper bound is below its threshold.
- **`inconclusive`** otherwise, reported as that, with `pairsToResolve`.

Precision 0.50 means at least half of the paths `plan` would read are right. Below that, most
of what the explanation tells the model is wrong, and in a payer domain a wrong connection
is worse than none. Recall 0.70 is near the vector path's relational Recall@10 of 0.760
(`0009-...md:48`): an explainer that misses more of the gold paths than retrieval misses of
the facts is not adding to it.

**Stage 2, only if stage 1 is `good`:**

- **Queries:** the relational queries whose answer fact `vector` placed in its top ten in
  P2-B's committed run. That is 38 of 50, fixed by `vector`'s relational Recall@10 of 0.760,
  and the list is printed. A path cannot help an answer whose fact was never retrieved.
- **Condition `without`:** `plan`'s prompt exactly as `planNode` builds it
  (`plan.node.ts:28-35`). The messages are the query as one user turn, and the retrieved
  context is `VectorRetrievalFacade` at `topK` 10 over the corpus, with recorded query vectors.
- **Condition `with`:** the same prompt plus one block, rendered by
  `renderExplanationBlock`, which a unit test pins:
  `Connections in memory:` and then, per retrieved fact with a path,
  `- context <n>: <id> -[<TYPE>]- <id> …`.
- **Model:** `RunsService.modelDeps().plan.callLlm`, which is the production client, retry
  policy and `stopOnDailyQuota` (`runs.service.ts:285`, `rate-limit.ts:106`), on the
  pinned `gemini-2.5-flash`. One call per query per condition, and both calls for a query in
  the same invocation.
- **Grader:** `answer_key_present`, a code grader. The output, lowercased with whitespace
  collapsed, contains any of the query's answer-key alternatives. A second grader,
  `bridge_named`, checks whether B's label is in the answer, and is reported only.
- **`met`** if the paired difference in `answer_key_present` (`with` − `without`) is at least
  **+0.10** and the bootstrap's lower bound is above 0. Otherwise **`not met`**.

**What each outcome does:**

| Stage 1                      | Stage 2   | Outcome                            | ADR (number at write time; 0007 is reserved by P4-B)                                                    | P2-E                                     |
| ---------------------------- | --------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `good`                       | `met`     | **keep the graph for explanation** | Records the role as measured, under an oracle extractor, and what wiring must preserve                  | Wires the explainer into `plan`'s prompt |
| `good`                       | `not met` | **option C**                       | The graph explains, and `plan` does not use it. C follows by ADR 0009's condition. Supersedes ADR 0004. | Removes the graph                        |
| `not good` or `inconclusive` | not run   | **option C**                       | Diagnostics say which part failed: linker, shape or both. Supersedes ADR 0004.                          | Removes the graph                        |

`inconclusive` selects C because ADR 0009's condition is that the measurement meets its rule,
and an inconclusive result does not. Growing the labelled set before the first run is
allowed. Re-running with more pairs after seeing an inconclusive result is a new measurement
in a new PRD. The C rows do not supersede ADR 0009, because executing its stated fallback is
its decision (`0009-...md:228-233`). They supersede ADR 0004, as 0009's Consequences
anticipates (`:267`).

**The Problem section predicts the third row.** The `reflect` shape links each fact to about
2.5 times the concepts it mentions. Whenever the question's concept was extracted in the
answer fact's run, that shape links the fact to it, and the length-0 path, which the gold
excludes, ranks first. This PRD is not written to avoid that. If a diagnostic condition
passes where `explain` does not, the ADR records it as a condition for a future PRD, as ADR
0009 did for retrieval. It does not fix the shape or the linker mid-measurement.

### Budget

Stage 1 makes no model call and no embedding call. Stage 2 makes **76 `generateContent`
calls**, 38 queries × 2 conditions, and replays at zero. The free tier allows 20 a day per
project, and the nightly takes 9 of them (`P1-E-model-drift-canary.md:196-205`). That leaves
about 11 a day, so stage 2 takes about seven days of spare quota. P3-D's recording (20 calls)
and P4-B's red-team recordings compete for the same days. The recorder is resumable on the
pattern of `embedding-file.ts`: one file, keyed on `(queryId, condition)` and the prompt's
sha256, written after every call. It stops on the first daily-quota 429, and replay refuses a
prompt whose hash differs. A billed key would make it one sitting; open question 2. The
expected cost, given the prediction above, is zero.

### Whether `eval:retrieval` runs in a CI tier

**Decided: P2-D wires nothing into CI.** Under C, the graph and hybrid conditions cannot run
once Neo4j is gone. P2-E archives the measurement: the dataset, embeddings and committed
reports stay, and its ADR names the last commit at which `yarn eval:retrieval` reproduced the
committed report, verified by a run on that commit as this PRD did at `69f3787`. Under keep,
P2-E adds a reproduction step to the `replay` job for both `eval:retrieval` and
`eval:explanation`, compared exactly against the committed reports after masking. It needs no
key, the job already starts both stores, and the ablation took 52 seconds. Under keep the
graph is on a request path, so a reader change should fail a pull request. Under C nothing
the ablation measures still runs.

### What P2-E inherits

**Under C, removal touches** the files `git grep -il neo4j` lists at the commit P2-E starts
from, at least these:

- `memory-core`: `semantic/neo4j/` (client, constraints, reader, writer and the explainer),
  the graph half of `inspect/seed-manager.ts` and `inspect/run-inspector.ts`, their exports,
  the `neo4j-driver` dependency, and the Neo4j halves of the integration tests and their env.
- `agent-service`: `reflect`'s graph writes and `ReflectNodeDeps.neo4jWriter`; `NEO4J_URI`
  leaving the memory axis in `memory.config.ts`; `memory.module.ts`, `memory.tokens.ts`,
  `runs.service.ts`; the e2e specs; `agent-harness.ts`'s graph seeding; and the ablation's
  graph and hybrid conditions, `seed-linker.ts` and the explanation runner.
- `eval-harness`: `rrf.ts`, `graphFacts`, the `neo4j` task seeds, and the `concepts_merged`
  grader with the `mergedConceptsMin` assertion. P1-D's replay baseline is regenerated with
  `EVAL_GATE=update`, with no key. `EXTRACTION_PROMPT` stays as it is, so the cassettes replay.
  Dropping entities and relationships from the extraction would cost a re-record, and that
  is P2-E's call.
- `shared-types`: `source: z.enum(['neo4j', 'pgvector'])` (`memory.schema.ts:10`), a change
  to the `RunResponse` contract.
- Stack: the compose service and volume, `.env.example`, `mcp-config/neo4j.json`, `turbo.json`'s
  `NEO4J_*` env, and the service containers in `agent-eval.yml` and `e2e.yml`.
- Docs: `docs/STATUS.md` rows 15 and 23, `.context/architecture.md`, `README.md`, CTL-EVAL-04,
  and an amendment to P4-B, whose `rt-001` seeds the graph. M1 then becomes a deletion.

**Under keep, wiring needs** the explainer called after `retrieve` with the run's session,
inside a node span (`withNodeSpan`, as every graph node has), and the block in `plan`'s
prompt as stage 2 measured it. That changes `plan`'s request, so
both cassettes are re-recorded (about eight calls) and P1-D's baseline is regenerated. It
also needs a decision about labels, which are global; the reproduction step above; and
`docs/STATUS.md` row 15 moving for the explanation role only.

### Layout

```text
packages/memory-core/src/semantic/neo4j/neo4j.writer.ts      sessionId on :Fact, MENTIONS, RELATES_TO
packages/memory-core/src/semantic/neo4j/neo4j.constraints.ts :Fact(sessionId), RELATES_TO(sessionId)
packages/memory-core/src/semantic/neo4j/neo4j.explainer.ts   CypherNeo4jExplainer, linkQuestionConcepts
packages/memory-core/src/inspect/seed-manager.ts             sessionId into graph writes
packages/memory-core/test/explainer.integration.test.ts      paths, order, two-session isolation
apps/agent-service/src/agent/nodes/reflect.node.ts           pass state.sessionId
apps/agent-service/src/eval/run-explanation.ts               the runner, stages 1 and 2
apps/agent-service/src/eval/answer-file.ts                   stage-2 record / replay
apps/agent-service/package.json                              "eval:explanation"
packages/eval-harness/src/retrieval/explanation.ts           labels loader, metrics, rule, report
packages/eval-harness/datasets/retrieval-ablation/explanation-labels.json
packages/eval-harness/datasets/retrieval-ablation/reports/explanation/
turbo.json                                                   eval:explanation and its env
docs/adr/NNNN-*.md                                           the outcome, whichever it is
```

## Acceptance criteria

Each criterion names the axis it is verified on. "Pure" means a unit test with no store and
no network. "Memory live" means `pgvector:pg16` and `neo4j:5-community` containers.

Ticked on 2026-10-08, each against the evidence named after it. Three criteria are split,
because stage 1 was `good` and their second half needs stage 2. The open halves are P2-D's
own, and stage 2 is the next piece of this PRD.

- [x] `explanation-labels.json` is committed before any commit that adds the explainer or the
      runner, and the report prints its sha256 and the dataset's. **Reviewer, from
      history.** The labels commit holds the JSON alone. It follows the loader and precedes
      M1, the explainer and the runner. The summary's header prints both hashes.
- [x] The labels load and validate. The loader checks that `datasetSha256` matches, that
      every pair names a pre-registered relevant fact, that every gold concept and edge
      exists in the corpus, and that each relational pair has at least one gold path. It
      also checks that every answer-key alternative occurs in the fact's text and not in the
      query's. **Pure.** `explanation-labels.test.ts` covers each refusal. The committed file
      loads, and it equals `deriveGoldPaths`. The answer-key check compares normalized text
      (divergence 1).
- [x] `mergeFact` sets `f.sessionId` on create and leaves it unchanged when a second session
      writes the same fact. `MENTIONS` and `RELATES_TO` are written per session. **Memory
      live**, two sessions in one integration test: `semantic.integration.test.ts`, "keeps a
      fact's first writer and writes MENTIONS and RELATES_TO once per session".
- [x] `reflect` passes `state.sessionId` to `mergeFact` and `mergeRelationship`. **Pure**,
      with a fake writer: `reflect.node.test.ts`.
- [x] `explain` returns nothing for a fact another session owns, and no path that crosses an
      edge only another session wrote. **Memory live**, two sessions:
      `explainer.integration.test.ts`, "returns nothing for a fact another session owns, even
      one it restated" and "crosses only edges the session wrote".
- [x] `explain` has no unscoped signature: calling it without `sessionId` fails
      `yarn turbo typecheck`. **Pure**, as a type test: `neo4j.explainer.test-d.ts`, which
      also refuses a `crossSession` scope and an unscoped `expandFromSeeds`.
- [x] On a hand-built fixture graph, `explain` returns the hand-computed paths in the
      specified order, at most three per fact and at most two hops. **Memory live.**
      `explainer.integration.test.ts`. The fixture's paths are drawn in its docstring.
- [x] `linkQuestionConcepts` takes the longest non-overlapping match, matches whole words
      regardless of case, and ignores concepts the session has no edge to. **Pure** for
      matching (`neo4j.explainer.test.ts`, `matchConceptLabels`), **memory live** for scope
      ("links only concepts the session has an edge to").
- [x] After M1, `yarn eval:retrieval` reproduces the committed adjudicated report except for
      timestamps and latencies. **Memory live, embeddings recorded.** Run from empty
      containers at the branch head, the JSON report is identical to the committed one once
      timestamps and latencies are masked. The summary differs only in latencies and in the
      one heading the code renamed after the report was committed, which the Problem section
      records.
- [x] With `GOOGLE_API_KEY=` empty, `yarn eval:explanation` writes a JSON and a Markdown
      report. They hold path precision@3, recall@3 and Hit@1 for all four conditions, per
      stratum, with interval, n, sd and `pairsToResolve`, plus the dataset and label hashes
      and both axes. The run makes no request to `generativelanguage.googleapis.com`.
      **Memory live.** The runner fails on any request to the model host. The axes are
      memory `live`, model `none` and embeddings `none` (divergence 2).
- [x] The construction check passes before any other condition is printed, and the report
      says whether the explainer changed after the first run. **Memory live.** It passed on
      the first run, and the explainer was not changed.
- [x] Two consecutive runs from empty stores give byte-identical reports after masking
      timestamps and latencies. **Memory live.** Both the JSON and the Markdown are
      identical once `startedAt` and `finishedAt` are masked. The explainer's reads are not
      timed.
- [x] `applyExplanationRule` maps intervals to `good`, `not good` and `inconclusive`, and
      outcomes to the table's rows, on fixtures that include each boundary. **Pure.**
      `explanation.test.ts`, which also pins `applyAnswerRule` at +0.10 and at a lower bound
      of 0.
- [x] Stage 2 matches stage 1's outcome, on the branch stage 1 took. Stage 1 is `good`, so
      the report states that stage 2 has not run and made 0 `generateContent` calls.
- [ ] Stage 2's recording run reports both graders for 38 queries × 2 conditions on **model
      live, memory live**. **Model replay** then reproduces every grader result with no
      request to the model host. **Reviewer, from the committed report.** _Open, P2-D stage 2. The code exists, and a dry run on a fake model showed it resumable ("Stage 2's
      code, and the run that remains"). The 76 calls remain, ten days at eight a day._
- [x] `renderExplanationBlock` and the `without` prompt are pinned. The `without` prompt
      equals `planNode`'s for the same state. **Pure.** `explanation-prompt.test.ts` runs
      `planNode` on the same state and holds what it sends equal to `without`. It pins the
      bytes of `with`, and checks that deleting the block from `with` gives `without`.
      `plan.node.test.ts` pins `planNode`'s own bytes, which both cassettes key on.
- [x] The ADR is listed in `docs/adr/README.md`, states that the result is under an oracle
      extractor, and is `proposed` until the owner accepts it. **Reviewer.** ADR 0012.
- [ ] The ADR records the row the rule selected and, for a C row, supersedes ADR 0004.
      **Reviewer.** _Open, P2-D stage 2. Stage 1 alone selects no row._
- [x] `docs/STATUS.md` rows 15 and 23, CTL-EVAL-04's note, `.context/conventions.md`'s
      Testing paragraph, `.context/architecture.md`'s Neo4j bullet and the docstring on
      `CypherNeo4jReader` state stage 1's result and the CI-tier decision. **Reviewer.**
- [ ] The same six places state the final outcome. **Reviewer.** _Open, P2-D stage 2._
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## Stage 1, and where it diverged

Measured 2026-10-08, from empty containers, with no key. ADR 0012 has the full account.
Relational stratum, pre-registered labels:

| Condition                 | Precision@3          | Recall@3             | Hit@1                |
| ------------------------- | -------------------- | -------------------- | -------------------- |
| `explain` (decisive)      | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] |
| `explain·oracle`          | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] |
| `explain·per-fact`        | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] |
| `explain·per-fact·oracle` | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] |

**Stage 1 is `good`, and the rule selects no row yet.** Both lower bounds clear their
thresholds. The pass is the weak kind the Design section anticipated: recall is all but
guaranteed by the `reflect` shape and the relational construction, the label linker equals
the oracle on every pair, and the extractor is the corpus. **The Problem section's
prediction did not hold.** A length-0 path ranked first in 12 of 50 pairs, the program
episodes. Most answer facts sit in an episode about B alone, so the `reflect` shape never
linked them to A. Stage 2 is next. Its code exists (the next section), and its 76 calls
are scheduled against the quota table in `.context/conventions.md`.

Where the implementation is not what the Design section describes:

1. **Answer keys are checked in a normalized form.** The Design asks for alternatives "for
   the forms a number can take", and for a loader check that every alternative occurs in the
   fact's text. Taken literally the two conflict: "5 business days" does not occur in "five
   business days". The loader and `answerKeyPresent` compare after `normalizeAnswerText`.
   It lowercases, collapses whitespace, drops digit-group commas and writes number words up
   to ninety as digits, so both forms pass, and a stage-2 answer in either form counts.
2. **Stage 1's axes are memory `live`, model `none`, embeddings `none`.** The criterion names
   "embeddings recorded". The runner seeds only the graph and reads no vector, so it loads
   no embedding file. Stage 2 will read recorded query vectors for `VectorRetrievalFacade`.
3. **`expandFromSeeds` took the scope too.** M1's file list names the writer, the
   constraints and the explainer. P4-B's M1, which this PRD inherits, also scopes the
   retrieval reader. It now takes a required `GraphReadScope` and filters the fact and every
   edge on the path. The ablation passes the corpus session, and its report is unchanged.
4. **The construction bound is checked per pair.** The Design compares the mean recall with
   the mean bound. The check also requires every relational pair to reach its own bound,
   and names any pair that does not. That is stricter, and on this run it made no difference.
5. **The shortest-path cut is in TypeScript.** The Cypher returns every in-session path of
   at most two hops from a question concept to a mentioned concept. `assembleExplanations`
   keeps the shortest per mentioned concept, deduplicates a path seen in both directions,
   orders and cuts. The ordering rule is then unit-tested without a store. A path's order
   key interleaves edge types with ids, because two paths over the same concepts with
   different types would otherwise tie.
6. **The explainer's spans reuse existing attribute keys.** `memory.neo4j.explain` sets
   `seedEntityCount`, `factCount` and `resultCount`. `memory.neo4j.linkQuestionConcepts`
   sets `conceptCount` and `resultCount`. All are counts, and all were already in
   `ALLOWED_SPAN_ATTRIBUTES`, so the allowlist is unchanged.

## Stage 2's code, and the run that remains

Written 2026-10-08, with no `generateContent` call. Stage 2 has not started, and the rule
selects no row until it has.

- **The prompts.** `planNode` now calls `buildPlanPrompt`, whose bytes are unchanged and
  pinned. `explanation-prompt.ts` takes `without` from it, and makes `with` by placing
  `renderExplanationBlock`'s block after the context and before the instruction.
- **The answer file**, `answer-file.ts`. `recordAnswers` writes after every call through a
  rename, and never asks a recorded (query, condition) again. It refuses a file recorded
  for another prompt, model, dataset, label set or selection, and it holds a pid lock. It
  stops without recording on a per-day 429, or on a 429 the client could not retry past.
  `replayAnswers` serves the file with no key and refuses the same mismatches.
- **The graders and the rule**, `explanation-answers.ts` in `eval-harness`:
  `selectStage2Queries`, `answer_key_present`, `bridge_named`, the paired bootstrap and
  `applyAnswerRule`. The rule is applied only once all 76 answers are recorded.
- **The runner.** `runStage2` in `run-explanation.ts` runs after a good stage 1 and
  replays by default, failing on any request to the model host. With no answer file the
  stage-1 report is unchanged.

**The dry run.** On 2026-10-08 the real runner ran against empty `pgvector:pg16` and
`neo4j:5-community` containers. `fetch` was replaced by a fake Gemini API, so no request
left the process, and the fake logged a hash of every prompt it answered.

1. Replay with no answer file and no key selected 38 queries and found 0 of 76 answers.
   The stage-1 JSON and Markdown equalled the committed reports once timestamps were
   masked.
2. Record with no budget, at 1.5 s a call, was killed with `SIGKILL` after 11 answers. The
   dead process left its lock behind.
3. Record with a budget of 8 took over the dead lock. It finished the query the kill had
   split, recorded three more whole queries, and stopped on the budget, at 18 answers.
4. Record with the fake sending a per-day 429 after 5 calls recorded 5 answers, stopped
   and exited 1, at 23 answers.
5. Record to completion recorded 53 answers, 76 in all. One more invocation made no
   request.
6. Two replays with no key made no request, and their reports were identical once
   timestamps were masked. The fake's answers grade 0 in both conditions, so the rule read
   `not met`. That shows only that the arithmetic runs.

The file held 76 answers, each (query, condition) once, over four invocations. The fake
answered 77 prompts and sent one 429. The only prompt it answered twice was
`relational-012/with`, the call in flight when the process was killed, whose first answer
was never written. No recorded answer was asked for again. The report names the two pairs
split across invocations: `relational-012` by the kill and `relational-020` by the 429.

**The command**, once per Pacific day. It reseeds the stores from empty, so any throwaway
pair of containers will do:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentdb \
NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=password \
GOOGLE_API_KEY=<key> EVAL_ANSWERS_MODE=record EVAL_STAGE2_MAX_CALLS=8 \
yarn eval:explanation
```

Exit 0 means the day's slice was recorded, and 1 means a 429 stopped it early: what was
recorded is kept, and the next day resumes. After each day, commit `explanation-answers.json`
from `recorded/` beside the embeddings. After the last, run the same command with
`GOOGLE_API_KEY=` empty and no mode, which replays. Commit the four files it writes under
`apps/agent-service/eval-results/` into `reports/explanation/`.

**The schedule.** Eight calls a day is four whole queries, in the order the answer file's
header fixes:

| Day | Queries                                                        | Calls | Answers after |
| --- | -------------------------------------------------------------- | ----- | ------------- |
| 1   | relational-003, relational-005, relational-009, relational-010 | 8     | 8             |
| 2   | relational-011, relational-012, relational-013, relational-014 | 8     | 16            |
| 3   | relational-015, relational-016, relational-018, relational-020 | 8     | 24            |
| 4   | relational-021, relational-022, relational-023, relational-024 | 8     | 32            |
| 5   | relational-025, relational-026, relational-027, relational-028 | 8     | 40            |
| 6   | relational-029, relational-030, relational-031, relational-032 | 8     | 48            |
| 7   | relational-033, relational-034, relational-035, relational-036 | 8     | 56            |
| 8   | relational-038, relational-039, relational-040, relational-041 | 8     | 64            |
| 9   | relational-042, relational-046, relational-047, relational-048 | 8     | 72            |
| 10  | relational-049, relational-050                                 | 4     | 76            |

The nightly takes about 11 calls at 03:00 UTC, which is the evening of the Pacific day
(20:00 PDT, 19:00 PST), so a slice of 8 leaves 19 of the 20 used whenever it runs that
day. A day that P3-D or P4-B records on is skipped, and the table shifts by a day.

Where stage 2's code differs from the Design:

1. **The 38 are recomputed, not read.** The Design says the list "is printed" from P2-B's
   committed run, but that report keeps aggregates and no per-query ranking. The runner
   retrieves again over the recorded vectors and refuses any count but 38. The answer
   file's header pins the list on its first write.
2. **A pair stays in one invocation where the recorder can choose.** The Design asks for
   both calls of a query in the same invocation. The budget never splits a pair, but a
   429 or a kill can. The next invocation finishes that query first, and the report names
   it.
3. **Eight a day for ten days, not eleven for seven.** The Budget section counted the
   nightly at 9 calls; the quota table in `.context/conventions.md` counts 10 to 11.
4. **The answers are cassette decisions in one file, not cassettes.** Each answer is a
   format-2 `Decision` built by `buildDecision` over `calls.plan`. Its `requestHash` is the
   prompt sha256 the Design keys on, and the hash a cassette would give the same call. A
   cassette is one trial written when it ends, and this recording has to survive ten days
   and a kill. Committed, the file makes replay keyless and re-scoring free.
5. **Calls are paced 13 seconds apart**, under the free tier's five a minute, so the
   client's 429 retry is not what paces them.
6. **`context <n>` counts positions.** `plan`'s context lines carry no number, and
   `without` must stay byte-identical to `planNode`'s prompt, so the model has to count.
7. **The `with` block explains nearly every retrieved fact.** Building the prompts, the
   explainer returned a path for all ten retrieved facts in 32 of the 38 queries, and for
   the answer fact in all 38. That is the `reflect` shape's over-linking again: the gold
   path is in the block, among about twenty others. It is recorded before any answer
   exists, so it cannot be used afterwards to explain a `not met` or to discount a `met`.

## Risks and open questions

**Open questions, decided at review 2026-10-08.**

1. **The thresholds.** Recall 0.70 and precision 0.50 in stage 1, and +0.10 in stage 2, are
   this draft's proposals. They have to be agreed before acceptance, because agreeing them
   after a run is what pre-registration prevents. _Decided: agreed as proposed._
2. **Stage 2's budget.** Seven days of spare free-tier quota, shared with P3-D and P4-B, or
   one sitting on a billed key. Only stage 1's outcome makes this real. _Decided: the free
   tier_, scheduled against the quota table in `.context/conventions.md`; a billed key is the
   owner's decision and is not assumed.
3. **P2-E as a separate PRD.** The alternative folds the outcome into this one and makes it
   an `L` whose second half depends on a number nobody has. This draft splits them, so that
   each review covers one kind of change. _Decided: split._ P2-E enters the index as a draft
   and is drafted only once this PRD's rule has selected an outcome.
4. **M1 extended to edges.** P4-B's text scopes `:Fact` only. This draft adds per-session
   `MENTIONS` and `RELATES_TO`, because an explanation returns the edges it crosses. The
   reviewer should confirm that, or reject it and accept that explanations cross sessions.
   _Decided: edges are session-scoped._ An explanation that crosses sessions is the leak P4-B
   exists to close, reached by a different reader.

**Risks.**

- **Session-scoped edges shrink the graph a request can explain from.** The corpus is one
  session of 52 episodes, which models a long-lived session. In production a session's
  graph holds only what that session's runs extracted, and a new session's graph is nearly
  empty. A `keep` outcome therefore holds for long sessions on a corpus like this one. The
  ADR has to say so, and stage 1 cannot show the effect.
- **A stage-1 pass is weak evidence.** The extractor is an oracle and the linker is helped
  by the strata construction (Design). Stage 2 is the evidence that could keep the graph.
  The ADR names both advantages, so a reader can discount a pass.
- **n = 50 decides how often the answer is `inconclusive`.** With per-pair sd 0.4, the
  interval's half-width is about 0.11. Recall needs a point estimate near 0.81 to clear 0.70,
  and precision needs one near 0.61 to clear 0.50. Stage 2 at n = 38 has low power for
  +0.10. Both biases run toward C, which ADR 0009 makes the default. They are stated here so
  that the ADR does not report "not met" as "harmful".
- **The label linker reads global labels.** Another session's `mergeEntity` can rename a
  concept, which changes what the linker matches. It cannot change what the explainer
  returns. The measurement database has one session. Under keep, P2-E owns it, together with
  P4-B's per-session identity question.
- **M1's extension is wasted under C.** About a day of writer, constraint and test changes.
  It is accepted because the measured query must be the one that would ship. P2-B's rule
  against measuring a copy applies here.
- **The answer key is lexical.** An answer that is right but phrased in a form the key does
  not list fails `answer_key_present` in both conditions equally. That lowers both rates and
  leaves the paired difference unbiased. The alternatives are authored up front to limit it.
- **Sizing.** `M`, as the index has it, for stage 1, M1, the ADR and the P2-E specification.
  Stage 2 adds about a day of code and about a week of calendar if it runs. The explainer is
  new Cypher over a graph shape that `expandFromSeeds` never exercised. That is why the
  construction check comes before any number.

## References

- ADR 0009, "The second store, after the retrieval ablation": the role, the measurement and
  the fallback.
- P2-B, "Hybrid retrieval evaluation and the graph/vector/hybrid ablation": the corpus, the
  pre-registration practice and the bootstrap.
- NIST AI RMF 1.0, MEASURE 2.9: the model is explained, validated and documented, and its
  output is interpreted in context.
- Xian et al., "Reinforcement Knowledge Graph Reasoning for Explainable Recommendation",
  SIGIR 2019: paths over a knowledge graph as the explanation of a retrieved item.
- Efron, Tibshirani, _An Introduction to the Bootstrap_, 1993: the percentile interval.
- Neo4j Cypher Manual, shortest paths: `SHORTEST` and `shortestPath()` for the bounded search.
