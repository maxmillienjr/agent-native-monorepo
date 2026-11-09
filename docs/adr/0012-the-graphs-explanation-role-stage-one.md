# 0012 · The graph's explanation role, after both stages: option C

**Status:** accepted
**Date:** 2026-10-08, with stage 2 and the row the rule selects added 2026-11-09
**Decided:** 2026-11-09, by the repository owner: option C, as the rule selected it
**Supersedes:** [0004](0004-one-candidate-universe-for-fusion.md)

## Context

[ADR 0009](0009-the-second-store-after-the-retrieval-ablation.md) took the graph out of
retrieval and kept it for one candidate role: for a retrieved fact, which concepts it
mentions and how they connect to the concepts in the question. Its fallback is option C,
removing the graph, and its condition is explicit: "C follows if P2-D's measurement does not
meet its own rule, or if P2-D is closed without one."

[P2-D](../prd/P2-D-graph-explanation-or-removal.md) is that measurement, in two stages. Stage
1 is model-free and scores the concept paths the graph returns against gold paths. Stage 2
runs only if stage 1 is `good`. It compares `plan`'s answers with and without the paths, for
76 `generateContent` calls. The rule was accepted with the PRD on 2026-10-08, before any path
existed:

- **Stage 1**, on the decisive condition `explain`, relational stratum, pre-registered labels.
  It is `good` if the 95% lower bound of mean path recall@3 is at least 0.70 and the lower
  bound of mean path precision@3 is at least 0.50. It is `not good` if either upper bound is
  below its threshold, and `inconclusive` otherwise.
- **Stage 2**, only after a `good` stage 1. It is `met` if `answer_key_present` improves by at
  least +0.10 with the paths and the bootstrap's lower bound is above 0.
- **Only `good` then `met` keeps the graph.** Every other row selects option C.

This record was proposed on 2026-10-08 with stage 1 alone, which selected no row. Stage 2
was recorded from 2026-11-05 to 2026-11-09, and this revision adds it. **Stage 1 is `good`,
stage 2 is `not met`, and the row the rule selects is option C: the graph explains, and
`plan` does not use it.** The owner accepted that outcome on 2026-11-09.

## The measurement

### Stage 1: the paths

**What ran.** `yarn eval:explanation` ran first on the commit that added it, against empty
`pgvector/pgvector:pg16` and `neo4j:5-community` containers, with `GOOGLE_API_KEY` empty. It
made no request to the model host, which the runner checks. The labels were committed on
their own, before any commit with explainer or runner code, as the history of
`explanation-labels.json` shows. Their sha256 is `582b43de…2334`, over dataset sha256
`46e6f4b5…17bdc`. The gold path for each of the 201 (query, relevant fact) pairs is derived
from the construction P2-B's loader enforces. A relational query names A, and its answer
fact mentions some B one `RELATES_TO` edge from A, so the gold is `[A, type, B]`. Every
relational pair has exactly one gold path.

**What the explainer is.** `CypherNeo4jExplainer.explain` is scoped to one session, with no
unscoped form. For each fact the session owns, it returns the shortest paths of at most two
hops from a question concept to each concept the fact mentions. It returns at most three,
ordered by length and then by the interleaved id and type sequence. Question concepts come
from `linkQuestionConcepts`, which matches stored labels as whole words, longest first, with
no model call. The graph is seeded from P2-B's corpus through `PgNeo4jSeedManager`. The
report is committed under `packages/eval-harness/datasets/retrieval-ablation/reports/explanation/`.
It was regenerated once, to print n and `pairsToResolve` for every stratum as the PRD asks.
No score moved, and the explainer did not change.

**The construction check passed on the first run.** On the per-fact graph with the gold
concepts, every relational pair reached its recall bound of 1.000. The explainer was not
changed after the first run. A second run from empty stores was byte-identical once the
two timestamps were masked.

Relational stratum, 50 pairs, 95% percentile intervals over 10,000 resamples:

| Condition                 | Graph shape | Question concepts | Precision@3          | Recall@3             | Hit@1                | Length-0 path first |
| ------------------------- | ----------- | ----------------- | -------------------- | -------------------- | -------------------- | ------------------- |
| `explain` (decisive)      | `reflect`   | linker            | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] | 12 / 50             |
| `explain·oracle`          | `reflect`   | gold              | 0.637 [0.553, 0.723] | 1.000 [1.000, 1.000] | 0.760 [0.640, 0.860] | 12 / 50             |
| `explain·per-fact`        | per-fact    | linker            | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0 / 50              |
| `explain·per-fact·oracle` | per-fact    | gold              | 0.990 [0.970, 1.000] | 1.000 [1.000, 1.000] | 1.000 [1.000, 1.000] | 0 / 50              |

**The rule selects `good`.** Recall's lower bound, 1.000, clears 0.70. Precision's lower
bound, 0.553, clears 0.50. **The rule therefore requires stage 2.** Neither "keep the graph
for explanation" nor option C follows from stage 1 alone.

The other strata are reported and not ruled on. On `explain`, paraphrase precision@3 is
0.543 and entity-distractor precision@3 is 0.410, with recall 1.000 in both. On the 51
no-entity pairs the linker found no concept, and the explainer returned nothing on every
pair.

#### Why recall is 1.000, and why that says little

**The `reflect` shape all but guarantees it on this corpus.** `reflect` links every fact of
a run to every entity the run extracted. The relational construction requires the answer
fact to mention B, so B was extracted in the fact's episode, and the fact is linked to it.
A–B is an edge by construction, so `[A, type, B]` is a path of length 1. Only a length-0
path, or another length-1 path whose ids sort first, can rank above it. No episode in the
corpus extracts enough of A's other neighbours to push it out of the three returned, so
recall@3 measures the construction more than the graph.

**The linker is the oracle here.** `explain` and `explain·oracle` are identical on every
pair. P2-B's loader requires each relational query to name A by its exact stored label, and
a label linker over exact labels finds it every time. That is the advantage P2-D's Design
section named in advance.

**Precision is the number that discriminates, and the corpus favours it.** The wrong paths
are paths to the other entities of the fact's episode: the `reflect` shape's over-linking,
which P2-D measured at about 2.5 concepts per fact against 1.21 mentioned. Twenty-one of
the 50 answer facts sit in an episode that extracted one entity, B alone. Those 21 are
exactly the pairs that score precision 1.
Linking each fact only to what it mentions lifts precision from 0.637 to 0.990. That is what
attribution in the extractor would buy, if the extractor attributed correctly.

#### The PRD's prediction did not hold, and why

P2-D predicted the third row. It expected the length-0 path `[A]`, which the gold excludes, to
rank first wherever A was extracted in the answer fact's run, and so to sink precision.
That happened in 12 of 50 pairs: relational-037 to relational-050, apart from 042 and 043.
These are the program episodes, where a plan, its program and the program's diagnosis code
are extracted together. In the other 38 pairs, the answer fact sits in an episode about B
alone: the vendor, network and clearinghouse episodes, which never extracted A. **The
prediction failed because of how the corpus distributes facts over episodes, not because of
anything in the explainer.** In production one run that discusses A and B extracts both,
and a fact about B is then linked to A. This corpus has fewer such runs than production
would.

### Stage 2: the answers

**What ran.** The 38 relational queries whose answer fact `vector` placed in its top ten,
each asked of `plan` twice: `without`, the prompt exactly as `planNode` builds it, and
`with`, the same prompt plus the `Connections in memory:` block that
`renderExplanationBlock` renders from the explainer's paths. 76 `generateContent` calls on
`gemini-2.5-flash`, through the production client, recorded from 2026-11-05 to 2026-11-09
in six invocations into `recorded/explanation-answers.json`. The first 29 answers spent the
free-tier quota. The last 47 were asked on the owner's paid key, in another GCP project, by
the owner's decision on 2026-11-09, after a probe on that key answered `modelVersion`
`gemini-2.5-flash`. The model id, the client and the prompts are the same for all 76; only
the project and the tier changed. P2-D's "Stage 2, as run" has the day-by-day record.

**Replay reproduces it with no key.** Two runs with `GOOGLE_API_KEY` empty made no request
to the model host, matched each other, and matched the recording run's report in every line
but the model axis (`live` against `replay`), once timestamps were masked. The four reports
are committed under `reports/explanation/`.

| Grader                      | `without` | `with` | with − without | 95% interval     | n   |
| --------------------------- | --------- | ------ | -------------- | ---------------- | --- |
| `answer_key_present` (rule) | 0.895     | 0.816  | −0.079         | [−0.184, +0.026] | 38  |
| `bridge_named` (reported)   | 0.947     | 0.842  | −0.105         | [−0.237, +0.000] | 38  |

**The rule selects `not met`.** It needed a difference of at least +0.10 with a lower bound
above 0. The point estimate is −0.079, and the lower bound is −0.184. The block changed the
answer key's result on 5 of the 38 queries. Four had the key without the block and lost it
with the block (relational-009, 010, 013 and 023), and one gained it (relational-038).
Three missed the key in both conditions, and the other 30 had it in both.

**`not met` is not "harmful".** The point estimate is negative, and it is stated as
measured. The interval includes 0, and P2-D's risks say in advance that 38 pairs have low
power for a difference of +0.10, so the measurement cannot distinguish a small harm from no
effect. What it shows is that the paths did not help by the margin the rule asked for, and
that is all ADR 0009's condition needs.

P2-D recorded one property of the `with` prompts before any answer existed: the explainer
returned a path for all ten retrieved facts in 32 of the 38 queries, so the gold path sat
among about twenty others. That is the `reflect` shape's over-linking, which stage 1 already
measured as precision 0.637. Because it was recorded first, it is not used here to explain
the result.

## The row the rule selects

| Stage 1 | Stage 2   | Outcome      |
| ------- | --------- | ------------ |
| `good`  | `not met` | **option C** |

**The graph explains, and `plan` does not use it.** The explainer returns the right path on
this corpus, under an oracle extractor and a helped linker, and giving those paths to `plan`
did not improve its answers by the pre-registered margin. **Option C follows by ADR 0009's
condition**: P2-D's measurement does not meet its own rule. **P2-E removes the graph**, from
the specification in P2-D's "What P2-E inherits". This is the second row of P2-D's outcome
table, and it was fixed with the PRD on 2026-10-08, before any path or answer existed.

## What this measurement does not show

**An oracle extractor.** Concept ids, edges and per-fact mentions are what the author
wrote. P2-D declined to build the graph by running `distill` over the corpus, so nothing here
measures what the model would extract. The result holds under an oracle extractor only.

**A helped linker.** The query construction names A by its exact label. Real questions
paraphrase. "The silver plan" links to nothing.

**Long sessions only.** The corpus is one session of 52 episodes, and since M1 a session's
explanation reads only its own edges. A new session's graph is nearly empty, so `good` here
holds for a long-lived session on a corpus like this one.

**Answers, beyond this sample.** Stage 2 is 38 queries on one model, with a lexical grader.
It does not show that paths hurt answers in general, as the previous section says, and it
does not show that a better-attributed graph would not help. It measured the graph `reflect`
writes, which is the one that would ship.

**The model it ran on is going away.** Google shuts `gemini-2.5-flash` down on 2026-12-01 and
routes the id to another model (P1-I). Stage 2 finished on 2026-11-09, before that. The
answers cannot be re-asked of the same model afterwards, but replay and re-scoring need no
model: the committed answer file serves them.

## Recommendation

**Accept option C, as the rule selected it, and let P2-E remove the graph.** Nothing in this
record argues for a different row. On 2026-10-08, with stage 1 alone, this record weighed
reading the weak pass as a failure, or as enough, against running stage 2 as
pre-registered, and recommended stage 2, because either shortcut would have changed the
rule after seeing a number. Stage 2 has now run, with no change to the rule, the labels, the
prompts or the explainer.

**Two findings outlast the graph:**

- **M1 was done, and it covered edges.** Every graph write carries its session. `:Fact`
  keeps its first writer, and `MENTIONS` and `RELATES_TO` are per session. Both graph reads,
  the ablation's `expandFromSeeds` and the explainer, are scoped to the session, with no
  unscoped signature. Under C, P2-E deletes it with the graph, and P4-B's M1 becomes a
  deletion, as P2-D's risks accepted.
- **Attribution is the explainer's precision problem.** Per-fact `MENTIONS` moved precision
  from 0.637 to 0.990 on this corpus, and stage 2 measured the `reflect` shape only. A future
  PRD that wants a graph back for explanation starts there, with a labelled extraction set,
  since nothing here measures whether the model attributes facts correctly. It is a
  condition for that PRD, not a fix to this measurement, as ADR 0009 recorded its own for
  retrieval.

## Decision

**Option C.** Accepted by the owner on 2026-11-09, as the pre-registered rule selected it.
The graph's explanation role did not meet P2-D's rule, so ADR 0009's fallback applies: the
graph is removed. **P2-E** executes the removal, from the specification in P2-D's "What
P2-E inherits". Until it lands, `reflect` still writes the graph and no request reads it.

## Whether the two measurements run in CI

**Decided in P2-D: nothing is wired into CI.** Under keep, P2-E adds a reproduction step to
the `replay` job for both commands, compared exactly against the committed reports after
masking. Each needs no key and finishes in under a minute: 37 s and 9 s of wall clock on
2026-10-08. Under C, P2-E archives both: the datasets and committed reports stay, and its
record names the last commit at which each reproduced. After M1, `yarn eval:retrieval`
still reproduces the committed adjudicated report: the JSON is identical once timestamps
and latencies are masked.

**The outcome is C, so P2-E archives both.** The reports `a256784` commits for both stages
were written by `yarn eval:explanation` with no key, and a second such run matched them
once timestamps were masked. P2-E names the last commit at which each command reproduced,
verified by a run on that commit.

## Consequences

**This record supersedes ADR 0004.** ADR 0004 put a `:Fact` copy of every
distilled fact in the graph so that both retrievers returned one universe of candidates.
ADR 0009 made that moot on the request path. Under C the `:Fact` copy goes with the graph,
and ADR 0009's Consequences anticipated that a record removing Neo4j supersedes 0004 as
well. ADR 0004's status line and index row read `superseded by 0012`. Its body is left as
written.

**ADR 0009 is not superseded.** Option C is its stated fallback, and executing it is its
decision.

`docs/STATUS.md` row 15 stays `stubbed` until P2-E removes the graph, because the code
exists and no request reads it. Its text now records the outcome, and its owner is P2-E.
Row 23 records the CI-tier decision above.
