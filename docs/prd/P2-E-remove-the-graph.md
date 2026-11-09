---
id: P2-E
title: "Act on P2-D's outcome: remove the graph (option C, ADR 0012)"
tier: 2
status: in-progress
size: M
depends_on: [P2-D]
blocks: []
issue: 150
superseded_by: null
---

# P2-E · Act on P2-D's outcome: remove the graph (option C, ADR 0012)

## Problem

ADR 0012 is accepted, and its Decision is option C: "the graph is removed. **P2-E** executes
the removal, from the specification in P2-D's 'What P2-E inherits'. Until it lands, `reflect`
still writes the graph and no request reads it"
(`docs/adr/0012-the-graphs-explanation-role-stage-one.md#Decision`). The rule that selected
it was pre-registered in P2-D. Stage 1 was `good`. Stage 2 was `not met`: over 38 relational
queries, `answer_key_present` was 0.895 without the graph's paths and 0.816 with them,
a difference of −0.079 [−0.184, +0.026], where the rule needed +0.10 with a lower bound above 0
(`packages/eval-harness/datasets/retrieval-ablation/reports/explanation/stage2-summary.md#Decision rule`).
Every fact below was checked on 2026-11-09 at `eb797be`. No model call was made to write
this draft.

**The graph has writers and no reader on any request.** `reflect` merges every extracted
entity and relationship and a `:Fact` copy of every fact into Neo4j
(`apps/agent-service/src/agent/nodes/reflect.node.ts:62-75`, `:95-101`).
`VectorRetrievalFacade` reads pgvector alone (`packages/memory-core/src/semantic/retrieval-facade.ts`,
ADR 0009). The two graph reads, `CypherNeo4jReader` and `CypherNeo4jExplainer`, are called
only by the two evaluation runners, `run-retrieval-ablation.ts` and `run-explanation.ts`.
`docs/STATUS.md` row 15 is `stubbed` for that reason, "until P2-E removes it".

**The store is provisioned in every environment that runs the service.** Neo4j is a compose
service with a volume, and `agent-service` waits on its health check (`docker-compose.yml:18-32`,
`:58-60`, `:77-78`, `:134`). It is a service container in both `agent-eval.yml` jobs that start
stores (`.github/workflows/agent-eval.yml:114-123`, `:253-262`, with the workflow-level
`NEO4J_*` at `:75-77`) and in `e2e.yml`'s integration job (`.github/workflows/e2e.yml:22-26`,
`:46-48`). The memory axis needs both `DATABASE_URL` and `NEO4J_URI`, in the service
(`apps/agent-service/src/memory/memory.config.ts:23-46`) and in the harness
(`packages/eval-harness/src/axes.ts:60`).

**What removal touches, counted at `eb797be`.** `git grep -il neo4j -- . ':!*.md' ':!yarn.lock'`
lists 82 files: 36 in `apps/agent-service`, 23 in `packages/memory-core`, 15 in
`packages/eval-harness`, 2 in `packages/shared-types`, and 6 in the stack. A further 36 files
that do not name Neo4j are part of the same change: the stage-2 code, the ablation's pure
modules, the extraction, a telemetry allowlist and two controls. 44 Markdown files name
Neo4j. "Inventory" in the Design lists every file and what happens to it.

**P2-D's specification is right in substance and short in four places.** Checked against the
tree, every item in "What P2-E inherits"
(`docs/prd/P2-D-graph-explanation-or-removal.md#What P2-E inherits`) exists. Four things differ
from it:

1. **There is no `concepts_merged` grader.** The grader `mergedConceptsMin` builds is
   `entity_merged` (`packages/eval-harness/src/dataset.ts:195`, `:230`;
   `packages/eval-harness/src/graders/code.ts:92-99`). It holds three cells of
   memory-recall's replay baseline (`datasets/memory-recall/baselines/replay.json:9`, `:20`,
   `:30`). It is also the positive control ADR 0011 names: "`memory-recall-001` asserts
   `mergedConceptsMin: 1`" (`docs/adr/0011-the-agent-does-not-promote-its-own-output.md:75`).
   Deleting it leaves no grader that asks whether a run wrote semantic memory.
2. **The cassettes would replay with or without `EXTRACTION_PROMPT`.** P2-D says keeping the
   prompt "keeps the cassettes replayable", and that dropping entities "would cost a
   re-record". The distill seam's request is `{ context }`, the user's turns, and nothing else
   (`apps/agent-service/src/agent/model/decision-seam.ts:81-84`). The prompt is passed beside
   it (`apps/agent-service/src/runs/runs.service.ts:362`) and is not hashed. On 2026-11-09 a
   scratch tree replaced `EXTRACTION_PROMPT` with a different string, and all three suites
   replayed with no `CassetteMissError`. A narrowed prompt therefore costs a re-record
   because `.context/conventions.md` lists `extraction.ts` as a re-record trigger, not
   because replay misses. Nothing would notice if it were skipped.
3. **The `source` enum has two copies, and a field with no producer rides beside it.**
   `shared-types` has `source: z.enum(['neo4j', 'pgvector'])`
   (`packages/shared-types/src/memory.schema.ts:10`). `memory-core` has the same enum on
   `RetrievalCandidateSchema` (`packages/memory-core/src/semantic/retrieval-facade.ts:48`). Both
   carry an optional `entityId` (`memory.schema.ts:14`, `retrieval-facade.ts:53`) that no
   source file sets: `git grep -n "entityId\b"` finds it only in the two schemas and three
   test fixtures.
4. **Places the list does not name:** P3-B's audit replay enumerates three Neo4j write kinds
   (`apps/agent-service/src/audit/captured-writes.ts:12-19`, `replay-report.ts:82-87`). The span
   allowlist has eight keys only graph code sets, and two that count extracted entities and
   relationships (`packages/telemetry/src/genai.ts:151-152`, `:201-214`).
   CTL-EVAL-04's evidence is the ablation's code and tests, and CTL-MEM-02 cites a graph test
   (`governance/controls.yaml:189-227`, `:402-405`). `factsPersistedToBothIndices` is
   exported and unit-tested, and no assertion builds it (`code.ts:102-108`, `dataset.ts:220-238`, `buildGraders`).
   The stage-2 code is four files that do not name Neo4j: `answer-file.ts`,
   `explanation-prompt.ts` and their tests. Five task files besides `rt-001` carry graph seed
   keys. P1-I plans to add `STAGE2_CHAT_MODEL` to `run-explanation.ts` and `answer-file.ts`
   (`docs/prd/P1-I-chat-model-migration.md:309-316`), two files this PRD deletes.

**Removal changes no recorded decision's request. Narrowing the extraction changes one that
the cassettes cannot see.** Checked by running, on 2026-11-09, at `b41ebe6`, whose code
differs from `eb797be` only in a docstring in `neo4j.reader.ts`. Fresh `pgvector:pg16` and
`neo4j:5-community` containers were used, with `GOOGLE_API_KEY=` empty.
`EVAL_CASSETTE_MODE=replay EVAL_GATE=replay yarn eval` reported `match` on memory-recall, red-team and
prior-auth. A scratch tree then made `reflect` write nothing to the graph and the harness seed
nothing into it. Memory-recall reported `differs` with exactly three `regressed` cells, the
three `entity_merged`, and 28 of 31 unchanged. Red-team and prior-auth reported `match`. With
`EXTRACTION_PROMPT` also replaced, the result was the same. No suite raised a cassette miss.
The scratch changes were reverted.

**The extraction is mostly the part only the graph used.** In the seven `distill` decisions
the six memory-recall and red-team cassettes hold, entities and relationships are most of
the extraction's JSON: 3,345 of 4,111 characters in `memory-recall-001`, 886 of 1,042 in
`tool-use-001`, 928 of 1,220 in `tool-use-002`. Counted with `jq` over each
`distill.extractEntities` response. After removal nothing reads them.

## Why it matters

ADR 0002 accepted a second store on a premise and promised to give it up if the premise
failed. P2-B and P2-D measured both roles the store was kept for, against rules fixed before
the run, and both failed. A system that keeps a component after its own measurement says to
remove it has the same problem as one that never measured it: the architecture describes
something other than what the evidence supports. NIST AI RMF 1.0 MANAGE 1.1 asks for a
determination of whether a system "achieves its intended purposes and stated objectives and
whether its development or deployment should proceed". P2-D made that determination for one
component, and this PRD is the part where it is acted on. Here that means one store fewer in every environment and every CI job, one client
and its failure modes fewer, and a README that says what the system is. The second store's
measurements are kept as a record: what was tried, how it was measured, and why it went.

## Scope

- **Stop the run writing the graph.** `reflect` writes episodic rows and `semantic_facts`,
  nothing else. The extraction asks for facts alone. The `entity_merged` grader is replaced
  by one that asks whether the run wrote semantic memory.
- **Remove Neo4j:** the `memory-core` client, writer, reader, explainer and constraints; the
  graph halves of the seed manager and the inspector; the `neo4j-driver` dependency; the
  compose service, the CI service containers and every `NEO4J_*` variable; the graph seed
  keys in the task format.
- **Narrow the `RetrievedContextItem` and `RetrievalCandidate` contracts** to the store that
  produces them.
- **Archive both measurements.** Run `yarn eval:retrieval` and `yarn eval:explanation` on the
  last commit that has the graph, confirm they reproduce the committed reports, tag that
  commit, and delete the runners and the code only they call. The datasets, recorded
  embeddings, answers and reports stay.
- **Correct every living document and control** that describes the graph: `CLAUDE.md`,
  `README.md`, `.context/`, `.agents/`, `docs/STATUS.md`, `governance/controls.yaml`, the
  harness README, and a dated note on P4-B.
- **Sequence against P1-I** so that the cassettes are recorded once, on the final extraction,
  without P2-E ever holding P1-I's deadline.

### Non-goals

- **Re-running P2-D's stage 2 on the new chat model.** P1-I handed this question here
  (`P1-I-chat-model-migration.md:184-186`). **Declined.** Stage 2 was pre-registered on
  `gemini-2.5-flash` and selected option C. P2-D's own rule makes any re-run "a new
  measurement in a new PRD" (`P2-D-graph-explanation-or-removal.md`, "What each outcome
  does"). Once the graph is gone there is nothing to measure.
- **Putting a graph back, in retrieval or explanation.** ADR 0009's "What a positive result
  would need" and ADR 0012's measurement are the specification for any PRD that tries. **No
  PRD owns it.**
- **A vector-only retrieval benchmark kept after removal.** Declined in P2-D
  (`P2-D-graph-explanation-or-removal.md`, Non-goals), and that holds. The deployed path is held by
  the facade's integration tests and by the replay cassettes, whose `plan` requests include
  the retrieved context.
- **Dropping the `[pgvector]` tag from `plan`'s prompt.** One store makes it carry no
  information, but it is in the bytes every recorded `plan` request hashes (Design,
  "Contracts"). **No PRD owns it.** It can ride the next re-record that changes `plan`'s
  prompt for its own reason.
- **Hashing the JSON seams' system prompts.** Problem item 2 shows that `distill`,
  `act.selectTool` and `assess.criteria` hash their user content and not their instruction.
  Changing that moves every cassette's hash. It is out of scope here and recorded in
  `.context/conventions.md` (Design, "Documentation"). **No PRD owns it.**
- **Per-session fact identity** (ADR 0011, P4-B's open question 2). With one store it is a
  migration of one table instead of two. It stays where ADR 0011 left it.

## Design

### Two pull requests, split by whether they change a model request

| PR            | What                                                                                                                                                                       | Changes a model request?                                  | Needs a key? | Lands                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------ | --------------------------------------------------------------- |
| **A**, small  | `reflect` stops writing the graph. The extraction asks for facts only. `entity_merged` becomes `semantic_fact_written`. Memory-recall's baseline is regenerated on replay. | Yes: `distill`'s prompt. Not its hash.                    | No           | Before P1-I records memory-recall (the rule below)              |
| **B**, larger | Neo4j removed from code, tests, stack, CI and docs. Both measurements archived first.                                                                                      | No. Verified on the request path that A leaves (Problem). | No           | Any time after A, before or after P1-I's recording, by the rule |

A is the only part of P2-E whose timing matters to another PRD. Splitting it out keeps it to
about a day, so it can land in P1-I's window. B can then take the time a wide deletion needs.

### PR A: the run stops writing the graph

**`reflect`.** Steps 2 and 3's graph writes go (`reflect.node.ts:62-75`, `:95-101`), and
`ReflectNodeDeps` loses `neo4jWriter`. The node writes episodic rows, then embeds and upserts
each fact into `semantic_facts`, as it does now. Its docstring loses the two-index
convergence caveat. With one semantic index there is no crash window between two stores.
`RunsService` stops passing a writer (`runs.service.ts:301`), and its stub goes (`:690-694`).
The stub model's canned extraction (`:400`) loses its entities. Everything else that builds
a `ReflectNodeDeps` follows in A, because typecheck requires it: the test deps in
`agent/graph/`, the two e2e fakes, and audit replay's `neo4jWriter: writes.neo4jWriter`
(`apps/agent-service/src/audit/replay-run.ts:306`).

**The extraction asks for facts only.**

```ts
// apps/agent-service/src/agent/model/extraction.ts
export const EXTRACTION_PROMPT = `Extract the facts stated in the conversation. Respond with JSON:
{"facts": [{"text": "..."}]}`;

// apps/agent-service/src/agent/graph/state.ts
export const ExtractionSchema = z.object({
  facts: z.array(z.object({ text: z.string() })),
});
```

**Why narrow it rather than keep it.** After A, nothing reads an entity or a relationship.
They are 76–85% of the extraction's JSON in the three memory-recall recordings (Problem),
so every live run would pay output tokens for data that is parsed and dropped. That is the
defect ADR 0009 removed `hopDepth` for: "A knob that is validated and then ignored is a
defect this repository has already removed once." The cost is a re-record of the two suites
that run `distill`, memory-recall and red-team. P1-I re-records both anyway
(`P1-I-chat-model-migration.md`, Phase 2, step 6). Landed first, the narrowing costs no extra
call, and P1-I's recordings are made once, on the prompt that ships.

**What stays, so no hash moves.** The seam id stays `distill.extractEntities`, and so does
`DistillNodeDeps.extractEntities`. The seam id is inside every distill decision's request
hash (`packages/agent-cassette/src/hash.ts:66-74`), so renaming it would make every
memory-recall and red-team cassette miss. The request stays `{ context }`. `distill`'s span
loses `entity_count` and `relationship_count` (`distill.node.ts:60-61`), and `reflect`'s span
loses them too.

**Replayed cassettes still carry entities until P1-I re-records them.** The replay path
returns the recorded `{ extraction, tokenCounts }` without parsing it
(`decision-seam.ts:315-317`), and `reflect` ignores keys it no longer reads. The scratch run
in the Problem section is this case.

**The grader.** `entity_merged` and `mergedConceptsMin` go, with `factsPersistedToBothIndices`,
which no assertion builds. They are replaced by the grader `reflect`'s one remaining
semantic write calls for:

```ts
// packages/eval-harness/src/graders/code.ts
/** Did `reflect` write at least `minimum` `semantic_facts` rows under this run's id? */
export function semanticFactWritten(minimum: number): Grader<MemoryOutcome>; // 'semantic_fact_written'

// packages/eval-harness/src/dataset.ts, assertions
semanticFactRowsMin: z.number().int().nonnegative().optional(),
```

It reads `factRowsForRun`, which `MemoryOutcome` already carries
(`packages/eval-harness/src/outcome.ts:24-25`). On the committed cassettes replayed on
2026-11-09 it is 7, 2 and 4 for `memory-recall-001`, `tool-use-001` and `tool-use-002`, so
`semanticFactRowsMin: 1` passes on all three. `MemoryOutcome` loses `extractedConceptIds` and
`mergedConceptIds`, and the harness stops collecting concept ids
(`apps/agent-service/src/eval/agent-harness.ts:44-56`). ADR 0011's positive control moves to
this grader. The ADR's text is not edited.

**The baseline.** `EVAL_CASSETTE_MODE=replay EVAL_GATE=update EVAL_SUITE=memory-recall yarn eval`
regenerates `baselines/replay.json` with no key. The diff is three `entity_merged` cells out
and three `semantic_fact_written` cells in, with the `cassetteDigest` unchanged. Red-team's and
prior-auth's baselines do not change.

### PR B: Neo4j removed

**Archive first, on the commit B starts from.** With `GOOGLE_API_KEY=` empty and fresh
`pgvector:pg16` and `neo4j:5-community` containers:

```bash
yarn eval:retrieval      # recorded embeddings; compare with reports/adjudicated/
yarn eval:explanation    # stage 1 model-free, stage 2 replayed from recorded/explanation-answers.json
```

Each must match its committed reports once timestamps and latencies are masked, as P2-D
and ADR 0012 verified (`0012-...md#Whether the two measurements run in CI`). That commit is
tagged `archive/p2e-graph-measurements` and pushed, so it stays reachable through a squash
merge. The sha and the tag go into this PRD, STATUS row 23, CTL-EVAL-04's note and the
harness README. ADR 0012 is accepted and is not edited (`docs/adr/README.md`: "A record is
never edited after it reaches `accepted`"). If stage 2 does not replay on that commit
because P1-I has moved `PINNED_CHAT_MODEL` without its step 2, the archive commit is the
last one before P1-I's switch on which both commands reproduce. The report says which.

**Then delete the runners and everything only they call.** In `apps/agent-service/src/eval/`:
`run-retrieval-ablation.ts`, `run-explanation.ts`, `seed-linker.ts`, `answer-file.ts`,
`explanation-prompt.ts` and their tests. In `packages/eval-harness/src/retrieval/`: all 17
files, and their exports from `src/index.ts`. `src/stats/` stays, because P1-D's live
comparison uses both bootstraps (`src/gate/compare-live.ts:1-2`). The `eval:retrieval` and
`eval:explanation` scripts go from both `package.json` files, and their tasks go from
`turbo.json` (`:79-107`). `datasets/retrieval-ablation/` stays as committed, all 13 files,
with nothing in the tree that loads it. The harness README says how to reproduce it:
check out the tag. `buildPlanPrompt` stays exported. `planNode` calls it and
`plan.node.test.ts` pins its bytes, and its docstring loses the stage-2 reason.

**Why delete the pure modules too.** `retrieval/dataset.ts`, `evaluate.ts`,
`explanation*.ts` and `metrics.ts` run without a store, and their unit tests would keep
passing. With no runner they are code nothing calls, and keeping them so that a control stays
`implemented` is the gap `docs/STATUS.md` exists to name. The tag reproduces the whole
measurement, and the committed reports are the record.

**`memory-core`.** `src/semantic/neo4j/` goes, all seven files, with
`test/explainer.integration.test.ts`. `PgNeo4jMemoryInspector` becomes `PgMemoryInspector`,
and `factNodesForRun` leaves `MemoryInspection` and `MemoryOutcome`
(`src/inspect/run-inspector.ts:20`, `:44-91`; `packages/eval-harness/src/outcome.ts:26-27`).
`PgNeo4jSeedManager` becomes `PgSeedManager`. Its seed is pgvector rows only, and
`restoreToSeed` takes no concept ids. The `neo4j-driver` dependency goes
(`package.json:22`). The integration suites keep their Postgres halves:
`semantic.integration.test.ts` loses its `ensureSemanticConstraints`, M1 and `Neo4jWriter`
blocks (`:52`, `:106`, `:203`). `retrieval-order.integration.test.ts` loses `expandFromSeeds`
(`:154`). `retrieval-facade.integration.test.ts` loses the graph halves of its two cases at `:146-168`:
the one that "does not return a fact only the graph holds" goes, and the vector-list case
stops seeding a graph.
`inspect.integration.test.ts` loses "graph facts in a seed" (`:194`).

**The task format.** `TaskSeedsSchema` loses `neo4j`, `relationships` and `graphFacts`
(`packages/eval-harness/src/types.ts:296-347`) and becomes `.strict()`. A task file that still
names a graph seed is then refused at load, not silently ignored. All six memory-recall and
red-team task files lose those keys and any `notes` sentence about them.

**`rt-001`, and P4-B.** `rt-001` seeds its poisoned fact as a `semantic_facts` row in the
attacker's session and as a `:Fact` in the same session
(`packages/eval-harness/datasets/red-team/rt-001.json:18-24`, `:39-48`). The `:Fact` and the
`northwind` concept go. The two pgvector rows stay, so the case still asks whether the vector
path returns another session's fact, which is P4-B's M2. Its notes lose the clause "it fails
if the graph is wired back into retrieval without the session scope P2-D gave every graph
read (M1)", because there is no graph to wire. Its cassette is unchanged, and the red-team
scratch run in the Problem section replayed it to `match`. P4-B is shipped, and the
prd-author rules keep a shipped PRD's text as the record. So P4-B gets one dated note under
its existing amendment block, pointing here, and this section is the record of the change.
M1 is deleted with the graph code. Nothing replaces it, because nothing is left to scope.

**The memory axis is `DATABASE_URL`.** `readMemoryConfig` returns a config when
`DATABASE_URL` is set, and its half-configured error goes (`memory.config.ts:23-46`).
`detectAxes` reads `DATABASE_URL` alone (`axes.ts:60`). A leftover `NEO4J_URI` is ignored.
`MemoryModule` loses the driver, the writer, the boot connectivity check and
`ensureSemanticConstraints` (`memory.module.ts:79-105`, `:161`, `:173`). The two tokens go
from `memory.tokens.ts:13-15`. The harness factory needs only the pool
(`agent-harness.ts:318-337`), and the e2e and integration specs stop setting, saving or
requiring `NEO4J_URI`. The specs are listed in the inventory.

**Audit replay.** `CapturedWrite` loses `neo4j.concept`, `neo4j.relationship` and `neo4j.fact`
(`captured-writes.ts:12-19`, `:55-69`), and `replay-report.ts:82-87` loses their lines.
`audit-replay.integration.test.ts` stops counting Neo4j nodes in "makes no write to Postgres
or Neo4j" (`:273-293`). A run record made before B replays at the commit it names
(`apps/agent-service/src/audit/replay-run.ts:214-220`, `shaRefusal`), where the graph code still exists, so
old records stay replayable.

**Telemetry.** `ALLOWED_SPAN_ATTRIBUTES` loses the keys only graph spans set: `seedEntityCount`,
`hopDepth`, `fact.entityCount`, `conceptCount`, `relationshipCount`, `graphFactCount`,
`seedConceptCount`, `factNodesForRun`, and, after A, `entity_count` and `relationship_count`
(`packages/telemetry/src/genai.ts:151-152`, `:201-214`). `factCount`, `seedFactCount` and
`fact.contentHash` stay, because the seed manager's pgvector half and `PgvectorWriter` still
set them.

**The stack.** In `docker-compose.yml`: the `neo4j` service, the `neo4jdata` volume,
`agent-service`'s three `NEO4J_*` variables and its `depends_on` entry. In `.env.example`:
`:4-7` and the two host-port overrides at `:44-45`, with the sentence at `:41` that names
`NEO4J_URI`. In `turbo.json`: the three `NEO4J_*` names in each task's `env`.
`mcp-config/neo4j.json` is deleted. In `agent-eval.yml`: the `neo4j` service in `replay`
and `live`, and the workflow-level `NEO4J_*`. In `e2e.yml`: the `neo4j` service and the
three variables. Job names do not change, so `.github/rulesets/main.json` and the check
`yarn lint:docs` makes against it are unaffected.

### Contracts

`plan`'s prompt renders each retrieved item as `- [${c.source}] ${c.content}`
(`apps/agent-service/src/agent/nodes/plan.node.ts:22`). Every committed memory-recall and
red-team cassette's `plan.callLlm` request contains `[pgvector]`. So:

- **`source` stays, narrowed to `z.literal('pgvector')`**, in `RetrievedContextItemSchema`
  (`memory.schema.ts:10`) and `RetrievalCandidateSchema` (`retrieval-facade.ts:48`). The value
  every response has carried since ADR 0009 is unchanged, so no `plan` hash moves. Removing
  the field would move every `plan` hash and break replay outright, which is a harder
  failure than the narrowing's. `RunResponse.retrievedContext`
  (`packages/agent-contracts/src/run-response.schema.ts:28`) narrows an output. A client
  that handled `'neo4j'` has not received it since ADR 0009, and one that did not loses
  nothing.
- **`entityId` goes from both schemas.** No source file sets it.
- **Checkpoints written before ADR 0009** could hold a `'neo4j'` candidate in
  `retrievedContext`. Nothing parses a stored checkpoint against `AgentStateSchema`. The
  only parse of an extraction is the live model path (`extraction.ts:46`). Nothing is
  deployed, so no checkpoint migration is written.

### `reflect` and the promotion rule

`CLAUDE.md` says "The reflect node is the ONLY place that promotes data to Episodic or
Semantic memory." It stays true and unchanged. Semantic memory is now `semantic_facts`
alone, written by `reflect` through `PgvectorWriter`. The three tiers, Working, Episodic and
Semantic, are the same. `CLAUDE.md`'s first rule loses "Neo4j" from its list of stores.
CTL-MEM-01, "Long-term memory has one write path, reflect, through memory-core", is
unchanged.

### Controls

- **CTL-EVAL-04** cites the ablation's runner, its rule functions and their unit tests
  (`governance/controls.yaml:189-227`), all deleted by B. After B nothing in the tree runs
  the measurement, so no check enforces the control. It becomes **`procedural`**, retitled
  "A memory store is kept only on a measurement against labels and a decision rule fixed
  before the run". Its anchors are docs only, as the lint requires of a procedural row
  (`scripts/lint-controls.mjs:154-160`): `.context/workflows.md`, "Add a New Memory
  Adapter", which gains that rule as a step; ADR 0009, "The measurement"; and ADR 0012,
  "Decision". Its note names the archive tag.
- **CTL-MEM-02** cites the integration test "does not return a fact only the graph holds"
  (`controls.yaml:402-405`), which B deletes. It is replaced by the test beside it that
  holds the same property on the remaining path:
  `retrieval-facade.integration.test.ts#does not return a fact written in another session`
  (`:171`).
- `governance/CONTROLS.md` is regenerated.

### Documentation

- **`docs/STATUS.md`.** Row 15 becomes `removed`, citing ADR 0012's Decision and the stage-2
  summary. Row 23 becomes `removed`, with the archive tag and the committed reports. The
  legend's `removed` reads "Provisioned but never used" (`STATUS.md:22`), and neither row
  fits that. It becomes "Not in the code at HEAD: never used, or taken out by decision; the
  row says where the record is". Rows 2, 4, 8, 13, 17, 18 and 27 name Neo4j in their
  evidence and are rewritten to the one store.
- **Living docs**, rewritten to one semantic index: `CLAUDE.md`, `README.md`,
  `.context/architecture.md`, `.context/glossary.md`, `.context/workflows.md`,
  `.context/conventions.md`, `.agents/memory-author.md`, `.agents/reviewer.md`,
  `.agents/test-author.md` and `packages/eval-harness/README.md`.
- **`.context/conventions.md`'s re-record triggers.** The sentence that says a prompt-string
  change in `extraction.ts` or `tools/selection.ts` was "mechanical — the request hash
  moves". The Problem section found that false. This draft's own change corrects it: only
  `plan`'s system prompt and instruction are in a request, and the JSON seams' instructions
  are triggers nothing notices, like the canary's `changed`.
- **Records left as written:** the shipped PRDs, the accepted ADRs, and
  `docs/appendix/adk-portability.md`, which is dated. ADR 0004's status line already reads
  `superseded by 0012`.
- **The index's "Where things stand"** is updated when P2-E ships, as `CLAUDE.md` requires.

### Sequencing with P1-I

P1-I has to put a new chat model on `main` by 2026-11-30. It re-records all three cassette
suites in its phase 2: memory-recall on its day 8, red-team on day 9, prior-auth on days 10
and 11 (`P1-I-chat-model-migration.md`, "Quota and the per-day split"). Day 8 is also the
day it applies its rule. On its current schedule that is 2026-11-17. Two of those suites
run `distill`, which A changes.

**The rule.**

1. **P2-E never holds P1-I.** No step of P2-E needs a key or a quota day, and P1-I waits
   for nothing in P2-E.
2. **A lands before P1-I records memory-recall, or its prompt change waits.** If A is on
   `main` by the morning P1-I applies its rule, P1-I's branch rebases onto it. P1-I's
   memory-recall and red-team recordings then carry the narrowed extraction, its budgets
   are derived from those recordings, and its baselines have `semantic_fact_written` and no
   `entity_merged`. That costs P2-E nothing. If A is not on `main` by then, P1-I records
   first, on the extraction as it is. A's prompt and schema change is then held back. The
   rest of A changes no request and merges whenever it is ready, alone or with B.
3. **B lands whenever it is ready**, before, during or after P1-I's recordings. It changes no
   recorded decision's request, so a baseline it affects is regenerated with `EVAL_GATE=update`
   on replay, with no key. Rebasing P1-I's branch over B touches no cassette.
4. **If A's prompt change was held back,** it is taken after P1-I merges, at the cost of
   re-recording memory-recall and red-team on the chosen id: 12 + 12 `generateContent` calls
   by P1-I's counts. Or it is declined, and the extraction keeps entities nothing reads
   (open question 1).

**Whether the fallback holds.** For B, and for every part of A except the prompt, yes. The
scratch run in the Problem section removed the graph writes and the graph seeds from the
request path. No cassette missed, red-team and prior-auth matched their baselines, and
memory-recall differed only in the three `entity_merged` cells that A replaces. For the prompt,
the gate would pass too: the prompt is not hashed, and the same scratch run replaced it with
no miss. That is why the prompt has a date and the rest does not. A recording made under one
prompt and replayed under another passes the gate and is wrong, which is the case the
conventions' trigger list exists for.

**What P1-I's own plan needs from this.** Two of its items act on files B deletes, and
P2-E's acceptance amends P1-I with a dated note:

- Step 2, `STAGE2_CHAT_MODEL` in `run-explanation.ts` and `answer-file.ts`
  (`P1-I-chat-model-migration.md:309-316`). If B has merged when P1-I switches, step 2 has
  nothing to act on, and stage 2's answer file replays at the archive tag, where the pin is
  still `gemini-2.5-flash`. If B merges after the switch, B deletes the constant with the
  runner.
- The criterion "after the switch, P2-D's answer file replays under the default
  configuration" (`:466-468`). It is met at the archive tag, or by the step-2 test if P1-I
  switches first. The grep criterion (`:463-465`) then has one fewer expected hit, or none.

**P1-I's phase 1 runs on the old extraction.** Its candidate dispatches are on its days 1
and 2, before A can be accepted and merged. Its rule reads those trials, so the model it
chooses is chosen on the old prompt and recorded on the new one. The change only removes
what the model is asked for. P1-I's blocking criteria, prior-auth's wrongful approvals and
the red team's canaries, do not read entities. The recording run is where a problem would
show, and P1-I records every result whether it passes or fails.

### Budget

**Zero `generateContent` calls on the planned path.** A's baseline is regenerated on replay.
B's archive runs replay recorded embeddings and recorded answers, and stage 1 makes no model
call. P1-I's recordings absorb the narrowed extraction. **Twenty-four calls only on the late
path**, if A's prompt change misses P1-I's day 8 and the reviewer keeps it.

### Inventory

Every file `git grep -il neo4j` lists outside Markdown and `yarn.lock` at `eb797be`, and
every other file the change touches. "Delete" means the file goes. "Edit" means the graph
half or the reference goes, and the rest stays.

**`packages/memory-core`: 23 that name Neo4j.** Delete 8: `src/semantic/neo4j/` (`neo4j.client.ts`,
`neo4j.constraints.ts`, `neo4j.reader.ts`, `neo4j.writer.ts`, `neo4j.explainer.ts`,
`neo4j.explainer.test.ts`, `neo4j.explainer.test-d.ts`) and `test/explainer.integration.test.ts`.
Edit 15: `package.json`, `src/index.ts`, `src/semantic/index.ts`, `src/inspect/index.ts`,
`src/inspect/run-inspector.ts`, `src/inspect/seed-manager.ts`,
`src/semantic/retrieval-facade.ts`, `src/semantic/pgvector/pgvector.reader.ts` (comment),
`src/working/working-memory.helpers.test.ts` (fixture), `test/inspect.integration.test.ts`,
`test/integration-env.ts`, `test/retrieval-facade.integration.test.ts`,
`test/retrieval-order.integration.test.ts`, `test/semantic.integration.test.ts`,
`vitest.integration.config.ts` (comment).

**`apps/agent-service`: 36 that name Neo4j, 14 that do not.** Delete 8:
`src/eval/run-retrieval-ablation.ts`, `src/eval/run-explanation.ts`, and, not naming it,
`src/eval/seed-linker.ts`, `seed-linker.test.ts`, `answer-file.ts`, `answer-file.test.ts`,
`explanation-prompt.ts` and `explanation-prompt.test.ts`. Edit 34 that name it:
`src/a2a/run-executor.ts` (comment); `src/agent/graph/fake-deps.ts`, `graph.test.ts`,
`resume.test.ts`, `spans.test.ts`; `src/agent/model/extraction.test.ts`;
`src/agent/nodes/reflect.node.ts`, `reflect.node.test.ts`; `src/audit/captured-writes.ts`,
`replay-report.ts`, `replay-run.ts`, `replay.ts` (comment); `src/eval/agent-harness.ts`,
`cassette-deps.test.ts` (comment), `provider-unavailable.test.ts`, `run-suite.test.ts`;
`src/ledger/ledger.module.ts` (message); `src/memory/memory.config.ts`,
`memory.config.test.ts`, `memory.module.ts`, `memory.tokens.ts`; `src/runs/runs.service.ts`;
`test/a2a.e2e-spec.ts`, `appeal.e2e-spec.ts`, `approval.integration.test.ts`,
`audit-replay.integration.test.ts`, `boot.e2e-spec.ts`, `fhir.e2e-spec.ts`,
`ledger.integration.test.ts`, `review.e2e-spec.ts`, `runs.e2e-spec.ts`,
`runs-session.integration.test.ts`, `service-app.ts`; `vitest.integration.config.ts`
(comment). Edit 8 that do not: `package.json` (two scripts), `src/agent/graph/state.ts`,
`src/agent/model/extraction.ts`, `src/agent/nodes/distill.node.ts`, `distill.node.test.ts`,
`plan.node.ts` and `retrieve.node.ts` (docstrings), `src/eval/agent-harness.test.ts`.

**`packages/eval-harness`: 15 that name Neo4j, 19 that do not.** Delete 17: all of
`src/retrieval/`, two of which name Neo4j (`evaluate.test.ts`, `rrf.test.ts`). Edit 13 that
name it: `datasets/memory-recall/{memory-recall-001,tool-use-001,tool-use-002}.json`,
`datasets/red-team/{rt-001,rt-002,rt-003}.json`, `src/axes.ts`, `src/axes.test.ts`,
`src/dataset.test.ts`, `src/graders/code.ts`, `src/harness.test.ts`, `src/outcome.ts`,
`src/types.ts`. Edit 4 that do not: `src/index.ts`, `src/dataset.ts`,
`src/graders/code.test.ts`, `datasets/memory-recall/baselines/replay.json`. Untouched:
`datasets/retrieval-ablation/`, all 13 files, as the archive. `gate.test.ts`,
`compare-replay.test.ts` and `history.test.ts` use `entity_merged` only as a fixture string,
and they stay.

**`packages/shared-types`: 2.** Edit `src/memory.schema.ts` and `src/memory.schema.test.ts`.

**`packages/telemetry`: 1 that does not name Neo4j.** Edit `src/genai.ts`.

**Stack and root: 6 that name Neo4j, 2 that do not.** Delete `mcp-config/neo4j.json`. Edit
`docker-compose.yml`, `.env.example`, `turbo.json`, `.github/workflows/agent-eval.yml`,
`.github/workflows/e2e.yml`, root `package.json` (two scripts) and
`governance/controls.yaml`. `yarn.lock` loses `neo4j-driver` and its dependencies.

**Totals.** 118 files outside Markdown: 82 that name Neo4j and 36 that do not. 34 are
deleted and 84 edited, across five workspaces, the stack and the control catalogue. 15
Markdown files are edited: the ten living docs above, `docs/STATUS.md`,
`governance/CONTROLS.md` (generated), `docs/prd/README.md`, and the dated notes on P4-B and
P1-I. Thirteen of them name Neo4j. The other 31 Markdown files that name it, the shipped
PRDs, the accepted ADRs, the ADR index and the dated appendix, are records and stay as
written.

## Acceptance criteria

Each criterion names its axis. "Pure" means a unit test with no store and no network.
"Memory live" means a real `pgvector:pg16` container, and until B, `neo4j:5-community` too.
"Model replay" means the committed cassettes, with `GOOGLE_API_KEY=` empty and no request to
`generativelanguage.googleapis.com`.

**PR A**

- [x] `reflect` writes no graph, and `ReflectNodeDeps` has no `neo4jWriter`. **Pure**, with
      fake writers: `reflect.node.test.ts` asserts the episodic and pgvector writes and that
      the deps type has no graph writer. "writes each turn to episodic memory and each fact
      to semantic_facts" checks both writes' keys, and "takes no graph writer (P2-E)" pins
      `keyof ReflectNodeDeps` with `expectTypeOf`, so a writer added back fails
      `yarn turbo typecheck`. "ignores the entities a cassette recorded before P2-E still
      carries" is the replay case.
- [x] `EXTRACTION_PROMPT` asks for facts only, and `ExtractionSchema` holds `facts` only. The
      seam id is still `distill.extractEntities`, and `cassette-deps.test.ts`'s
      hash-stability test passes unchanged. **Pure.** `extraction.test.ts`, "drops the
      entities and relationships the extraction no longer asks for (P2-E)": a live response
      that still carries them is stripped, not refused. The describe block "request hashes
      across two runs of the same task" is unchanged; only the docstring above it now names
      `semantic_fact_written`.
- [x] `entity_merged`, `mergedConceptsMin` and `factsPersistedToBothIndices` are gone, and
      `semantic_fact_written` with `semanticFactRowsMin: 1` is on all three memory-recall
      tasks. **Pure** for the grader's pass and fail. **Model replay / memory live**:
      `semantic_fact_written` passes on all three tasks. `code.test.ts`, "fails when reflect
      wrote no semantic_facts row for the run" and "counts rows against the minimum it was
      given"; `dataset.test.ts`, "asks every task whether the run wrote semantic memory
      (P2-E)". On replay on 2026-11-09 the three runs wrote 7, 2 and 4 rows, and 0 `:Fact`
      nodes. The three names survive only as fixture strings in `gate.test.ts`,
      `history.test.ts` and `compare-replay.test.ts`, as the Inventory says.
- [x] **Model replay / memory live:** `EVAL_GATE=update` regenerates memory-recall's baseline,
      and its diff is three `entity_merged` cells out and three `semantic_fact_written` cells
      in, with `cassetteDigest` unchanged. A second replay with `EVAL_GATE=replay` reports
      `match`. Red-team and prior-auth report `match` against their unchanged baselines.
      Run on 2026-11-09 with `GOOGLE_API_KEY=` empty, against fresh `pgvector:pg16` and
      `neo4j:5-community` containers. The baseline diff is those six lines and nothing else:
      `cassetteDigest` (`7ba01468…`), `recordedAt` and `gitSha` are unchanged, and all 31
      cells pass. Memory-recall (3 tasks), red-team (3) and prior-auth (24) each report
      `match`, with no `CassetteMissError`. `yarn turbo test:integration` with
      `REQUIRE_INTEGRATION_ENV=1` passes as well, including the other two checks that
      replay `memory-recall-001`.
- [ ] A merged before P1-I's memory-recall recording, or its prompt change was held back by
      the sequencing rule. The date of each, and which happened, are recorded here.
      **Reviewer, from `git log`.**

**PR A, as built (2026-11-09).** Four things the Design did not assign to A had to move with
it:

- `test/audit-replay.integration.test.ts`, "replays a stub run with every checkpoint
  matching, and derives what it wrote", listed the stub run's derived writes, and two of
  them were `neo4j.concept` and `neo4j.fact`. A drops them. Typecheck cannot see this: the
  test names no writer, and it fails only on memory live.
- `src/eval/provider-unavailable.test.ts` routed its fake model host on the text
  `Extract entities, relationships`, so under the narrowed prompt `distill` was answered
  with a plan. It now matches the new prompt.
- `spans.test.ts`'s "nests the write spans under agent.node.reflect" asserted the graph
  writer's span. It is now "nests the write span under agent.node.reflect", and
  CTL-LOG-01's anchor and STATUS row 13 follow it, with `governance/CONTROLS.md`
  regenerated.
- The living docs that said `reflect` writes the graph became false with A, not B: STATUS
  rows 2, 4 and 15, `README.md`, `.context/architecture.md`, `.context/glossary.md` and the
  harness README. A corrects those sentences and leaves the rest of each graph description
  to B.

Left for B, by the rule that A changes only what its behaviour needs: `RunsService` still
injects `NEO4J_WRITER`, unread, so its positional constructions, `run-explanation.ts`'s
among them, stay as they are. `CapturedWrites` keeps its `neo4jWriter` and the three
`neo4j.*` write kinds. `ALLOWED_SPAN_ATTRIBUTES` keeps `entity_count` and
`relationship_count`. `RunInspectionInput.conceptIds` and `MemoryOutcome.factNodesForRun`
stay, and the harness passes no concept ids.

**PR B**

- [ ] On the commit B starts from, with `GOOGLE_API_KEY=` empty, `yarn eval:retrieval` and
      `yarn eval:explanation` reproduce their committed reports once timestamps and
      latencies are masked. Stage 2 replays all 76 answers and makes no request to the
      model host. The sha is tagged `archive/p2e-graph-measurements`, the tag is pushed, and
      the sha is recorded here. **Memory live, embeddings recorded, model replay.**
- [ ] `git grep -il neo4j -- . ':!*.md' ':!yarn.lock'` prints nothing, and
      `yarn why neo4j-driver` finds no dependent. **Reviewer.**
- [ ] `TaskSeedsSchema` refuses a task file with a `neo4j`, `relationships` or `graphFacts`
      key. **Pure.**
- [ ] `readMemoryConfig` and `detectAxes` select the memory axis on `DATABASE_URL` alone,
      and ignore `NEO4J_URI`. **Pure.**
- [ ] `RetrievedContextItemSchema.source` and `RetrievalCandidateSchema.source` are
      `z.literal('pgvector')`, and neither schema has `entityId`. `plan.node.test.ts`'s
      pinned bytes, which include `[pgvector]`, are unchanged. **Pure.**
- [ ] **Model replay / memory live, with no Neo4j container:** all three suites report
      `match` against their baselines, and two consecutive replays give identical reports
      with timestamps masked.
- [ ] **Model stub / memory live:** on a scratch tree that forces `crossSession: true` in
      `retrieve`, `rt-001` fails `canary_absent_from_context`, as P4-B showed for the
      graph-seeded version. So the case still bites without the graph. The scratch change
      is not committed.
- [ ] `e2e.yml`'s integration job passes with a Postgres service and no other, and its
      `browser-e2e` job passes against `docker compose --profile full` with no `neo4j`
      service. `agent-eval.yml`'s `replay` job passes with one service container. **In CI.**
- [ ] CTL-EVAL-04 is `procedural` under its new title with doc anchors only, and CTL-MEM-02
      cites the session-scoping test. `yarn lint:docs` passes, with `governance/CONTROLS.md`
      regenerated. **Reviewer.**
- [ ] STATUS rows 15 and 23 are `removed` under the widened legend. Rows 2, 4, 8, 13, 17, 18
      and 27 name no graph. The ten living docs describe one semantic index. P4-B carries a
      dated note, and P1-I carries a dated amendment for its step 2 and its stage-2 criterion.
      **Reviewer.**
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass, and so do `yarn turbo test:unit`, `yarn turbo test:service` and
      `yarn turbo test:integration`.

## Risks and open questions

**Decided at review, 2026-11-09.** The draft put four questions. The conductor's decisions:

1. **If A's prompt change misses P1-I's day 8, re-record.** Memory-recall and red-team are
   24 `generateContent` calls on the chosen id, and the owner's paid key now serves local
   recordings, so the cost is minutes. An extraction that is mostly output nothing reads is
   the ignored-output defect ADR 0009 named.
2. **CTL-EVAL-04 becomes `procedural`**, anchored to the written rule in `workflows.md`. The
   practice applies to the next store anyone proposes.
3. **No ADR of its own.** The narrowed extraction, contract and grader are consequences of
   ADR 0012, recorded here.
4. **Widen `removed`** in the STATUS legend to cover "taken out by decision", rather than a
   sixth status for one row.

One finding of this draft is handed on rather than built here. The three JSON seams hash the
content they send and not their instruction (`.context/conventions.md`, corrected in this
pull request), so a prompt change replays silently. Adding the instruction to those hashes
moves every committed cassette's request hash, so in A it would make all three suites miss
until a re-record. **P1-I builds it in its phase 2, before it records**, because it
re-records every suite anyway; P1-I's dated amendment of 2026-11-09 says so.

**Risks.**

- **The narrowed prompt could extract fewer or worse facts.** Entities may have helped the
  model structure its fact list. Nothing measures extraction quality: there is no labelled
  extraction set (P2-D Non-goals). `semantic_fact_written` catches a run that writes none,
  and P1-I's recording records every task's result. The red team's
  `canary_absent_from_extraction` still reads the facts.
- **A lands between P1-I's phase 1 and its recording,** so P1-I chooses a model on one prompt
  and records on another (Design, "Sequencing with P1-I"). The exposure is limited to the
  memory-recall and red-team tasks. Their extraction is graded only by
  `semantic_fact_written` and the red-team canary.
- **The nightly's `eval-history` epoch pools trials graded with and without `entity_merged`**
  if A merges mid-epoch. An epoch is keyed on the suite and the cassette digest
  (`apps/agent-service/src/eval/history.ts:163`), and A does not move the digest. No
  `baselines/live.json` is promoted, so the verdict is `incomparable` regardless. P1-I's
  new cassettes start a new epoch.
- **The archive may not reproduce at B's start.** P1-I may have moved the pin without step 2,
  or a later change may have broken a runner. The archive commit is then the last one on
  which both reproduce, found by bisecting the commits since `eb797be`. The report says
  which, so the tag never names an unverified commit.
- **Merge conflicts with P1-I's branch.** P1-I edits `extraction.ts:26`'s comment, the
  conventions' live-quota section and STATUS rows that B rewrites. Every conflict is text.
  None touches a cassette.
- **The premise.** This PRD is wrong if something on a request path still reads the graph.
  `VectorRetrievalFacade` and the scratch run say nothing does. The criterion that runs all
  three suites with no Neo4j container is the check.
- **Sizing.** `M`, as indexed. A is about a day, and its code has run: the scratch tree in
  the Problem section is most of it. B is mostly deletion over 118 files, plus the archive
  runs, which took under a minute each in P2-D. The unknowns are the integration and e2e
  suites. They have always run with both stores, so a test that leans on Neo4j without
  naming it is found only when it runs without one. By P0-A's rule that count is unknown.

## References

- ADR 0012, "The graph's explanation role, after both stages: option C": the decision this
  PRD executes, and the archive it asks for.
- ADR 0009, "The second store, after the retrieval ablation": option C, the fallback, and
  "What a positive result would need".
- ADR 0011, "The agent does not promote its own output": the positive control that
  `semantic_fact_written` takes over.
- P2-D, "What P2-E inherits": the specification. P1-I, "Phase 2" and "Quota and the
  per-day split": the recording this PRD sequences against. P4-B: `rt-001` and M1.
- `.context/conventions.md`, the re-record triggers and "Live model quota".
- NIST AI RMF 1.0, MANAGE 1.1: https://doi.org/10.6028/NIST.AI.100-1
