# 0009 · The second store, after the retrieval ablation

**Status:** accepted
**Date:** 2026-10-08
**Decided:** 2026-10-08, by the repository owner: option B, with C as its fallback
**Supersedes:** [0002](0002-neo4j-and-pgvector-rather-than-one-store.md)

## Context

[ADR 0002](0002-neo4j-and-pgvector-rather-than-one-store.md) runs Neo4j beside pgvector "on
the theory that their failure modes are uncorrelated and the union has meaningfully higher
recall than either alone". It calls itself provisional until that is measured, and it
commits to being superseded "if hybrid does not beat the better single store by a margin
that justifies the operational cost". [ADR 0004](0004-one-candidate-universe-for-fusion.md)
made fusion real by giving both readers one universe of facts. It left the measurement
open.

[P2-B](../prd/P2-B-retrieval-ablation.md) is that measurement. It is a retrieval-level
benchmark: 200 hand-written queries, 50 in each of four strata, over a corpus of 335 facts
in 52 episodes of fictional payer operations. Labels and gold seeds were committed before
any vector existed. Embeddings are recorded, so the run needs no key. The conditions are
built from the classes the service constructs, over live stores reset and seeded through
memory-core. The decision rule was accepted with the PRD, before any number existed:

- **Metric.** Recall@10 over all 200 queries, on the pre-registered labels.
- **Hybrid earns its keep** if it beats the better of `vector` and `graph` by at least +0.05
  and the 95% paired bootstrap's lower bound is above 0.
- **It does not** if the upper bound is below +0.05. Otherwise the result is inconclusive.
- **The same rule** decides the diagnostic pair, `hybrid·oracle` against the better of
  `vector` and `graph·oracle`. That pair is the same comparison with the seed linker
  replaced by the gold seeds a perfect linker would return.

This record reports the outcome the rule selected, sets out what to do about it, and
recommends one option. Which store to keep is this record's decision. It was written as
`proposed`, and the owner accepted the recommendation; the Decision section records that and
the code change that followed.

## The measurement

The report is committed as `reports/adjudicated/ablation-summary.md` under
`packages/eval-harness/datasets/retrieval-ablation/`. It was produced by
`yarn eval:retrieval` on memory `live` and embeddings `recorded`, from dataset sha256
`46e6f4b5…17bdc`. Two runs from empty stores produced byte-identical reports once
timestamps and latencies were masked.

| Condition                | Recall@10 | nDCG@10 | MRR   | Relational R@10 | Empty |
| ------------------------ | --------- | ------- | ----- | --------------- | ----- |
| `vector`                 | 0.940     | 0.845   | 0.815 | 0.760           | 0%    |
| `graph`                  | 0.000     | 0.000   | 0.000 | 0.000           | 100%  |
| `hybrid`                 | 0.940     | 0.845   | 0.815 | 0.760           | 0%    |
| `graph·oracle`           | 0.385     | 0.180   | 0.119 | 0.120           | 19%   |
| `hybrid·oracle`          | 0.795     | 0.577   | 0.508 | 0.180           | 0%    |
| `hybrid·oracle·per-fact` | 0.795     | 0.638   | 0.588 | 0.180           | 0%    |

| Pair       | System          | Better baseline | Δ Recall@10 | 95% interval     | Rule     |
| ---------- | --------------- | --------------- | ----------- | ---------------- | -------- |
| Primary    | `hybrid`        | `vector`        | 0.000       | [0.000, 0.000]   | does not |
| Diagnostic | `hybrid·oracle` | `vector`        | −0.145      | [−0.195, −0.095] | does not |

**The rule selects the row "neither does": the premise did not hold on this data.** The
primary pair is not a loss, because `hybrid` equals `vector` exactly. The diagnostic pair
is a loss, because its whole interval is below zero.

**Adjudication does not change the outcome.** A separate agent session judged the 3,029
pooled, unlabelled candidates blind. That session was `claude-opus-5-5`, a model and not a
domain expert. It added one relevant pair: a relational query about Brightwater Select PPO
now also counts the fact that the plan delegates prior authorization review to Kestrel.
Under the adjudicated labels `vector` and `hybrid` both score 0.943. The two intervals are
unchanged to three places, and the rule selects the same row.

### Why the deployed hybrid is the vector path

**The seed linker reaches nothing in the graph.** `retrieve` derives seed ids by keeping
capitalized words longer than two characters, lowercasing them and deleting every character
outside `[a-z0-9-]` (`retrieve.node.ts#extractSeedEntityIds`). The live extraction names
entities in `snake_case` with a type prefix. The corpus follows that convention, which is
the only evidence of what production writes. The linker produced ids for 150 of the 200
queries. None of those ids is a concept in the graph. `graph` returned nothing on every
query, and `hybrid` fused the vector list with an empty one. A multi-word name cannot match
either way: `Prior Authorization` becomes `["prior", "authorization"]`. `graph-recall-001`
shows the path works when an id happens to be one word, such as `langgraph`. It is the
exception the linker allows, not the rule.

### Why the graph lowers recall even with a perfect linker

**The graph ranks by hop distance and nothing else.** Every fact one hop from a seed scores
the same `0.5`, and within that tie the order is the order of content hashes. `reflect`
links every fact of a run to every entity of that run, so one seed reaches every fact of
every episode that mentions it. The reader's `LIMIT 50` was full at distance two on most
queries. That is why `hopDepth` 1, 2 and 3 produced identical numbers.

**RRF then gives that list the same weight as the vector list.** At `k = 60`, rank 3 of a
hash-ordered graph list counts exactly as much as rank 3 of a cosine-ordered vector list.
The graph's distance-one facts displace the vector path's correct answers from the top ten.

**The tie order is not the cause.** Re-sorting the graph's ties under 20 salts moves
`hybrid·oracle` only between 0.780 and 0.815 Recall@10, all of it well below `vector`.

**The stratum built to favour the graph is where fusion loses most.** In relational
queries, A is named and the answer mentions only B, one edge away. There `hybrid·oracle`
scores 0.180 against `vector`'s 0.760.

**Linking each fact only to its own entities does not fix the ranking.** The per-fact
graph's `graph·oracle·per-fact` reaches 0.530. `hybrid·oracle·per-fact` stays at
Δ −0.145 against `vector`.

**The graph found little that the vector path missed.** Over the two lists the facade
fuses, the oracle graph on the per-fact shape found 3 relevant facts that the vector list
missed. All 3 are relational, out of 201 relevant pairs. On the shape `reflect` actually
writes it found none. The union of the two lists recalls 0.985 to 1.000 of the relevant
facts, but RRF does not deliver that union to the top ten. The failure modes are less
uncorrelated than ADR 0002 assumed, and fusion does not exploit what difference there is.

### What this measurement does not show

**Scope.** It is one synthetic corpus, written and labelled in a single session by one
model, and adjudicated by another model. It measures retrieval, not answers. It measures
RRF at `k = 60` with this graph ranker, not fusion in general or a graph ranker that scores
anything but distance.

**Headroom.** `vector` is at 0.940 overall, so the most any hybrid could gain on the
pre-registered metric was 0.060, close to the margin itself. The relational stratum is
where headroom existed: 0.760 for `vector`.

**Scale.** Vector search here is exact (ADR 0006). An approximate index at a scale where
its recall falls below 1 is a different vector path, and it was not measured.

## Options

### A · Keep both stores, and narrow the claim to what was measured

Retrieval stays as deployed. `README.md`, `docs/STATUS.md` and ADR 0002's successor stop
saying that the union improves recall. Instead they say the graph is written, is queried
on every run, and on the deployed path contributes nothing to retrieval.

- **Evidence for.** It is the cheapest change. The graph is written today, so any future
  measurement has live data to work with.
- **Cost.** The operational cost ADR 0002 accepted stays, and it now buys nothing measured:
  two clients, two failure modes, two backup stories, and a second CI service container.
- **Risk.** The read path stays as it is. P4-B found that it returns another session's facts
  through the graph (`P4-B-memory-poisoning-red-team.md#Problem`). Keeping it keeps that
  leak's read side open until P4-B's M1 lands. The leak is narrow only because the linker
  is broken.

### B · Demote Neo4j from retrieval to a role the ablation did not measure

The facade stops fusing the graph's list, and retrieval is vector-only. `reflect` keeps
writing concepts, relationships and facts to Neo4j. The graph is kept for what a graph can
do that ranked retrieval cannot. Its candidate role is **explanation**: answering, for a
retrieved fact, which concepts it mentions and how they connect to the concepts in the
question.

- **Evidence for.** The read path measurably lowers recall when it works, and is a no-op
  when it does not. Removing it is a change toward what was measured. It also closes the
  graph half of P4-B's cross-session leak without waiting for M1.
- **Cost.** The second store's operational cost stays, for a role that is itself unmeasured.
  That is the trap ADR 0002 fell into, so this option is only honest with a named
  measurement and a fallback. Provenance — which run and episode wrote a fact — is not a
  graph role. `semantic_facts` already carries `episode_id` and `session_id`.
- **What would measure the explanation role.** A labelled set of (question, answer fact,
  gold concept path). Score the paths the graph returns for path precision and recall, and
  then, only if that is good, an answer-level comparison of `plan` with and without the path
  in its prompt. Until that exists, the graph is `stubbed` in `docs/STATUS.md`. If nothing
  measures it, the fallback is option C.

### C · Remove the graph retrieval path

The facade, `CypherNeo4jReader` and the seed linker go. The natural next step removes Neo4j
from the stack as well: the client, the constraints, the compose and CI services, and the
`:Fact` copy that ADR 0004 introduced.

- **Evidence for.** It is the outcome the rule's row describes most directly. It retires the
  largest operational cost the repository carries for one feature, and it removes the
  cross-session leak altogether.
- **Cost.** It is the largest change. It deletes `graph-recall-001` and P2-B's `graphFacts`
  seed format, and it turns P4-B's M1 into a deletion rather than a filter. It also throws
  away the only signal the ablation found — three relational facts that only the graph
  reached. Rebuilding the graph later means re-ingesting every run, because `reflect` would
  stop writing it.
- **What it gives up.** The README presented the two-index design as the repository's
  architectural differentiator. Removing it makes the claim simpler and true.

## Recommendation

**Option B**, with C as its stated fallback.

The measurement answers the question ADR 0002 asked about retrieval, and the answer is no,
twice. On the deployed path the graph adds nothing. With a perfect linker it lowers recall
by 0.145. A component that lowers recall when it works should not be in the fused list.
Taking it out turns `hybrid = vector` from an accident of the linker into a decision, and it
closes the graph side of P4-B's leak as a side effect.

The case against going straight to C is narrow but real. The graph found three relational
facts the vector path did not, which is the one place the premise showed any signal, and a
graph ranker that is not distance-only was never measured. Keeping the writes keeps that
question answerable without a re-ingest. It is only honest with the two conditions above:
the graph is marked unmeasured, and if no PRD measures the explanation role, C follows.

## What a positive result would need

A future PRD that wants the graph back in retrieval measures it as a new condition against
this baseline, with its own pre-registered rule. It does not edit this one. It would need:

- **A linker that can produce graph ids.** That means matching query text against stored
  concept labels and ids, not deriving ids from capitalization.
- **The linker fix to land after P4-B's M1.** Every concept the linker can reach is another
  route by which the graph returns other sessions' facts, until `expandFromSeeds` is
  filtered by session
  (`P4-B-memory-poisoning-red-team.md#Risks and open questions`). A linker fix that lands
  first widens the leak.
- **A graph ranker that is not hop-distance-only.** For example, it could re-score reachable
  facts by their similarity to the query before fusion. Or it could use a fusion that does
  not give a hash-ordered list equal weight, such as weighted RRF or a graph list only as a
  re-ranker of the vector list. Per-fact `MENTIONS` alone was measured and is not enough.
- **A rule set where there is headroom.** At 0.940 overall, +0.05 is nearly the ceiling. A
  successor should pre-register a relational-stratum rule or a corpus where the vector path
  is not near ceiling, before it sees a number.
- **An answer-level ablation only after a retrieval-level gain.** P2-B kept it unowned for
  that reason.

## Decision

**Option B.** The repository owner accepted the recommendation on 2026-10-08. Retrieval is
vector-only. `reflect` keeps writing concepts, relationships and `:Fact` nodes to Neo4j,
unchanged, for an explanation role that has not been measured. `docs/STATUS.md` marks that
role `stubbed`.

**The fallback is option C, and this is its condition.** P2-D owns the explanation role. It
either measures it, with a rule fixed before the run as P2-B's was, or it removes the graph.
C follows if P2-D's measurement does not meet its own rule, or if P2-D is closed without
one. In either case the second store's cost has stopped buying anything that was measured.
A future PRD that wants the graph back in _retrieval_ is a different question. It measures
a new condition against P2-B's baseline, as "What a positive result would need" sets out.

**What the change deleted, moved and kept.**

- **Deleted from the request path.** `HybridRetrievalFacade` is replaced by
  `VectorRetrievalFacade`, which validates the query and returns the session-scoped pgvector
  search in the reader's order, at `topK` rather than the `2 × topK` that fusion
  over-fetched. `MemoryModule` no longer constructs a graph reader. `retrieve` no longer
  derives seed ids. The retrieval query and `RunRequest.config` lose `hopDepth`, and the
  query loses `seedEntityIds`, because nothing reads them. A knob that is validated and then
  ignored is a defect this repository has already removed once.
- **Moved to their one caller.** The seed linker moved into the ablation runner, as
  `eval/seed-linker.ts`, frozen as it was deployed. `rrfMerge` moved into
  `@repo/eval-harness`. The fused path is reproduced in the runner as `fusedRetrieve`. That
  keeps `yarn eval:retrieval` runnable as a historical measurement of the design this record
  retires. It is the reason the code was moved rather than deleted.
- **Kept in `memory-core`.** `CypherNeo4jReader` stays, exported and integration-tested, and
  is not wired into the service. The ablation needs it, and so will P2-D's explanation
  measurement, which reads the graph. Deleting it now would mean writing it again for that
  measurement. Option C deletes it.
- **Kept unchanged.** Every graph write (`mergeEntity`, `mergeRelationship`, `mergeFact`),
  the constraints, the driver, and the compose and CI services. P2-B's `graphFacts` seed
  format stays, because the ablation seeds its corpus through it.

## Consequences

This record supersedes ADR 0002. The decision to run both stores _for retrieval_ is
replaced by option B, and ADR 0002's status line and index row read `superseded by 0009`.

**ADR 0004 is not superseded, but on the request path it is now moot.** It gave both
readers one universe of facts so that fusion could happen, and no request fuses any more.
The `:Fact` copy it introduced is still written by `reflect`. That duplication now pays for
three things: the ablation's reproducibility, the explanation role P2-D measures, and the
option of measuring a graph condition later without re-ingesting every run. If C follows,
the `:Fact` copy goes, and a record that removes Neo4j supersedes 0004 as well.

**`graph-recall-001` is deleted**, with its cassette and its four cells in P1-D's replay
baseline. The task existed to prove that a fact only the graph held reached `plan`'s prompt,
and under this decision no graph fact can. It was not converted into a negative task,
asserting that the graph is absent, for two reasons. A converted task changes `plan`'s
prompt, so it needs a live re-record, and the free-tier quota was exhausted on the day of
the change. And the property is a fact about retrieval, not about the model, so it is held
without a model call. `retrieval-facade.integration.test.ts` checks that a fact the graph
reaches is not returned, and `retrieval-facade.test.ts` checks that the facade returns the
vector reader's list unchanged. The other two tasks never had a graph fact in their
context, so their cassettes replay unchanged without a re-record. The
`retrieved_from_source` grader went with the task, because the task was its only user.

**P4-B's cross-session leak is closed on the read side.** Its graph session filter (M1) is
no longer needed by any request. It moves to P2-D, which owns any future graph read. M2,
the refusal of an unscoped query, and M3, `distill` reading user turns only, stay with P4-B.

**`yarn eval:retrieval` stays runnable and still runs in no pipeline.** Its `vector`
condition is what a request gets today. Its `graph` and `hybrid` conditions measure the
design this record retired. P2-D also owns the question of whether the ablation belongs in a
CI tier.

**The README's claim is now simpler and true.** The two-index design was presented as the
repository's architectural differentiator. What the repository now shows is a premise that
was measured, did not hold, and was acted on.
