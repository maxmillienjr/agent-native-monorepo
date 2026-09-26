---
id: P5-C
title: Upgrade to LangGraph 1.x
tier: 5
status: draft
size: S
depends_on: [P0-A]
blocks: []
issue: null
superseded_by: null
---

# P5-C · Upgrade to LangGraph 1.x

## Problem

The agent runs on the 0.x line of every LangChain package it uses, and nothing in the
repository will move it off.

`apps/agent-service/package.json:19-22` declares `@langchain/core ^0.3.0`,
`@langchain/google-genai ^0.2.0`, `@langchain/langgraph ^0.4.10` and
`@langchain/langgraph-checkpoint-postgres ^0.1.3`. The lockfile resolves them to `0.3.80`,
`0.2.18`, `0.4.10` and `0.1.3` (`yarn.lock:1446-1524`), with
`@langchain/langgraph-checkpoint@0.1.3` and `@langchain/langgraph-sdk@0.1.10` underneath.
No other workspace imports a LangChain package: the only importers are `graph.ts:1-2`,
`retry.ts:2`, `resume.test.ts:2`, `memory.module.ts:5` and `runs.service.ts:4,14-15`, plus a
`vi.mock('@langchain/google-genai')` at `cassette-deps.test.ts:32`, all in
`apps/agent-service`.

On npm on 2026-09-26 the current releases are `@langchain/langgraph@1.4.18`,
`@langchain/core@1.2.12`, `@langchain/langgraph-checkpoint@1.1.5`,
`@langchain/langgraph-checkpoint-postgres@1.0.5` and `@langchain/google-genai@2.3.2`. Every
one of them is a semver major away, and the four move together: `langgraph@1.4.18` peers on
`@langchain/core ^1.1.48`, the 1.x saver on `^1.1.44`, and `google-genai@2.3.2` on
`^1.2.11`. None of them accepts `@langchain/core@0.3.x`.

`.github/dependabot.yml:15-18` ignores `version-update:semver-major` for every npm
dependency, so the `langchain` group at `dependabot.yml:24-28` only ever proposes a 0.x
patch. That rule is deliberate — the comment above it says majors are to be done
"deliberately: unignore the one package, migrate, re-ignore" — and this PRD is that
deliberate step.

Two pieces of the repository exist because of the pin. `gemini-embedder.ts:16-28` calls
`embedContent` directly because `GoogleGenerativeAIEmbeddingsParams` at `0.2.18` has no
output-dimension field; `2.3.2` has one (`outputDimensionality`, `embeddings.d.ts:44` in the
published package). And `yarn install` warns at HEAD that
`@repo/agent-service doesn't provide @langchain/langgraph-checkpoint (p3239ce), requested by @langchain/langgraph-checkpoint-postgres`.

### What a trial bump did

Run in a worktree on 2026-09-26 at `4516f4e`, on Node 24.11.1, and reverted afterwards.
Postgres (`pgvector/pgvector:pg16`) and Neo4j (`neo4j:5-community`) ran in containers on
ports 25432 and 27687, because 5432 and 7687 were held by other projects. No live model call
was made: `GOOGLE_API_KEY` was unset for every command.

```
yarn up @langchain/langgraph@^1.4.18 @langchain/core@^1.2.12 \
        @langchain/langgraph-checkpoint-postgres@^1.0.5 @langchain/google-genai@^2.3.2
```

It resolved to `langgraph 1.4.18`, `core 1.2.12`, `langgraph-checkpoint 1.1.5`,
`langgraph-checkpoint-postgres 1.0.5`, `google-genai 2.3.2`, `langgraph-sdk 1.12.0`, with
`langsmith` staying at `0.6.3` and `@google/generative-ai` at `0.24.1`. The diff was 8 lines
of `package.json` and 238 of `yarn.lock`. The peer warnings were the same four as at the old
pins, including the `p3239ce` one above.

Then every gate, with no source change:

| Gate                                              | At the 0.x pins      | At 1.x               |
| ------------------------------------------------- | -------------------- | -------------------- |
| `yarn turbo typecheck --force`                    | 15/15 tasks          | 15/15 tasks          |
| `yarn turbo lint --force`                         | 15/15 tasks          | 15/15 tasks          |
| `yarn turbo test:unit --force`                    | 254 tests, 31 files  | 254 tests, 31 files  |
| `yarn turbo test:service`                         | 5 passed             | 5 passed             |
| `yarn turbo test:integration` (stores live)       | 27 passed, 0 skipped | 27 passed, 0 skipped |
| `EVAL_CASSETTE_MODE=replay yarn eval`, run 1      | 21/21 graders pass   | 21/21 graders pass   |
| `EVAL_CASSETTE_MODE=replay yarn eval`, run 2      | identical to run 1   | identical to run 1   |
| Requests to `generativelanguage.googleapis.com`   | 0                    | 0                    |
| Checkpoints per thread (memory-recall / tool-use) | 9 / 11               | 9 / 11               |

**Nothing broke.** The replay reports at the two versions are identical once run ids and
latencies are masked — all 476 lines of the JSON, not only the pass flags — so every grader's
score and explanation, every node sequence, every tool call and every token count reproduced.
`git diff packages/eval-harness/datasets` was empty afterwards. A replay also refuses to
finish with a recorded decision unconsumed (`cassette-deps.ts:290-295`), so the 1.x graph
made exactly the calls the recording did, in the order it did.

That is a result about the stub and replay model axes and the live memory axis. **The live
model axis was not exercised**, because a replayed run constructs no model client
(`cassette-deps.ts:120-152`). Everything between the wire and the value `ModelDeps` returns —
`ChatGoogleGenerativeAI` at `runs.service.ts:201-217` — ran at `2.3.2` in no test at all.

### What changed that the gates do not show

**The retry schedule.** `IO_RETRY` (`retry.ts:27-33`) sets `initialInterval: 200`,
`backoffFactor: 2`, `jitter: true`. At `0.4.10` the first retry sleeps `200 × 2` = 400 ms
plus up to 1000 ms of jitter, the second 800 ms plus jitter
(`dist/pregel/retry.js:113-116` in the published package). At `1.4.18` the exponent starts at
zero: 200 ms, then 400 ms, plus the same up-to-1000 ms jitter
(`dist/pregel/retry.js:73-75`). Measured on a `reflect` node that fails every attempt: `0.4.10`
logged 400.00 ms and 800.00 ms (its log line omits the jitter); `1.4.18` logged 263.97 ms and
1313.25 ms (its log line includes it). The worst case across two retries drops from 3.2 s to
2.6 s. Nothing asserts on it, and `maxAttempts` and `retryOn` behave as before —
`graph.test.ts` and `resume.test.ts` pass unchanged.

**The response mapping in `google-genai`.** Both `0.2.18` and `2.3.2` return a plain string
as `AIMessage.content` only when the candidate has exactly one text part, and an array of
content blocks otherwise (`utils/common.js:386-397` at `0.2.18`, `:288-299` at `2.3.2`).
`2.3.2` adds one case: a part flagged `thought` becomes a `thinking` block, so a thinking
model that returns its thoughts produces array content. `runs.service.ts:212` turns
array content into `''`:

```ts
content: typeof response.content === 'string' ? response.content : '',
```

That path exists at the old pin as well. It is silent in both, and the only difference is
one more way to reach it.

### Checkpoints across the upgrade

Measured, not read. The two savers ship the same five migrations (`checkpoint_migrations` v0
to v4, byte-identical SQL in `dist/migrations.js` of each package), `setup()` under `1.0.5`
added no row to a table migrated by `0.1.3`, and both wrote checkpoints with `v: 4` and
blobs of type `json` and `empty`.

A scratch script built `buildAgentGraph` with a `PostgresSaver`, with `reflect`'s episodic
write throwing, and left the thread at `next: ['reflect']` — the same shape
`resume.test.ts:58-97` asserts against `MemorySaver`. Each direction was then resumed with
`invoke(null, { configurable: { thread_id } })`:

| Written by       | Resumed by       | Loaded `next` | `distill` calls on resume | Outcome   |
| ---------------- | ---------------- | ------------- | ------------------------- | --------- |
| `0.4.10`/`0.1.3` | `1.4.18`/`1.0.5` | `['reflect']` | 0                         | `success` |
| `1.4.18`/`1.0.5` | `0.4.10`/`0.1.3` | `['reflect']` | 0                         | `success` |

A completed thread from each version's replay run loaded under the other with all 15 state
keys and `outcome: 'success'`. So an in-flight thread survives a deploy in either direction,
and a rollback does not strand a thread written by the new version. The graph uses no
`interrupt`, `Command`, `Send` or subgraph — a grep for each across `apps` and `packages`
finds none — so those checkpoint shapes were not exercised and do not need to be.

## Why it matters

A framework two majors behind is a finding in any dependency review before it is a problem
in production: security fixes land on the current line first, the documentation describes
the current API, and the distance compounds, because the next major is measured from where
the repository stands rather than from where upstream is. ADR 0001 made LangGraph the
persistence layer for every run, so the cost of staying is paid in the one component the
architecture leans on hardest. The other reason is specific to this repository: P1-B was
designed so that exactly this change could be checked without spending quota
(ADR 0005, "It survives the client"). This PRD is the first time that claim is load-bearing,
and the trial above is the evidence that it holds.

## Scope

- Move the four direct dependencies to the 1.x line (2.x for `google-genai`) in
  `apps/agent-service/package.json`.
- Declare `@langchain/langgraph-checkpoint` directly, so the saver's peer is provided and the
  `p3239ce` warning is gone.
- Run one live trial of each task to cover the client the replay cannot see.
- Correct the three sentences the upgrade makes false: the "until then" in
  `gemini-embedder.ts:20-24`, the pinned versions in `docs/prd/README.md:170-175`, and this
  PRD's status.

### Non-goals

- **Replacing `gemini-embedder.ts` with the LangChain embeddings adapter.** `2.3.2` makes it
  possible, which removes the reason the file gives for existing, but not the file's
  correctness: it works, it is covered by the `embed` seam, and swapping it changes the live
  embedding path, which only live `embedContent` calls can verify. **No PRD owns this**, and
  none should until there is a defect in the direct call to fix — the comment is corrected
  to say the choice is now deliberate rather than forced.
- **Making `runs.service.ts:212` fail loudly on non-string content.** It is a pre-existing
  silent path, not one the upgrade introduces, and turning a swallowed shape into a throw is
  a behaviour change that needs its own live evidence. **No PRD owns it today**; the live
  criterion below asserts the one consequence that matters here — a non-empty plan.
- **Adopting 1.x features** — typed interrupts, `graph.stream` encodings, `createAgent`.
  The graph uses none of the removed APIs the migration guide lists (`createReactAgent`,
  `toLangGraphEventStream`, `dist/` imports), and adoption is a design change, not an
  upgrade.
- **The root `langsmith` resolution** (`package.json:39` and the `resolutions` block). It was
  added in `117d6eb` to force `langsmith` past the `^0.3.67` that `core@0.3.80` declares.
  `core@1.2.12` declares `>=0.5.0 <1.0.0`, so after this change the resolution no longer
  overrides anything; it is harmless, and removing a security override is not an upgrade
  decision. Left as is.
- **Changing the Dependabot policy.** The major-version ignore stays. After this PRD the
  `langchain` group proposes 1.x minors on its own.

## Design

The whole change is a version bump, and the trial says the code does not move with it.

```jsonc
// apps/agent-service/package.json
"@langchain/core": "^1.2.12",
"@langchain/google-genai": "^2.3.2",
"@langchain/langgraph": "^1.4.18",
"@langchain/langgraph-checkpoint": "^1.1.5",
"@langchain/langgraph-checkpoint-postgres": "^1.0.5",
```

Whatever is current on the day it is implemented, the four move together — a partial bump
cannot satisfy the peer ranges, and `yarn up` with one package fails resolution rather than
installing something mismatched. The one added line is untested by the trial;
`langgraph@1.4.18` already depends on `langgraph-checkpoint ^1.1.5`, so it should dedupe to
the same copy.

**Order of verification**, cheapest first, and each step decides whether the next is worth
paying for:

1. `yarn install`, then `typecheck`, `lint`, `test:unit`, `test:service`. No stores, no key.
2. Stores up, `DATABASE_URL`/`NEO4J_URI` exported, then `test:integration` — asserting 27
   _passed_, because with the variables unset the suite reports 27 skipped and exits 0
   (`.context/conventions.md:92-97`).
3. `EVAL_CASSETTE_MODE=replay yarn eval` twice, with `GOOGLE_API_KEY` unset. This is the
   check P1-B exists for. It proves the graph, the checkpointer, the retrieval path and the
   memory writes behave as recorded, with the committed cassettes. It does not re-record:
   the request hash is sha256 over canonical JSON of `{ seam, label, request }`
   (`hash.ts:60-73`), and every `request` is built from strings this repository assembles —
   `plan.node.ts:28-35`, `runs.service.ts:228-231`, `extraction.ts:3-4` — and plain
   `{ role, content }` objects (`state.ts`, via `WorkingMemorySchema`). No LangChain message
   class and nothing LangGraph serializes enters a hash, so a LangChain change cannot move
   one. The trial confirms it.
4. **Live, once.** `EVAL_TRIALS=1 yarn eval` with the key set and `EVAL_CASSETTE_MODE`
   unset, so no cassette is written. The committed set records what one trial of each task
   costs: `memory-recall-001` makes 3 `generateContent` calls (`plan`, `selectTool`,
   `extractEntities`) and `tool-use-001` makes 5 (`plan`, three `selectTool`,
   `extractEntities`) — **8 of the ~20 a free-tier day allows**, plus 21 `embedContent`
   calls, which go through `gemini-embedder.ts` and not through the upgraded client. This is
   the step that covers `ChatGoogleGenerativeAI` at `2.3.2`: `token_counts_positive` fails
   if `usage_metadata` stopped mapping, `entity_merged` fails if the JSON-mode call stopped
   returning parseable JSON, and `tool_trajectory_recall` fails on `tool-use-001` if
   `selectTool` did. None of the graders fails on an empty plan, so the transcript is read
   for that.

**Deploying it.** No schema migration, no drain. A thread in flight when the old process
stops resumes under the new one, and a rollback resumes a thread the new one started — both
measured above. The one operational difference is the retry schedule, which is faster, not
slower.

## Acceptance criteria

Every criterion names the axis it is checked on. "Stub" and "replay" are model axes; the
memory axis is `live` wherever stores are named.

- [ ] `apps/agent-service/package.json` declares `@langchain/langgraph`, `@langchain/core`,
      `@langchain/langgraph-checkpoint`, `@langchain/langgraph-checkpoint-postgres` on `^1`
      and `@langchain/google-genai` on `^2`, and `yarn.lock` holds exactly one entry for each
      of those five packages.
- [ ] `yarn install` prints no `YN0002` or `YN0060` line naming an `@langchain/` package.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.
- [ ] Model stub, memory unconfigured: `yarn turbo test:unit` passes at least the 254 tests
      it passes at `4516f4e`, and `yarn turbo test:service` passes 5 of 5.
- [ ] Memory live: `yarn turbo test:integration` reports 27 passed and 0 skipped.
- [ ] Model replay, memory live: `EVAL_CASSETTE_MODE=replay yarn eval` passes all 21 grader
      results with the committed cassettes, logs no `eval.replay.live-call`, and two
      consecutive runs produce reports identical once run ids and latencies are masked.
- [ ] `git diff main -- packages/eval-harness/datasets` is empty on the implementing branch.
- [ ] Model live, memory live: one trial of each task (`EVAL_TRIALS=1`, no cassette mode)
      passes every grader, using no more than 8 `generateContent` calls, and each trial's
      transcript carries a non-empty assistant message.
- [ ] Memory live: the pull request carries the output of the cross-version resume check
      from the Problem section, in both directions — a thread left at `next: ['reflect']`
      resumes to `success` with zero `distill` calls — and `checkpoint_migrations` still tops
      out at `v = 4` after the 1.x `setup()`.
- [ ] `gemini-embedder.ts` no longer says the direct call exists "until" the upgrade, and
      `docs/prd/README.md` names the new pins where it names `0.4.10` and `0.1.3` today.

## Risks and open questions

- **The live criterion can fail for a reason that is not the upgrade.** One live trial is
  one sample of a non-deterministic model. The recording run at `021c6f2` passed every
  grader on the same tasks, so a grader failure at 1.x is evidence against the client until
  shown otherwise — but showing otherwise means re-running on the old pins, which is another
  8 calls. The resolution is to run the 0.x trial first only if the 1.x one fails, and to
  compare transcripts rather than pass flags.
- **The versions will have moved by the time this is picked up.** `langgraph` has shipped 18
  releases on 1.4 alone. The design names the versions trialled; the implementation
  takes whatever is current and re-runs every step. If a later release breaks the replay, the
  trial's table is the baseline to diff against.
- **Node.** The migration guide says every LangGraph 1.x package needs Node 22 or later,
  though the published `engines` fields say `>=18` (`langgraph`) and `>=20`
  (`core`, `google-genai`). The repository is on 24 in every place `yarn lint:docs` checks
  — `ci.yml:14`, `Dockerfile:1` of each app — so neither reading blocks it.
- **What the checkpoint check did not cover.** The probe resumed a linear graph with one
  conditional edge and no interrupts, sends or subgraphs, because that is the graph this
  repository has. A graph that gains any of those (P3-B's audit replay, P4-C's approval gate)
  should not cite this check as evidence that its checkpoints cross versions.
- **Open question — should the cross-version resume check be committed?** It needs two
  versions of the same package in one process, which a workspace cannot hold, so the PRD
  asks for its output in the pull request rather than a test. If the reviewer wants it
  repeatable, the cost is a second workspace pinned to the old line, and that is probably
  more machinery than a one-time migration earns.

## References

- LangGraph.js v1 migration guide, `docs.langchain.com/oss/javascript/migrate/langgraph-v1`
  — the breaking changes listed there are `createReactAgent`, `toLangGraphEventStream`,
  `dist/` imports and the Node floor; this repository uses none of the first three.
- npm registry: `npm view <package> versions`, `peerDependencies`, `dependencies`, read
  2026-09-26 for each package named above.
- ADR 0001 — LangGraph and its Postgres checkpointer as the persistence layer.
- ADR 0005 — record at the decision seam; the "It survives the client" consequence this PRD
  tests.
- P1-B — the cassette set and the replay mode used as the regression check.
- P2-A, "Checkpointer and thread identity" — why the saver is on `0.1.3` today.
