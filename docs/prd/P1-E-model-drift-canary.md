---
id: P1-E
title: Model-drift canary against pinned and floating model ids
tier: 1
status: draft
size: M
depends_on: [P1-A, P1-B, P1-C]
blocks: []
issue: null
superseded_by: null
---

# P1-E · Model-drift canary against pinned and floating model ids

## Problem

Nothing in this repository can tell whether the model behind a model id has changed. Every
fact below was checked on 2026-09-26 at `32daf96`. The ones about the API were checked
against it with the developer key: five `models.get` calls (two of them for ids that do not
exist), one `models.list`, and two `embedContent` calls. No `generateContent` call was made.

**The code names two ids, and they are the most pinned ids that exist.** Chat is
`CHAT_MODEL = 'gemini-2.5-flash'` (`apps/agent-service/src/runs/runs.service.ts:63`), used by
both clients (`:201-202`). Embeddings are `EMBEDDING_MODEL = 'gemini-embedding-001'`
(`packages/memory-core/src/semantic/embedding.ts:25`), called at
`apps/agent-service/src/agent/model/gemini-embedder.ts:32`. Google's model pages list both as
"Stable". `GET /v1beta/models/gemini-2.5-flash` returns `"version":"001"`, and
`gemini-2.5-flash-001` returns `404 Model is not found`. `models.list` has no dated variant
of either id. So "pinned" in this PRD means the stable id, because there is nothing more
pinned to use. Google's own wording is that stable models "usually don't change".

**The floating alias does not say what it points at.** `GET /v1beta/models/gemini-flash-latest`
returns `"version":"Gemini Flash Latest"`, which is the display name and not a target. The
changelog says the alias moved to `gemini-3-flash-preview` on 2026-01-21 and to
`gemini-3.5-flash` on 2026-05-19. Later entries do not say where it points. Only a
`generateContent` response names the model that answered, in its `modelVersion` field.

**The cassette header records the id that was requested, not the model that answered.** The
header schema has `chatModel` and `embeddingModel` as plain strings
(`packages/agent-cassette/src/types.ts:54-55`). The recorder fills them from the two
constants (`apps/agent-service/src/eval/cassette-deps.ts:207-209`). The player refuses a set
whose ids differ from the running configuration (`packages/agent-cassette/src/player.ts:191-199`).
A change behind an unchanged id passes that check. The committed set says
`"chatModel": "gemini-2.5-flash"` and `"recordedAt": "2026-09-11T01:48:09.269Z"`
(`packages/eval-harness/datasets/memory-recall/cassettes/memory-recall-001.trial-0.json:6-13`).

**The chat path drops `modelVersion`.** P2-C found that `@langchain/google-genai@0.2.18`
builds its message from the first candidate and `usageMetadata` only, and that the pinned
`@google/generative-ai@0.24.1` type does not declare the field
(`docs/prd/P2-C-otel-genai-semantics.md:309-313`). So no live run in this repository has ever
seen the chat model's version string, and none of the logs or cassettes contains it. P2-C
expects the field to become reachable with P5-C's client upgrade. **It does not.** P5-C
targets `@langchain/google-genai@2.3.2` (`docs/prd/P5-C-langgraph-1x.md:32`). That version's
`mapGenerateContentResultToChatResult` still destructures `response.candidates[0]` and puts
only the candidate's fields into `additional_kwargs` (`dist/utils/common.js:276-356`).
`grep -rn modelVersion` over its `dist` returns nothing. So the upgrade leaves the chat model's
version out of reach of anything built on the LangChain client.

**The embedding path has no version field at all.** Both `embedContent` responses on
2026-09-26 had exactly one top-level key, `embedding`, whose only key is `values`. No response
header named a model. The embedder reads `body.embedding?.values` and nothing else
(`gemini-embedder.ts:49-50`). For embeddings, the vector is the only signal there is.

**The embedding signal is exact, and it is cheap.** The first decision in
`memory-recall-001.trial-0.json` is an `embed` of
`What are the key components of a stateful agent system?`, recorded on 2026-09-11. On
2026-09-26 that text was embedded twice through the same request shape
(`outputDimensionality: 768`), then L2-normalised and rounded to float32 the way the
recorder stores it (`packages/agent-cassette/src/vector.ts:19-29`). Both vectors were
**bit-identical** to the recorded one, and to each other: cosine `1.000000000`, largest
per-component difference `0`. That is one text, three observations, fifteen days apart.
It is not a noise study. It does mean the detection rule can start at "identical" rather
than at a cosine threshold picked by guessing.

**Three documents hand this PRD the defect, and none says how to detect it.** ADR 0005 says
a replayed number "cannot catch the model getting worse — that is P1-E"
(`docs/adr/0005-decision-seam-rather-than-transport-for-replay.md:89-93`). P1-B assigns
"pinned-versus-floating model ids" here (`docs/prd/P1-B-agent-cassette.md:115-116`). P2-B says
its recorded embeddings freeze the model and that "P1-E's canary is the answer to it there
too" (`docs/prd/P2-B-retrieval-ablation.md:613-615`). The re-record rule lists "the chat or
embedding model id" as a trigger (`.context/conventions.md:125-128`). It does not list the
model behind the id changing, because nothing would notice.

**P1-C hands over three pieces of work and, conditionally, two criteria.** Its non-goals give
P1-E the job of naming the chat model id in a live report (no reporter prints it; `SuiteReport`
at `packages/eval-harness/src/types.ts:325-340` has no model field), pinned versus floating
ids, and comparing the nightly live decisions with the committed cassettes
(`docs/prd/P1-C-tiered-eval-pipeline.md:147-151`). Its decision 1 says that "the two criteria
that need [the secret] pass to P1-E if it is still absent at ship time" (`:420-424`). Only one
of its criteria names P1-E (`:382-387`). The criteria section below says which two this PRD
takes and why.

**One older hand-off is already closed.** P2-A's criterion says "**P1-E** owns closing row 16"
(`docs/prd/P2-A-wire-memory-core.md:522-523`). Its own post-ship correction found that the
credential was fine (`:540-544`), and `docs/STATUS.md:46` has row 16 `implemented`, verified
against a live key. P2-A is shipped and is not edited, so this PRD records that it inherits
nothing from that line.

## Why it matters

Pinning a model version is standard practice. Watching the pinned version with a canary is
standard practice for the same reason: a provider can change what serves a stable id, and
it can retire the id. Deprecation dates exist for both ids used here. `gemini-embedding-001`
shuts down on 2028-05-14, and `gemini-2.5-flash` has "no shutdown date announced". This
repository has now committed a replay tier (P1-B, P1-C) that serves recorded model output.
Its accepted ADR says that tier cannot see the model change and names this PRD as what
does. Without a canary, a replayed pass rate and P2-B's recorded-embedding ablation are
numbers whose validity decays at an unknown rate, and nothing records when they stopped
being true. The canary turns "the model might have changed" into a dated observation, at a
cost that fits in the free tier.

## Scope

- **`yarn canary`**: four probes against the two stable ids and the floating alias. It needs
  a key and no stores. It writes `canary-report.json` and `canary-summary.md`, or
  `canary-abort.json` and `canary-summary.md` if it aborts.
- **A committed baseline**, `packages/eval-harness/datasets/canary/baseline.json`: the
  metadata and `modelVersion` strings observed on the first live run, and the probe vectors
  taken from the committed cassettes at `021c6f2`. Re-baselining is a deliberate command,
  like re-recording.
- **The decision comparison P1-C handed over**: a pure function over a live run's recorded
  cassettes and the committed set, run on the nightly artifact at no model cost.
- **Model ids in every report**: `SuiteReport` gains `models: { chat, embedding }` on the
  `live` and `replay` axes, printed in all three reporters.
- **`EVAL_CHAT_MODEL`**: an override for the chat id, used by a live run started by hand to
  run the suite on the floating alias. It is resolved once, so the id is still spelled in
  one place.
- **A `canary` job** in `agent-eval.yml`, on the schedule and on dispatch. It uses the same
  secret gate P1-C's live job uses.
- The two P1-C criteria that pass here if P1-C ships without a repository secret.
- Documentation the change makes false or incomplete (the last criterion).

### Non-goals

- **Deciding whether a drift result blocks anything.** That is **P1-D**. P1-D owns required
  checks and baselines. The canary goes red on a pinned `changed` or `gone`. That blocks
  nothing until a check is required, and `main` has no branch protection
  (`docs/prd/P1-C-tiered-eval-pipeline.md:53-54`).
- **Statistical detection of a behavioural change** from pass rates. **P1-D**. One live trial
  per task per night is a sample, and a paired comparison of live rates over time is the
  gate P1-D designs. The canary's behavioural output is descriptive (see Design).
- **Recording `modelVersion` on every live call, and in the cassette header.** The chat
  client drops it at `0.2.18`, and still drops it at P5-C's `2.3.2` (Problem). Either
  record needs a chat path that does not go through LangChain's response mapping, which
  means replacing the production chat client. **No PRD owns this.** P2-C leaves
  `gen_ai.response.model` out and names P5-C as the point where it becomes reachable
  (P2-C:309-313). That hand-off rests on the upgrade exposing the field, which it does not.
  Until someone decides to replace the chat client, the canary's direct probe is the only
  source of the string. It is not a stopgap waiting for P5-C.
- **Migrating off `gemini-2.5-flash` or `gemini-embedding-001`.** A migration re-records
  every cassette and changes `EMBEDDING_DIMENSIONS`'s justification
  (`embedding.ts:1-19`). The canary reports what the floating alias resolves to and
  whether one trial passes on it. That is an input to a migration, and no PRD owns the
  migration yet because no shutdown date forces one before 2028-05-14. When a date does,
  the migration is a new PRD, and the canary's floating result is its first evidence.
- **Re-recording cassettes when the canary fires.** Re-recording stays a deliberate local
  command (`.context/conventions.md:133`). P1-C rejected it in CI for secret-exposure
  reasons. The canary summary prints the command.

## Design

### What each probe compares

| Probe             | Id                                                                | Signal                                                                                   | Calls per run                                  | Baseline                                                                 |
| ----------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------ |
| metadata          | `gemini-2.5-flash`, `gemini-embedding-001`, `gemini-flash-latest` | `version`, `displayName`, HTTP 404                                                       | 3 `models.get`, no inference                   | observed 2026-09-26: `001`, `001`, `Gemini Flash Latest`                 |
| chat, pinned      | `gemini-2.5-flash`                                                | `modelVersion`                                                                           | 1 `generateContent`                            | the first live run of the canary                                         |
| chat, floating    | `gemini-flash-latest`                                             | `modelVersion`                                                                           | 1 `generateContent`, on the target's own limit | the first live run of the canary                                         |
| embedding         | `gemini-embedding-001`                                            | float32 bit-identity per probe, cosine where it differs                                  | 21 `embedContent`                              | the 21 `embed` decisions in the committed cassettes, recorded 2026-09-11 |
| decisions (night) | whatever the live job ran                                         | identity of `embed` decisions present in both sets; first divergence; tool-call sequence | 0                                              | the committed cassettes                                                  |

Each probe answers a different question, and none substitutes for another:

- **Metadata** is free of inference quota and catches retirement. A 404 on a pinned id is
  `gone`. It cannot see a silent change, because `version` is `001` and stays `001`.
- **Chat `modelVersion`** is the only place the API names the model that answered. It is a
  string the provider controls, so an unchanged string is not proof that the weights are
  unchanged. A changed string is proof that something changed.
- **Embedding identity** is the one deterministic signal. It was measured as bit-identical
  across fifteen days (Problem). Any vector that differs means the model or its serving
  changed. It also answers P2-B's question directly: every vector set recorded on or after
  the baseline date is still what the model returns today.
- **Decisions** is the behavioural signal, and it costs nothing, because the nightly live
  job (P1-C) already records a cassette per trial. It is descriptive. A chat model sampled
  at the default temperature is not expected to reproduce text, so text inequality is not
  reported as drift.

The 21 embedding probes are every `embed` decision in the committed set: 14 from
`memory-recall-001.trial-0.json` and 7 from `tool-use-001.trial-0.json`, all distinct texts.
They are copied into the baseline once, with the cassettes' `recordedAt` and `gitSha` as
provenance. After that the baseline does not follow the cassettes, so re-recording a
cassette after a prompt edit cannot quietly move the reference point.

### Quota

The daily `generateContent` limit this repository runs into is the free tier's twenty
(`.context/conventions.md:133`). Rate limits apply per project, not per key, and reset at
midnight Pacific.

| Per night                              | `generateContent` on `gemini-2.5-flash` | `generateContent` on the alias target | `embedContent` |
| -------------------------------------- | --------------------------------------- | ------------------------------------- | -------------- |
| P1-C live tier, one trial of each task | 8                                       | 0                                     | 21             |
| canary probes                          | 1                                       | 1                                     | 21             |
| decision comparison                    | 0                                       | 0                                     | 0              |
| **total**                              | **9 of 20**                             | **1**                                 | **42**         |

The canary adds one call to the budget P1-C already plans for, and leaves eleven for
development if CI shares the developer's project. The alias target has its own limit only
if the free tier counts per resolved model. AI Studio lists limits per model, but whether an
alias shares its target's bucket has not been checked (Risks). The `embedContent` free-tier
limit is published only in AI Studio and has not been read. A live trial of both tasks
already makes 21 embedding calls, so the canary at most doubles an amount that has never hit
a limit.

A hand-started suite run on the floating alias (`EVAL_CHAT_MODEL`) costs about eight calls on
the alias target's limit. It runs on `workflow_dispatch` only, never on the schedule.

### Interface

```ts
// apps/agent-service/src/eval/canary/probes.ts
export type Verdict = 'unchanged' | 'changed' | 'gone' | 'moved' | 'unobserved';

export interface ProbeResult {
  readonly probe: 'metadata' | 'chat-pinned' | 'chat-floating' | 'embedding';
  readonly id: string;
  readonly verdict: Verdict;
  readonly baseline: string | undefined; // the string or the baseline date compared against
  readonly observed: string | undefined;
  readonly detail?: string; // e.g. "3 of 21 vectors differ; min cosine 0.99871"
}

/** One direct `generateContent` call. Reads `modelVersion`, `finishReason` and `usageMetadata`. */
export function probeChatVersion(id: string, apiKey: string): Promise<ChatVersionObservation>;

/** Through `createGeminiEmbedder`, so the probe exercises the production response check and `l2Normalize`. */
export function probeEmbeddings(
  embed: (text: string) => Promise<number[]>,
  baseline: EmbeddingBaseline,
): Promise<ProbeResult>;
```

The chat probe calls `generateContent` directly with `fetch`, the way `gemini-embedder.ts`
already does for embeddings. LangChain's client is not used because it discards the one
field the probe exists to read. The prompt is fixed and short, with a small
`maxOutputTokens`. A thinking model can finish with `MAX_TOKENS` and no text, which does not
matter because only `modelVersion` is read. The probe records `usageMetadata` as it arrives.
That is also the first observed live answer to P2-C's unverified assumption that
`totalTokenCount` is the sum of prompt, candidate and thought tokens (P2-C:318-327). P2-C's
own criterion still owns checking it.

`yarn canary` refuses to run without `GOOGLE_API_KEY`, and it names the variable. There is
no stub fallback: a canary that measures a canned model reports "unchanged" forever. This is
the failure `EVAL_EXPECT_AXES` exists to prevent in the suite (P1-C). A daily-quota 429 is
classified by P1-C's `classifyRateLimit` and aborts the run. Only an abort writes
`canary-abort.json`, and `canary-report.json` then does not exist, which is the same
contract P1-C sets for `eval-report.json`.

### Verdicts and exit

| Probe          | `unchanged` | `changed` / `gone`       | `moved`        | `unobserved`         |
| -------------- | ----------- | ------------------------ | -------------- | -------------------- |
| metadata       | exit 0      | exit 1                   | —              | —                    |
| chat, pinned   | exit 0      | exit 1                   | —              | exit 1: field absent |
| chat, floating | exit 0      | —                        | exit 0, notice | notice               |
| embedding      | exit 0      | exit 1, cosines reported | —              | —                    |

A pinned `changed` goes red because it falsifies the premise the replay tier and P2-B's
recorded embeddings rest on. A floating `moved` is expected, and it is information about
the next model, not a defect in this one. `unobserved` on the pinned probe goes red because
a missing field is how a silent fallback starts. That is the lesson of P2-A's post-ship
correction.

The summary names the date of the last baseline that matched. "The embedding model has
returned identical vectors since 2026-09-11" is the sentence a reader of a replayed or
ablation number needs.

### The decision comparison

```ts
// apps/agent-service/src/eval/canary/compare-cassettes.ts
export interface DecisionComparison {
  readonly taskId: string;
  readonly trialIndex: number;
  /** `embed` decisions whose requestHash is in both sets, and how many are bit-identical. */
  readonly sharedEmbeds: {
    readonly count: number;
    readonly identical: number;
    readonly minCosine: number;
  };
  /** The first live decision whose requestHash the committed trial lacks, by seam and position. */
  readonly firstDivergence: { readonly seam: string; readonly index: number } | null;
  /** Tool names chosen by `act.selectTool`, in order, on each side. */
  readonly tools: {
    readonly committed: readonly (string | null)[];
    readonly live: readonly (string | null)[];
  };
}

export function compareCassettes(committed: Cassette, live: Cassette): DecisionComparison;
```

The comparison is a pure function, so it is tested offline on fixture cassettes. In CI it
runs in a step that downloads the live job's artifact, using `needs: live`. It makes no
model call, and the existing `undici:request:create` watcher (`cassette-deps.ts:335-349`)
fails the step if one is attempted. The user's message is identical on every run, so the
first `embed` of each trial is always shared. That makes `sharedEmbeds` a free embedding
check on the nightly, alongside the probe's 21.

### `EVAL_CHAT_MODEL`

```ts
// runs.service.ts — still the one place the id is spelled
export const CHAT_MODEL = process.env['EVAL_CHAT_MODEL'] || 'gemini-2.5-flash';
```

It is resolved at module load, so the recorder header (`cassette-deps.ts:207`), the replay
configuration (`:249`) and both clients (`runs.service.ts:201-202`) still read one value.
A replay under an override is refused by the existing check (`player.ts:191-195`) before any
store is reset, so the replay tier cannot run on an overridden id by accident. The variable
is declared on `turbo.json`'s `eval` task (`:43-52`); otherwise strict mode strips it
silently. P1-C's live job gains a `chat_model` dispatch input. The report's new `models`
field makes the id visible, so a run on the floating alias cannot be read as a run on the
stable one.

### Workflow

```yaml
canary:
  needs: gate # the job P1-C's live tier uses to read whether the secret exists
  if: needs.gate.outputs.has_key == 'true' && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch')
  concurrency: { group: eval-live, cancel-in-progress: false } # the same quota as the live job
  env:
    GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
    EVAL_OUTPUT_DIR: ${{ runner.temp }}/canary
  steps: # checkout, install, yarn canary, summary and artifact with if: always()

compare:
  needs: [live]
  if: always() && needs.live.result != 'skipped'
  steps: # download eval-live, run compareCassettes against the committed set, summary
```

No service containers. The canary needs no stores, which is why it can also run on a
laptop with nothing but the key.

## Acceptance criteria

Each criterion names the axis that verifies it. **Stubbed transport** means `fetch` is
replaced and no request leaves the process. **Model `live`** means a real key; where it says
**in CI**, it means the repository secret. The canary has no memory axis.

- [ ] **Stubbed transport:** `probeChatVersion` makes exactly one request, to the id it is
      given. It returns the response's `modelVersion`. A response without the field yields
      `unobserved`, never `unchanged`.
- [ ] **Stubbed transport:** `probeEmbeddings` goes through `createGeminiEmbedder`. It returns
      `unchanged` for vectors that are bit-identical after float32 encoding, and `changed`
      when one component of one vector differs, with that vector's cosine in `detail`.
- [ ] **Stubbed transport:** the verdict table holds. A pinned `changed`, `gone` or
      `unobserved` exits 1 and writes `canary-report.json`. A floating `moved` exits 0 with a
      notice. A 404 on `models.get` for a pinned id is `gone`. One runner test per row.
- [ ] **Stubbed transport:** a 429 whose details carry a per-day `QuotaFailure` on the chat
      probe makes one request, writes `canary-abort.json` and a summary naming the daily
      quota, and writes no `canary-report.json`.
- [ ] **Stubbed transport:** one canary run makes exactly 3 metadata requests, 2
      `generateContent` requests and 21 `embedContent` requests, counted by an
      `undici:request:create` subscription. The live summary prints the same three counts.
- [ ] `GOOGLE_API_KEY= yarn canary` exits non-zero, names the variable, and makes no request.
      **No model axis, on purpose:** the refusal is what is being tested.
- [ ] **Model `live`, local key:** the first canary run observes `modelVersion` for
      `gemini-2.5-flash` and `gemini-flash-latest`, and writes both into `baseline.json` with
      the date. This PRD's Problem section is updated with the observed strings, because
      today it can only say that no run has seen them.
- [ ] **Model `live`, local key:** on that run the embedding probe reports `unchanged` for
      all 21 baseline vectors. One of the 21 was already checked while drafting, on
      2026-09-26. If any differs, the criterion stays unchecked and the finding goes into
      this PRD's Problem section before anything else is built.
- [ ] **Stubbed transport:** `compareCassettes` is unit-tested on fixture cassettes for a
      shared identical embed, a shared differing embed, a divergence at a known position,
      and a changed tool sequence.
- [ ] **Model `replay` / memory `live`:** all three reports name `models.chat` and
      `models.embedding`, taken from the cassette headers. **Model `live` / memory `live`:**
      the same, taken from the running configuration, checked on one local trial.
- [ ] **Model `replay` / memory `live`:** `EVAL_CHAT_MODEL=gemini-flash-latest` with
      `EVAL_CASSETTE_MODE=replay` refuses with `CassetteIncompatibleError` naming both ids,
      before any store is reset. `EVAL_CHAT_MODEL` is declared on `turbo.json`'s `eval`
      task.
- [ ] **Model `live` / memory `live`, local key:** one trial of each task with
      `EVAL_CHAT_MODEL=gemini-flash-latest`. The report names that id, and the result is
      recorded in this PRD whether it passes or fails. A failure is a finding about the
      next model or about the pinned client (P5-C), not a defect in this PRD. About eight
      calls on the alias target's limit.
- [ ] **Model `live`, in CI:** with the secret present, one scheduled run runs `canary` and
      `compare`. Both write to `$GITHUB_STEP_SUMMARY` and upload an artifact. `compare`
      reports no request to `generativelanguage.googleapis.com`. With no secret, `canary`
      shows as skipped, and the replay job's summary says so. It never shows as passed.
- [ ] **Taken from P1-C, if P1-C ships without a secret:** with the secret present, one
      nightly run runs both tasks on model `live` / memory `live`, skips neither, and
      uploads the three reports and the recorded cassettes. This is P1-C:382-387
      unchanged. It closes P1-G:183 through P1-C.
- [ ] **Taken from P1-C, if P1-C ships without a secret:** with the secret configured but
      the run detected on any other axis, the live job fails before any trial with the
      axis-expectation message. This is the secret-present half of P1-C:374-381. Its
      no-secret half is checkable without a key and stays with P1-C.
- [ ] Documentation the change makes false or incomplete is corrected in the same pull
      request. `.context/conventions.md:125-128` adds "the canary reports `changed`" to the
      re-record triggers. `docs/STATUS.md` gains a row for the canary. Row 18's "(P1-E)"
      becomes a pointer to that row. `packages/agent-cassette/README.md:74` is updated the
      same way.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

**Why these two from P1-C.** P1-C's decision 1 says two criteria pass here, and names
P1-E on one of them. The second is taken to be the secret-present half of its live-job
criterion, because that half is the only other part of P1-C that cannot be checked without
a repository secret. The live 429 criterion (P1-C:366-373) says it can be checked with a
local key, so it stays with P1-C. If P1-C ships **with** a secret, both close there and the
two criteria above are removed from this PRD before it is accepted.

## Risks and open questions

**Open questions that change scope.**

1. **Is a `GOOGLE_API_KEY` repository secret added?** This is the owner's decision (P1-C
   decision 1), and this PRD does not assume an answer. **Without one**, the canary is a
   command a developer runs, not a canary. The CI job shows as skipped, and the two
   criteria taken from P1-C and the CI criterion above stay unchecked. This PRD is the
   end of the chain those criteria were handed along (P1-G → P1-C → P1-E), and no later
   PRD needs them more. The draft's proposal is that **P1-E does not ship without the
   secret**, rather than handing them on again. It would stop at `in-progress` with every
   offline and local criterion met. The alternative is to split the CI criteria into a
   PRD whose only content is "add the secret", which records the dependency without
   adding anything.
2. **Is the floating-alias suite run in scope?** The alias points at a different model
   generation (`gemini-3.5-flash` since 2026-05-19, or later), so comparing it with
   `gemini-2.5-flash` is a migration study, not drift detection. The draft keeps it: the
   title promises a floating comparison, and it costs one override, a dispatch input and
   one local run. If review drops it, the floating probe still reports what the alias
   resolves to.
3. **Should a pinned `changed` go red?** The draft says yes (see Design). The cost is a red
   scheduled job, which notifies the user who last edited the cron line and blocks
   nothing. The alternative is a notice. A notice is also what nobody reads.

**Risks.**

- **The premise may produce no events.** "Stable models usually don't change." The
  canary may report `unchanged` for years. That result is useful: it turns every replayed
  and recorded number into one with a dated validity. But it means the red path is only
  ever exercised by the stubbed-transport tests.
- **`modelVersion` may be too coarse to see a change.** If the API returns the requested id
  unchanged for any update behind it, the pinned chat probe can only detect retirement and
  an alias move. Embedding identity has no such limit, and the chat model has no
  deterministic equivalent under sampling. The first live criterion finds out what the
  string looks like. If it is only the id, the Design says so, and the chat side relies on
  the decision comparison until P1-D.
- **Bit-identity may be too strict.** It held three times over fifteen days for one text.
  If serving nondeterminism appears (a different accelerator, a different batch), the rule
  changes at review to a cosine floor measured from the observed noise. It is not tuned
  down to make a red run go away.
- **Unchecked quota facts.** Whether `models.get` counts against any limit, whether the
  `-latest` alias shares a quota bucket with its target, and the free-tier `embedContent`
  limit have not been checked. Each could change the budget table. The first CI run with the
  secret prints the counts, and AI Studio shows the limits to whoever owns the project.
- **Scheduled workflows stop by themselves.** In a public repository GitHub disables
  scheduled workflows after 60 days without repository activity. A disabled canary produces
  no red run and no report. Nothing in this PRD detects its own absence. `docs/STATUS.md`'s
  new row should give the date of the last scheduled run, and it goes stale visibly.
- **The floating run may fail in the client, not the model.** `@langchain/google-genai@0.2.18`
  predates the Gemini 3 series. A failure there is evidence for P5-C, and the criterion
  that runs it says so.
- **Sizing.** `M`, against the index's `S`. The known work is a CLI with four probes, a
  baseline file, a pure comparison, a report field, an override and two workflow jobs.
  Each has offline tests, and together they are already past two days. The workflow jobs
  have never run, and the shape of `modelVersion` has never been observed. By the rule P0-A
  learned, both have an unknown number of defects behind them.

## References

- ADR 0005, `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md`: what replay
  cannot see, and the hand-off to this PRD.
- `docs/prd/P1-C-tiered-eval-pipeline.md`: the live tier, the secret gate, the abort contract,
  `classifyRateLimit`, and the criteria taken over here.
- `docs/prd/P2-C-otel-genai-semantics.md`: why `gen_ai.response.model` is not reachable on the
  pinned chat client.
- `@langchain/google-genai@2.3.2`, `dist/utils/common.js` (`npm pack @langchain/google-genai@2.3.2`):
  the response mapping that keeps `modelVersion` out of reach after P5-C.
- Gemini model versions (stable, preview, latest, experimental; the two-week notice for a
  breaking change behind `-latest`): https://ai.google.dev/gemini-api/docs/models
- `gemini-2.5-flash` and `gemini-embedding-001` model pages ("Stable"):
  https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash,
  https://ai.google.dev/gemini-api/docs/models/gemini-embedding-001
- `GenerateContentResponse.modelVersion` ("The model version used to generate the
  response"): https://ai.google.dev/api/generate-content
- `models.get` and the `Model` resource's `version` field: https://ai.google.dev/api/models
- Deprecation schedule (`gemini-embedding-001` shutdown 2028-05-14; `gemini-2.5-flash` none
  announced; announcements go to the release notes):
  https://ai.google.dev/gemini-api/docs/deprecations
- Release notes, including the `gemini-flash-latest` moves on 2026-01-21 and 2026-05-19:
  https://ai.google.dev/gemini-api/docs/changelog
- Rate limits (per project, daily reset at midnight Pacific, figures in AI Studio):
  https://ai.google.dev/gemini-api/docs/rate-limits
- Notifications for scheduled workflow runs:
  https://docs.github.com/en/actions/concepts/workflows-and-actions/notifications-for-workflow-runs
- Disabling and enabling a workflow (60-day inactivity rule for scheduled workflows in public
  repositories):
  https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/disabling-and-enabling-a-workflow
