# 0006 · A deterministic retrieval order over the vector index

**Status:** accepted
**Date:** 2026-09-26

## Context

Both semantic readers produce tied scores by construction. `expandFromSeeds` scores a fact
as `1.0 / (1.0 + distance)` on hop distance alone, so every fact the same number of hops
from a seed ties. `searchByCosine` orders on cosine distance, and the eval harness seeds
every fact in a task with one vector, so every seeded row ties against any query. An
`ORDER BY` that stops at the score leaves the tied rows in whatever order the store holds
them, and that order is not a contract: the test added in #44 reseeds twelve tied facts
concurrently, and Neo4j returned 20 distinct orders over 20 delete-and-reseed cycles, with
the pgvector half moving under the same conditions.

The order is an input to the agent, not a presentation detail. `rrfMerge` reads list
position as rank, `retrievedContext` carries the merged list into `plan`'s prompt, and a
P1-B cassette is looked up by a hash over that prompt
([ADR 0005](0005-decision-seam-rather-than-transport-for-replay.md)). An untied order is a
prompt that can differ between two trials over identical seeded data, and a replay that
misses for that reason fails a trial the agent did not fail.

`3b696d5` (#44, 2026-09-10) fixed both readers by adding the content hash as a secondary
sort key. On the Neo4j side that is free — the query already sorted its traversal result
in memory before `LIMIT 50`, so there was no index-provided order to lose. On the pgvector
side it is not free, and the commit did not say so. This
record is written after the fact because the cost is not visible from the code: the query
reads the same with or without an index behind it.

## Decision

Retrieval order is total and a function of the stores' contents only. Both readers order on
their score and then on the content hash, which is unique in both stores — the primary key
of `semantic_facts`, and the `:Fact(contentHash)` uniqueness constraint in Neo4j.

```sql
ORDER BY embedding <=> $1::vector, content_hash
```

pgvector's HNSW index can return rows in `<=>` order and in no other, so a two-key
`ORDER BY` is not something it can serve. The planner's answer is a sequential scan and a
top-N sort, and `SET enable_seqscan = off` does not change it — no plan that uses the index
is available. **At HEAD, `semantic_facts_embedding_hnsw` serves no query**: the two strings
in `pgvector.reader.ts` are the only `<=>` in the repository, and both carry the tiebreaker.
Determinism was bought with the index, deliberately.

The index stays. Two of the three replacements under "When to revisit" need it back, so
removing it is a migration likely to be undone, and at this repository's scale its cost is
index maintenance on each insert.

## The measured trade

Measured during #44 on 2026-09-10, per the working notes: at 50,000 rows the query without
the tiebreaker ran as an HNSW index scan in 0.7 ms, and with it as a sequential scan plus
a sort in 183 ms, still a sequential scan with `enable_seqscan = off`.

Re-measured for this record on 2026-09-26: `pgvector/pgvector:pg16` (the compose image,
PostgreSQL 16.15, pgvector 0.8.6), the table and both indexes exactly as
`0001_semantic_facts.sql` defines them, 50,000 rows of uniform random 768-dimension vectors
across ten sessions, HNSW at its defaults (`ef_search` 40), `LIMIT 20` because the facade
asks each reader for `topK * 2`. Times are `EXPLAIN (ANALYZE)` medians of seven runs; a
bracketed count means fewer runs, and a range is all of them.

| Query                                               | Plan                                 | Time           |
| --------------------------------------------------- | ------------------------------------ | -------------- |
| Cross-session, distance only (before #44)           | HNSW index scan                      | 2.6 ms         |
| Cross-session, distance then hash (HEAD)            | Seq Scan, top-N heapsort             | 173 ms         |
| Cross-session, HEAD, `enable_seqscan = off`         | Seq Scan, top-N heapsort             | 183 ms (3)     |
| Scoped to one of ten 5,000-row sessions, before #44 | `session_id` bitmap scan, top-N sort | 21 ms (1)      |
| Scoped to one of ten 5,000-row sessions, HEAD       | `session_id` bitmap scan, top-N sort | 17 ms (1)      |
| Scoped to one 45,461-row session, before #44        | HNSW index scan                      | 2.0–2.9 ms (3) |
| Scoped to one 45,461-row session, HEAD              | Seq Scan, top-N heapsort             | 159–171 ms (3) |

The two measurements disagree on the fast path's absolute time and agree on everything
else: the plan shapes, the index going unused under the tiebreaker, and a cost of two
orders of magnitude at 50,000 rows. The synthetic vectors are good for plan shape and
timing and say nothing about recall — uniform random vectors are the worst case for HNSW —
so no recall figure is cited here.

The scoped rows matter because scoped is the default. With sessions small against the
table, the planner reaches for the `session_id` index and sorts, tiebreaker or not; the
HNSW index was only ever serving cross-session queries and sessions large enough to be
most of the table. That is P2-B's ablation path, which is where this cost will first be
paid.

## Alternatives considered

**Let the index produce the top k and break ties afterwards.** In the application or in an
outer query, the shape is the same:

```sql
SELECT … FROM (
  SELECT …, embedding <=> $1::vector AS d FROM semantic_facts
  ORDER BY embedding <=> $1::vector LIMIT $n
) s ORDER BY d, content_hash LIMIT 20
```

Measured by inserting a group of rows at one vector into the 50,000-row table in shuffled
order, querying at that vector, and repeating across five delete-vacuum-reinsert cycles:

| Tied rows | Inner `LIMIT` | Distinct result sets over 5 reseeds |
| --------- | ------------- | ----------------------------------- |
| 30        | 20            | 5                                   |
| 30        | 40            | 1                                   |
| 60        | 40            | 5                                   |
| 100       | 40            | 5                                   |

With the inner limit equal to the outer one, the re-sort runs after the cut and cannot
choose which tied rows survive it. Over-fetching to `ef_search` is deterministic while the
tied group fits inside it and stops being deterministic the moment it does not, because an
HNSW scan returns at most `ef_search` candidates and which members of a larger tied group
it reaches depends on a graph built in insertion order. The HEAD query returned the same
twenty rows, the twenty lowest hashes, in every one of these cycles.

The eval harness's tied group is one task's facts, which is small today, so the over-fetch
would pass the current dataset — and that is the reason to reject it. Determinism that holds
below a threshold the data is free to cross is a probe result, not a guarantee, and #44
already declined to rest a cassette on a probe. `retrieval-order.integration.test.ts` ties
twelve facts, below `ef_search`, and would pass against this alternative too. The shape also
fails with no ties at all, once the index is rebuilt — see Consequences.

**Raise `hnsw.ef_search`.** Moves the threshold; does not remove it.

**Stop the fixtures from tying.** Jittering the seeded vectors makes the dataset produce no
ties without making the reader's order defined. The first real tie — or the Neo4j reader,
which ties on hop distance regardless of vectors — brings the problem back, with a green
determinism test that measured nothing.

**Canonicalize the order in the cassette key instead.** ADR 0005 rejected keying on a
normalized shape: the model saw the order it saw, and a key that ignores it replays one
prompt's answer for another. Sorting `retrievedContext` by hash before building the prompt
would discard the relevance order `plan` is given.

**Drop the index.** Honest about the read path, but see the decision: most of the ways out
of this trade need it.

## Consequences

**pgvector retrieval is exact, and linear in what it scans.** The cross-session path scans
the table; the scoped path scans the session, as long as sessions stay small against the
table. At this repository's scale — eval fixtures and demo runs, tens to hundreds of rows —
the trade costs nothing: on a 500-row copy of the table the planner chose a sequential scan
for both shapes.

**Exact search removes a second source of nondeterminism, and it is not only ties.** An
HNSW result is a function of the index graph, and the graph is a function of insertion
order and random level assignment. With the table's contents held fixed and the index
rebuilt three times with `REINDEX`, five untied queries through the over-fetch-and-re-rank
shape above each returned three different result sets. Uniform random vectors make that
far worse than real embeddings would, but the property does not depend on the data: any
query whose recall is below 1 can miss a different row after a rebuild. An exact scan under
a total order depends on the table's contents and not on how they got there, which is what
a delete-and-reseed changes.

**The index is maintained and unused.** Every insert pays for it, and `\d semantic_facts`
lists it. `docs/STATUS.md` row 6 records it as `stubbed` rather than `implemented`. The
reason `EMBEDDING_DIMENSIONS` is 768 — pgvector refuses an HNSW index above 2000
dimensions — is now prospective: it keeps the path below open. Do not widen the dimension
without reading this record.

**The migration comment was false and has been corrected.** `0001_semantic_facts.sql` said
the index was what kept `<=>` queries off a sequential scan. The comment was edited in
place, which is safe with this runner and would not be with every runner: Drizzle's
migrator decides what to apply from `meta/_journal.json`'s `when` and records a sha256 of
each file in `drizzle.__drizzle_migrations` without ever comparing it. A database migrated
with the old file and then run against the edited one applies nothing and raises nothing,
and keeps a hash the file no longer produces, which nothing reads. The statements are
unchanged; a statement edit would diverge silently between databases, which is why a schema
change is always a new migration.

**When to revisit.** Either of these reopens it:

- **Scale.** The `memory.pgvector.search` span already times the query. When the
  cross-session table reaches the order of 10⁵ rows — a line drawn here, not measured — or
  that span is a visible share of a run's latency, the exact scan has stopped being free.
- **A replacement that is deterministic with a stated bound.** The measurements above rule
  out the obvious one: over-fetching from the index and re-ranking exactly fixes ties that
  fit inside the fetch and nothing else, because the fetch itself varies with the graph.
  A replacement has to say which of these it is. It can keep the scan exact and bound what
  it scans — the scoped path already does, by session, and a tenant key would do the same
  for cross-session recall. It can make the index build reproducible, which pgvector does
  not offer today. Or it can give up determinism on the serving path while replay pins
  the exact query, and say plainly that the eval then no longer exercises the production
  query. Whichever it is, it ships with `retrieval-order.integration.test.ts` extended to a
  tied group larger than `ef_search` and to a rebuild of the index between reads — the two
  cases the current test does not reach.

The Neo4j half is not part of the trade. Its tiebreaker adds a key to a sort the query was
already doing, and nothing about it changes under either trigger.
