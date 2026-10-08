# 0012 · The graph's explanation role, after stage 1

**Status:** proposed
**Date:** 2026-10-08

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

This record reports stage 1, and what the rule requires next. It is `proposed`. Its Decision
section is written when stage 2 has run.

## The measurement

**What ran.** `yarn eval:explanation` ran on the commit that added it, against empty
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
bound, 0.553, clears 0.50. **The rule therefore requires stage 2, and selects no outcome row
yet.** Neither "keep the graph for explanation" nor option C follows from stage 1 alone.

The other strata are reported and not ruled on. On `explain`, paraphrase precision@3 is
0.543 and entity-distractor precision@3 is 0.410, with recall 1.000 in both. On the 51
no-entity pairs the linker found no concept, and the explainer returned nothing on every
pair.

### Why recall is 1.000, and why that says little

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

### The PRD's prediction did not hold, and why

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

## What this measurement does not show

**An oracle extractor.** Concept ids, edges and per-fact mentions are what the author
wrote. P2-D declined to build the graph by running `distill` over the corpus, so nothing here
measures what the model would extract. The result holds under an oracle extractor only.

**A helped linker.** The query construction names A by its exact label. Real questions
paraphrase. "The silver plan" links to nothing.

**Long sessions only.** The corpus is one session of 52 episodes, and since M1 a session's
explanation reads only its own edges. A new session's graph is nearly empty, so `good` here
holds for a long-lived session on a corpus like this one.

**Answers.** A path that is right is not yet a path that helps. Stage 2 is the only evidence
that could keep the graph, and P2-D's Design calls a stage-1 pass weak evidence for the
three reasons above.

## Options

### 1 · Run stage 2 as pre-registered

Build the stage-2 recorder and replay, then spend the 76 calls: 38 relational queries whose
answer fact `vector` placed in its top ten, each with and without the paths in `plan`'s
prompt. At the 9 to 10 spare free-tier calls a day, that is about eight days of quota, shared
with P3-D's 20-call recording and P4-B's red-team recordings (`.context/conventions.md`,
"Live model quota"). A key in a separate project would make it one sitting, and that is the
owner's decision.

- **For.** It is what the rule says. ADR 0009's condition is that the measurement meets its
  own rule, and only stage 2 can complete it.
- **Cost.** About a day of code (P2-D's Sizing) and about eight days of calendar. Graph
  removal and wiring both wait for it.

### 2 · Read the weak pass as a failure, and take ADR 0009's option C now

- **Against.** It changes the rule after seeing a number, which is what pre-registration
  exists to prevent. The asymmetry the PRD built in, that a stage-1 pass is weak evidence,
  is the reason stage 2 exists, not a reason to skip it.

### 3 · Read the pass as enough, and keep the graph

- **Against.** The same objection, in the other direction. The PRD makes stage 2 "the
  evidence that could keep the graph".

## Recommendation

**Option 1: run stage 2 as pre-registered, and leave P2-D `in-progress` until it has.** The
stage-2 code, `renderExplanationBlock`, the `without` prompt pinned to `planNode`'s, the
resumable answer file and the two graders, is not yet written. It is the next piece of P2-D,
and it lands before any call is spent. Nothing in stage 1 is re-run or changed. P2-E stays a
draft with no file until the rule has selected a row.

**Whatever stage 2 shows, two findings stand:**

- **M1 is done, and it covers edges.** Every graph write carries its session. `:Fact` keeps
  its first writer, and `MENTIONS` and `RELATES_TO` are per session. Both graph reads, the
  ablation's `expandFromSeeds` and the explainer, are scoped to the session, with no
  unscoped signature. A linker that can reach graph ids now exists, and it landed after
  M1, as ADR 0009 required.
- **Attribution is the explainer's precision problem.** Under keep, per-fact `MENTIONS` is
  the change most worth its cost. It moved precision from 0.637 to 0.990 here, and P2-D's
  "Graph shape" prices it at two re-recorded cassettes. It is also what ADR 0004's text
  already says.

## Whether the two measurements run in CI

**Decided in P2-D: nothing is wired into CI.** Under keep, P2-E adds a reproduction step to
the `replay` job for both commands, compared exactly against the committed reports after
masking. Each needs no key and finishes in under a minute: 37 s and 9 s of wall clock on
2026-10-08. Under C, P2-E archives both: the datasets and committed reports stay, and its
record names the last commit at which each reproduced. After M1, `yarn eval:retrieval`
still reproduces the committed adjudicated report: the JSON is identical once timestamps
and latencies are masked.

## Consequences

This record supersedes nothing. ADR 0009 stands, and its fallback is still pending: P2-D has
neither met its rule nor closed without one. ADR 0004 is superseded only if the outcome is
option C.

`docs/STATUS.md` row 15 stays `stubbed`, because no request reads the graph. Its text now
records M1, the explainer and stage 1. Row 23 records the CI-tier decision above.
