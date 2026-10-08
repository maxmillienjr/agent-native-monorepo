# 0009 · The second store, after the retrieval ablation

**Status:** proposed
**Date:** 2026-10-08
**Supersedes:** [0002](0002-neo4j-and-pgvector-rather-than-one-store.md), on acceptance

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
recommends one option. Which store to keep is this record's decision. The code change that
follows from it waits for the decision to be accepted.

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

This record does not make the code change. It waits for acceptance.

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

## Consequences

When accepted, this record supersedes ADR 0002. The decision to run both stores is replaced
by whichever option is accepted, and ADR 0002's index row becomes `superseded by 0009`.
ADR 0004 is not superseded. One candidate universe remains what makes any fusion
measurable, and the ablation could not have run without it.

Until acceptance, nothing changes in code. `docs/STATUS.md` row 15 states the measurement,
and the new row records the ablation as a capability. `README.md` no longer claims that the
union improves recall.
