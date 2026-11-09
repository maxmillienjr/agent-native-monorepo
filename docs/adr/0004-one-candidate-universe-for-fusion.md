# 0004 · One candidate universe for rank fusion

**Status:** superseded by [0012](0012-the-graphs-explanation-role-stage-one.md)
**Date:** 2026-08-29

## Context

[ADR 0002](0002-neo4j-and-pgvector-rather-than-one-store.md) chose to run Neo4j and
pgvector together and merge their results with Reciprocal Rank Fusion. Its Consequences
section named the reason fusion was not actually happening:

> The fusion key in `retrieval-facade.ts` is `entityId ?? content`. Neo4j candidates always
> carry `entityId`; pgvector candidates never do. The same fact arriving from both sources
> is therefore keyed differently and its scores are never summed.

That diagnosis is a symptom, and fixing the key would not have fixed fusion. The deeper
problem was that the two readers returned different kinds of object. `expandFromSeeds`
returned `:Concept` nodes — an entity id, a label, a description. `searchByCosine` returned
rows from `semantic_facts` — a fact's text. No key can make two lists intersect when the
same fact cannot appear in both: the graph held no facts to return.

RRF's premise is that two rankers score _the same candidates_ differently. Two rankers over
disjoint universes produce a concatenation, and sorting it by reciprocal rank interleaves
them. That is what the implementation did, and it would have kept doing it under any key.

## Decision

The knowledge graph stores facts as well as concepts, and both retrievers return facts.

`reflect` writes a `:Fact` node keyed on the same `contentHash` — sha256 of the fact text —
that pgvector uses as its primary key, and links it to the concepts it mentions:

```cypher
MERGE (f:Fact {contentHash: $contentHash})
  ON CREATE SET f.text = $text, f.episodeId = $episodeId
WITH f UNWIND $entityIds AS eid
MATCH (c:Concept {id: eid}) MERGE (f)-[:MENTIONS]->(c)
```

`expandFromSeeds` still traverses `:Concept` — that is where the relational structure
lives — but returns the `:Fact` nodes reachable from the seeds within `hopDepth`. The
fusion key becomes `contentHash`, and a fact both paths find is one candidate scored at the
sum of its two reciprocal ranks.

A uniqueness constraint on `:Fact(contentHash)` is installed at boot, because `MERGE`
without one is not an upsert: two concurrent transactions can each fail to find the node
and each create it.

## Consequences

This does not supersede ADR 0002. The decision to run both stores stands, and so does the
choice of RRF over score normalization — the two sources still produce incomparable scores,
and RRF still only needs rank. What changes is ADR 0002's account of _why_ fusion was not
working, which this record replaces: the key was wrong, but the key was not the cause.

The graph now carries every distilled fact, which is duplication — the text lives in
`semantic_facts` and in a `:Fact` node. It is accepted because the alternative is a join
across two stores on every retrieval, and because the graph copy is what makes a fact
reachable by traversal at all.

`:Session` was documented as a node label in `README.md` and `.context/architecture.md` and
was never written by anything. It is removed from both rather than implemented; nothing in
the retrieval path needs it, and a documented label with no writer is what this repository
spent Tier 0 removing.

Whether fusing beats either store alone is still unmeasured. ADR 0002 remains provisional
until P2-B's ablation, and this record only makes that measurement meaningful — before it,
an ablation would have been comparing a single store against an interleaving of two.
