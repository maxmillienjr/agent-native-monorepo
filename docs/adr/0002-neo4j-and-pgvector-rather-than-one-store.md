# 0002 · Neo4j and pgvector rather than one store

**Status:** superseded by [0009](0009-the-second-store-after-the-retrieval-ablation.md)
**Date:** 2026-08-28

## Context

Semantic memory needs to answer two different kinds of question. "What do I know that is
worded like this?" is a similarity question. "What is connected to this, and how?" is a
traversal question.

A single store can be made to serve both, badly. pgvector alone cannot follow an explicit
relationship chain; it can only find text that embeds nearby. Neo4j alone — even with its
vector index — misses paraphrase when no relationship was ever extracted between the
concepts involved.

Running both is a real cost: two clients, two failure modes, two backup stories, two things
to provision in CI, and a merge step that has to reconcile two ranked lists.

## Decision

Run both, and merge with Reciprocal Rank Fusion (`k = 60`).

RRF over score normalization because the two sources produce incomparable scores — cosine
distance and graph proximity are not on the same scale, and any attempt to normalize them
into one is a tuning parameter pretending to be a principle. RRF only needs rank, so it
sidesteps the question.

## Consequences

The cost of a second store is accepted in exchange for two independent recall paths, on the
theory that their failure modes are uncorrelated and the union has meaningfully higher
recall than either alone.

**That theory is currently unmeasured, and this record should be read as provisional until
it is.** P2-B builds the ablation — graph-only, vector-only, hybrid, each reported with
`Recall@k`, `MRR`, and `nDCG` alongside token cost and latency. If hybrid does not beat the
better single store by a margin that justifies the operational cost, this decision is
wrong and gets superseded rather than defended.

Two known defects must be fixed before that measurement means anything, both tracked in
P2-A:

- The fusion key in `retrieval-facade.ts` is `entityId ?? content`. Neo4j candidates always
  carry `entityId`; pgvector candidates never do. The same fact arriving from both sources
  is therefore keyed differently and its scores are never summed — the current
  implementation interleaves rather than fuses.
- Vector search applies no session filter, so retrieval crosses session boundaries.

Until both are fixed, any ablation would be measuring the bug rather than the architecture.
