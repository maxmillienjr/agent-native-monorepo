---
id: P1-F
title: Cost, latency, and step budgets as CI assertions
tier: 1
status: in-progress
size: M
depends_on: [P1-A, P1-B, P1-C, P2-C]
blocks: []
issue: 85
superseded_by: null
controls: [CTL-COST-01]
---

# P1-F · Cost, latency, and step budgets as CI assertions

## Problem

No run of the agent is checked against a token, call or time limit, and the number a run
reports as its token usage counts one model call in three or five. Every fact below was
checked on 2026-09-26 at `32daf96`.

**`RunResponse.tokenCounts` is the `plan` call and nothing else.** The schema declares the
field (`packages/agent-contracts/src/run-response.schema.ts:15`), and `buildRunResponse`
copies it from state (`egress.node.ts:31`). The only writer of `state.tokenCounts` is
`plan` (`plan.node.ts:49-52`). `selectTool` and `extractEntities` go through the same
chat client, which computes usage for every call (`runs.service.ts:204-218`), and return
the parsed value without it (`:227-245`). The `completion` half is LangChain's
`output_tokens` (`:215`), which P2-C traces to `candidatesTokenCount` — the visible answer,
without the thinking tokens `gemini-2.5-flash` is billed for. Three things consume the
field as if it were the run's usage: the audit log (`audit.interceptor.ts:25-26`), the
episode metadata `reflect` writes (`reflect.node.ts:48`), and the transcript the harness
grades (`agent-harness.ts:154`, graded by `token_counts_positive`, `code.ts:62-69`).

A replay of the committed set on 2026-09-26 (model `replay` / memory `live`, disposable
containers, 21s wall clock, every grader passed) reported `{"prompt":58,"completion":922}`
for `memory-recall-001` and `{"prompt":68,"completion":217}` for `tool-use-001`. Those are
the two `plan.callLlm` decisions and nothing else. The first task made three
`generateContent` calls and the second made five.

**The cassettes record usage for one seam.** `tokenCountsFor` returns `undefined` for
every seam except `plan.callLlm` (`cassette-deps.ts:62-74`), and its comment names this
PRD as the one that wants the rest. In the committed set, the `plan.callLlm` decision is
the only one with a `tokenCounts` field. The four `act.selectTool` decisions and the two
`distill.extractEntities` decisions have none, and no `embed` decision has any.

**On replay, token usage and call count are fixed by the cassette, or the run aborts.**
Two mechanisms make this so, and both were checked:

- _A change that alters a request misses._ The player looks a decision up by a hash of its
  request (ADR 0005). This draft changed the `plan` system prompt (`plan.node.ts:6`) to a
  longer string and ran replay. The run ended `eval.fatal` with
  `cassette miss at seam plan.callLlm` and a recorded-versus-actual diff, and exited 1.
  So a prompt edit that inflates input tokens never reaches a token count on replay.
- _A change that makes fewer calls also aborts._ `replayDecks.close` throws when a
  completed trial leaves recorded decisions unconsumed (`cassette-deps.ts:286-295`). A
  change that makes more calls misses on the first call it adds.

As a result, the token total and the model-call count of a replayed trial are functions of
the committed cassette alone. They change only when the set is re-recorded.

**Latency is not measured anywhere it could mean something.** `Transcript.latencyMs` is
`Date.now()` around the whole trial (`agent-harness.ts:126-128`). On replay that
measured 2,356 ms and 940 ms for the two trials above. The same trials took 40,626 ms and
40,169 ms of model time when they were recorded, according to the `latencyMs` the recorder
keeps on each decision. On the live axis the number includes both local containers. The
recording also shows how much a single model call varies. In `tool-use-001` the three
`act.selectTool` requests are byte-identical (one request hash, `2a2445dc…`), made seconds
apart in one run, and took **1,102 ms, 1,236 ms and 23,094 ms**.

**Steps are capped by the graph, and waste is already measured.** `act` loops until the
model returns no tool or `stepCount` reaches `maxSteps` (`edges.ts:9`, `state.ts:36-37`).
`selectTool` is given the plan and the tool names, and nothing else — not the previous
tool's output (`act.node.ts:30`, `runs.service.ts:229-232`). A successful tool call
continues the loop (`act.node.ts:71`). So once the model selects a tool it gets the same
request on every later iteration, and the loop runs to the cap. `tool-use-001` sets
`maxSteps: 3` and made three `web-search` calls, two of them with the same query. The
existing `tool_trajectory_precision` grader reports this: `0.333` on the replay above.
Its threshold is `0`, so it reports the value and does not gate on it
(`tool-use-001.json`, `dataset.ts:133-137`).

## Why it matters

Kapoor et al. ("AI Agents That Matter", 2024) show what happens when agents are evaluated
on accuracy alone: they end up needlessly costly, and gains get attributed to the wrong
causes. Their conclusion is that cost has to be measured and reported beside accuracy, not
left out. This repository has a sharper version of the same constraint. The unit it runs
short of is the `generateContent` call. The free tier allows twenty a day
(`.context/conventions.md:132-133`), and P1-C's nightly is designed around spending eight
of them. A pull request that adds one model call per `act` iteration changes that
arithmetic, and nothing would report it. Budgets in the task file make a change in cost a
reviewed diff next to the assertion it affects. The design choice is which budgets still
mean something on which axis. A replayed token count is exact but frozen. A live one is
current but a single sample. A replayed duration measures the replay. A budget that ignores
these differences either never fails or fails on noise.

## Scope

- **A `budgets` block in the task file**, beside `requires`, with three keys:
  `inputTokens`, `outputTokens` and `modelCalls`, each a per-trial ceiling.
- **A budget check in `packages/eval-harness`.** It reads usage from `Transcript.spans`
  through P2-C's `GEN_AI` constants. Its results live in the trial beside the grader
  results, not among them, and they are rendered in all three reports.
- **Usage for every chat seam**: `selectTool` and `extractEntities` return their token
  counts the way `callLlm` already does, and `act` and `distill` add them to state, so
  `RunResponse.tokenCounts` becomes the run's total.
- **`completion` counts billed output**, thinking tokens included, using the derivation
  P2-C specifies and verifies.
- **Cassette format version 2.** Every chat decision carries `tokenCounts`, with an
  optional `reasoning` field, and the player refuses a version-1 set with the re-record
  command in the message.
- **One re-recording of the set** on model `live` / memory `live`: one trial of each task,
  about eight `generateContent` calls. The budget values are derived from it.
- **An estimated cost in every report**: a list-price equivalent in US dollars, computed
  from a price table that records its source and the date it was read. The report prints
  it but no check asserts it.
- **Latency is reported on the live axis only, and nothing asserts it.** The schema
  rejects a latency budget, and the error message says why.
- Documentation that this makes false is corrected (see the last criteria).

### Non-goals

- **Relative regression on usage** ("input tokens rose 20% against the baseline"). That
  compares against stored history with a statistical test, which is **P1-D**. Budgets here
  are absolute ceilings checked against one run, and they stay out of the pass rate that
  P1-D compares (see Design).
- **Gating on latency.** This is rejected as an assertion, not deferred, for the reasons in
  the Design. A latency gate would need many live samples compared against a baseline,
  which is P1-D's machinery, so **P1-D** owns any future latency gate. This PRD makes sure
  the live report carries the figures such a gate would use.
- **Asserting dollars.** With one model at one price, a dollar ceiling is a linear
  combination of the two token ceilings and can only disagree with them. Dollars become
  the unit worth asserting once two model ids with different prices are compared.
  **P1-E** runs pinned against floating ids and owns that.
- **Spending fewer tokens.** Capping thinking with `thinkingBudget`, and giving
  `selectTool` the previous tool output so the `act` loop stops re-asking the same
  question, are changes to the agent. Budgets measure the agent; they do not change it.
  **P4-C owns the `act` loop fix**, decided at review (open question 3). Capping thinking
  is not proposed until the nightly's own figures show thinking dominates output; if they
  do, that is an amendment to this PRD, made with the numbers in hand.
- **A step budget other than `modelCalls`.** A tool-call or `act`-iteration ceiling at or
  above `maxSteps` is already enforced by `edges.ts:9`. A ceiling below `maxSteps`
  duplicates `tool_trajectory_precision`, which already measures wasted steps as a quality
  metric. A node-count ceiling is `6 + act iterations`, because every other edge is
  unconditional (`graph.ts:95-105`). Rejected.
- **Pricing embeddings.** The `embedContent` response the embedder reads has no usage
  block (`gemini-embedder.ts:49`), and P2-C records absent usage as absent. The report
  counts embedding calls and marks them unpriced. No PRD owns this, because nothing can
  own it until the API reports embedding usage.
- **Re-recording in CI.** Rejected by P1-C for reasons that still hold. The re-record is a
  local command, run once by this PRD.
- **Emitting budget results as `gen_ai.evaluation.result` events.** The usage they are
  computed from is already on the spans, and P2-C's criterion of one event per grader
  result stays true. Rejected.

## Design

### What each budget means on each axis

| Budget         | Source                                                              | `live`                                        | `replay`                                         | `stub`      |
| -------------- | ------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------ | ----------- |
| `inputTokens`  | Σ `gen_ai.usage.input_tokens` over `generate_content` spans         | a fresh sample                                | the recording's, exactly                         | not checked |
| `outputTokens` | Σ `gen_ai.usage.output_tokens` (thinking included, per P2-C)        | a fresh sample; varies call to call           | the recording's, exactly                         | not checked |
| `modelCalls`   | count of `generate_content` spans, errored ones included            | the model's choices within the graph's bounds | the recording's, exactly                         | not checked |
| latency        | durations of non-replayed `generate_content` and `embeddings` spans | reported, n = 1, never asserted               | not reported (the span duration is replay speed) | —           |
| cost (USD)     | the two token sums × the price table, per `gen_ai.request.model`    | reported                                      | reported, labelled as the recording's            | —           |

**Replay.** The Problem section shows that a replayed trial's usage is fixed by its
cassette, or the trial aborts first. On the replay tier, a budget is therefore a check on
the committed cassettes, run on every pull request. It fails on exactly one kind of pull
request: the one that re-records. That is the pull request that matters. A prompt edit
cannot pass replay until it is re-recorded (P1-C records this as a risk), so the edit and
its new cassettes arrive together, and the new cassettes carry the new token counts. **The
replay tier sees a token-inflating prompt change through the re-recording the change
forces, and in no other way.** A contributor who re-records runs the live axis locally,
which runs the same check, so the breach shows up on their machine before it shows up in
CI.

The same result could be computed by a static script that sums the cassettes, with no
containers. The design runs it through the harness anyway: one code path for both tiers,
one report, and a replay run also checks that P2-C's replayed spans still carry what the
cassette holds.

**Live.** The nightly tier gets a fresh sample from the current model. Input tokens vary
because the `selectTool` and `distill` prompts contain the plan's output
(`runs.service.ts:231`, `plan.node.ts:48`), and output tokens vary with the model. At one
trial a night, a budget breach on live is one sample over a ceiling. So the ceilings are
set loose (open question 1), and a breach is a signal to look, not a measured rate.

**Latency, rejected as an assertion.** Identical requests in one recorded run took between
1.1 s and 23.1 s. A per-call ceiling loose enough never to fire on that spread catches
only a hang, and a job timeout catches a hang already. A tight ceiling fires on provider
noise. On replay the duration is how fast a JSON file is read, and on memory `live` the
store half is a local container. The report shows live latency for a reader to see.
Nothing gates on it.

**Cost.** The free tier bills $0, so on the key this repository has, every run costs
nothing. The cost column is therefore a **list-price equivalent**: what the same tokens
would cost on the paid tier. A budget in tokens means the same thing whichever tier the
key is on. A budget in dollars would pass on the free tier no matter what the run did.

### Where budgets live, and why they are not graders

```text
tool-use-001.json, beside "requires" (token values come from the re-recording, by the rule below):

  "requires": { "model": ["live", "replay"] },
  "budgets": { "inputTokens": <recorded × 1.5>, "outputTokens": <recorded × 2>, "modelCalls": 5 }
```

```ts
// packages/eval-harness/src/types.ts
export const BudgetsSchema = z
  .object({
    inputTokens: z.number().int().positive().optional(),
    outputTokens: z.number().int().positive().optional(),
    modelCalls: z.number().int().positive().optional(),
  })
  .strict(); // `latencyMs` is rejected with a message pointing at this PRD's reasoning

export interface BudgetResult {
  readonly budget: keyof z.infer<typeof BudgetsSchema>;
  readonly limit: number;
  /** null when the transcript cannot support the figure; see `unmeasurable`. */
  readonly actual: number | null;
  readonly label: 'within' | 'breached' | 'unmeasurable';
  /** `recorded` when every inference span carries `agent_native.replayed`. */
  readonly source: 'measured' | 'recorded';
  readonly explanation: string;
}

export interface Trial<TOutcome = Outcome> {
  // ...unchanged...
  readonly budgets: readonly BudgetResult[];
  /** Every budget `within`. Independent of `passed`. */
  readonly withinBudget: boolean;
}
```

The task-level budget sits beside `requires` because it describes the scenario, the same
reasoning `dataset.ts:113-120` gives for `requires`. `Task` gains `budgets?`, and
`taskFromSpec` copies it across as it copies `requires` (`dataset.ts:182`).

**Budgets are not graders.** A trial passes when every grader passes
(`harness.ts:141`, `types.ts:267`). A budget grader would therefore make a trial that
did the task correctly and spent too much count as a failed trial. That would move
`pass@k` and `pass^k`, and P1-D's relative gate would read an over-budget trial as a
drop in quality. Kapoor et al. argue for reporting cost beside accuracy, not inside it. So
`EvalHarness.run` calls `checkBudgets(transcript, task.budgets, axes)` after
`runGraders` (`harness.ts:133`) and stores the results in `Trial.budgets`. `Trial.passed`
and `SuiteReport.passRate` do not change. `SuiteReport` gains `budgetBreaches` and a
`usage` summary. `run-eval.ts:145` becomes
`if (report.passRate < 1 || report.budgetBreaches > 0) process.exitCode = 1`. A breach turns
the job red in the same way a failed grader does, and the summary says which of the two
happened. `GraderKind` (`types.ts:169`) does not gain a `budget` value. It classifies how a
judgement is made (code, model or human), and a budget is judged by code.

### `checkBudgets`

It reads only the trial's own spans. P2-C filters `Transcript.spans` to the trial's trace,
so usage from other trials or tiers is never summed in. P2-C left this PRD responsible for
saying that. The rules:

- **Absent is not zero.** A `generate_content` span without a `gen_ai.usage.*` key, and
  without `error.type`, makes the token budgets `unmeasurable`. So does a transcript with no
  inference spans on the `live` or `replay` axis. `unmeasurable` counts as a breach. Without
  this rule, today's cassettes would pass any token budget, because they record usage for
  one call in three.
- **Errored spans** count toward `modelCalls`, since the request was made, and carry no
  usage. They do not make a trial unmeasurable.
- **Replayed or measured, never mixed.** If every inference span carries
  `agent_native.replayed`, the source is `recorded`. If none does, it is `measured`. A mix
  cannot happen by design, and if it does the trial is `unmeasurable`.
- **On `stub`, nothing is checked.** P2-C emits no inference spans there. The report says
  `budgets not checked on model=stub` in the place where it lists skipped tasks. A stub run
  keeps its exit code.
- **Names come from `@repo/telemetry/genai`.** They are never spelled out as string
  literals here (P2-C's hand-off table).

### Usage for every seam, and what `RunResponse.tokenCounts` means after

```ts
// act.node.ts
selectTool: (plan: string, tools: Tool[]) =>
  Promise<{ selection: { toolName: string; input: unknown } | null; tokenCounts: TokenCounts }>;
// distill.node.ts
extractEntities: (context: string) => Promise<{ extraction: Extraction; tokenCounts: TokenCounts }>;
```

`act` and `distill` add the counts to `state.tokenCounts` in the same way `plan` does
(`plan.node.ts:49-52`). `callWith` (`runs.service.ts:204-218`) sets
`completion = total_tokens − input_tokens` when `total_tokens` is present, and also returns
`reasoning`. This is the same arithmetic P2-C's inference wrapper uses, and both call one
function so they cannot drift apart.

|               | Today                                     | After                                                        |
| ------------- | ----------------------------------------- | ------------------------------------------------------------ |
| Calls counted | `plan.callLlm` only                       | every `generateContent` call a successful node made          |
| `completion`  | `candidatesTokenCount` (answer only)      | billed output: answer plus thinking                          |
| Embeddings    | not counted                               | not counted — no usage is reported                           |
| Stub axis     | fixed `{150, 45}` (`runs.service.ts:259`) | unchanged for `plan`; `selectTool`/`distill` report `{0, 0}` |
| Shape         | `{ prompt, completion }`                  | unchanged                                                    |

The shape of `RunResponse` does not change. Its meaning does, and the doc comments on
`TokenCountsSchema` and `RunResponseSchema` say so. The two sources can disagree in one
case. If a seam's model call succeeds but its parse then throws and `IO_RETRY` re-runs the
node, the spans record both calls, and state records only the attempt that succeeded. The
spans see every billed call, so the budget reads spans. `RunResponse` reports the run.

The alternative to changing the seam return types is a side channel that carries usage to
the recorder, which leaves the node contracts alone. That leaves `RunResponse.tokenCounts`
counting only the plan call. It also gives two answers to "what did this run use", one of
them visible to API clients and wrong. Open question 4.

### Cassette format 2, and the one re-recording

The response shape at `act.selectTool` and `distill.extractEntities` changes, and the
request does not. A version-1 cassette would still match on the request hash, and would
then hand the node a response shaped the old way: `selection` would be `undefined`, and
`act` would read that as "no tool". **The replay would not abort. It would quietly run a
different trajectory.** So `formatVersion` goes to `2` (`types.ts:47` in
`packages/agent-cassette`). The player's existing version check (`player.ts:162-164`) then
refuses the committed set before any database is reset, and the message names
`EVAL_CASSETTE_MODE=record`. `Decision.tokenCounts` gains an optional `reasoning`, and
`tokenCountsFor` reads `response.tokenCounts` at all three chat seams.

The re-recording is one trial of each task on model `live` / memory `live`. That is three
plus five `generateContent` calls, eight of the day's twenty, as in P1-B. The budget
values come from it:

- `inputTokens` = recorded × 1.5, `outputTokens` = recorded × 2, each rounded up to the
  next hundred. The headroom is uncalibrated (open question 1).
- `modelCalls` = `2 + maxSteps`: one `plan` call, at most `maxSteps` `selectTool` calls and
  one `distill` call. That gives 7 for `memory-recall-001` and 5 for `tool-use-001`. It is
  the maximum today's graph can make, so it does not fail when the model legitimately
  reaches for a tool on `memory-recall-001` (a behaviour that task declines to grade). It
  does fail on a change that adds a model call per step or per run. Summed over the suite,
  it bounds the nightly's quota draw at twelve calls a trial round, and P1-C's design
  depends on that number staying under twenty.

### The price table

```ts
// apps/agent-service/src/eval/pricing.ts — beside CHAT_MODEL, because the harness knows no provider
export const GEMINI_PRICES: PriceTable = {
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
  pageLastUpdated: '2026-09-24',
  readOn: '2026-09-26',
  tier: 'paid, standard',
  models: { 'gemini-2.5-flash': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 } },
};
```

The page says "Output price (including thinking tokens): $2.50" for `gemini-2.5-flash`, so
the output price applies to `outputTokens` as the design defines them. The same page gives
the free tier as "Free of charge" for input and output. It lists no price for
`gemini-embedding-001`. The only embedding model on the page is Gemini Embedding 2. The
harness takes the table as an option, `prices?: PriceTable`, since the package does not
know which provider it is measuring. A span whose `gen_ai.request.model` is not in the
table is reported as `unpriced` and never costed at zero. Updating the table means editing
the file, including its date.

### Layout

```
packages/eval-harness/src/
  types.ts            BudgetsSchema, BudgetResult, Trial.budgets/withinBudget, SuiteReport.usage
  budgets.ts          checkBudgets, summarizeUsage, estimateCost
  budgets.test.ts
  dataset.ts          budgets beside requires
  harness.ts          checkBudgets after runGraders
  reporters/*.ts      a Budgets section (summary), budget testcases (JUnit), fields (JSON)
packages/agent-cassette/src/types.ts, player.ts          formatVersion 2, tokenCounts.reasoning
apps/agent-service/src/
  runs/runs.service.ts            callWith derivation; selectTool/extractEntities return usage
  agent/nodes/act.node.ts, distill.node.ts                accumulate tokenCounts
  eval/cassette-deps.ts           tokenCountsFor at all three chat seams
  eval/pricing.ts                 GEMINI_PRICES
  eval/run-eval.ts                prices option; exit on breach
packages/eval-harness/datasets/memory-recall/*.json, cassettes/*   budgets; re-recorded set
```

## Acceptance criteria

Every criterion names its axis. "Fakes" means a unit test with in-process fakes. It
verifies a mapping or a rule, on neither model axis.

- [ ] `checkBudgets` returns `within`, `breached` and `unmeasurable` for fake span sets:
      within the limit, over it, a `generate_content` span with no usage key, no inference
      spans at all, and a mix of replayed and non-replayed spans. An errored span counts
      toward `modelCalls` and is not unmeasurable. Fakes.
- [ ] The dataset loader accepts `budgets` beside `requires`, and rejects `latencyMs` or any
      other unknown key with a message naming the key. Fakes.
- [ ] With a fake `AgentHarness` whose trial breaches a budget, the trial has
      `passed: true` and `withinBudget: false`, `passRate` is unchanged,
      `budgetBreaches` is 1, and the runner's exit code is 1. Fakes.
- [ ] **Model `stub` / memory `live`:** no budget is checked, the summary says
      `budgets not checked on model=stub`, and the exit code is what it would be without
      budgets.
- [ ] **Model `replay` / memory `live`**, before the re-recording: the version-2 player
      refuses the committed version-1 set before any store is reset, with a message naming
      `EVAL_CASSETTE_MODE=record`.
- [ ] **Model `live` / memory `live`:** the re-recording (one trial per task, eight
      `generateContent` calls) writes `tokenCounts` with `prompt > 0` and `completion > 0`
      on every `plan.callLlm`, `act.selectTool` and `distill.extractEntities` decision, and
      `reasoning` wherever the response reported `total_tokens`. Its report shows every
      budget `within`, with source `measured`.
- [ ] **Model `live` / memory `live`**, on the same run: for each trial,
      `RunResponse.tokenCounts.prompt` equals the sum of `gen_ai.usage.input_tokens` over its
      `generate_content` spans, and `completion` equals the sum of
      `gen_ai.usage.output_tokens`. A plan-only total fails this for both tasks.
- [ ] **Model `replay` / memory `live`**, on the new set: each trial's span sums equal the
      sums of its cassette's decision `tokenCounts`, the source is `recorded`, and two
      consecutive replays produce identical usage sections.
- [ ] **Model `replay` / memory `live`:** raising one decision's recorded `prompt` count in
      a copy of the set above `inputTokens` makes that trial `breached`, with the limit and
      the actual value in the summary. The trial still `passed`, and the run exits 1. This
      is the replay-tier path for a token increase that arrives with a re-recording.
- [ ] Both task files declare `inputTokens`, `outputTokens` and `modelCalls`, with values
      derived from the re-recording by the rule in the Design. `modelCalls` is 7 and 5.
- [ ] The summary prints the cost as a list-price equivalent, naming the price table's
      source and `pageLastUpdated`. A model missing from the table prints `unpriced`, and
      embedding calls are counted and printed `unpriced`. Fakes for the arithmetic; the
      replay run for the rendering.
- [ ] Latency appears in the summary only on the `live` axis, summed from spans without
      `agent_native.replayed`. On `replay` the summary prints no model latency and says why.
      Replay run, plus the live re-recording.
- [ ] **In CI, model `replay` / memory `live`:** P1-C's replay job on this pull request
      shows the budget table in its job summary, and passes.
- [ ] `TokenCountsSchema`'s and `RunResponseSchema`'s doc comments state the new meaning.
      `README.md:207` lists `tokenCounts` among the outputs of `act` and `distill`.
      `packages/eval-harness/README.md` documents `budgets` and why latency is not one.
      `docs/STATUS.md` gains a row for per-task budgets with file and line evidence.
      `.context/conventions.md` says that raising a budget is an edit to the task file,
      reviewed in the pull request that needs it.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn turbo test:unit`, `yarn lint:docs`
      and `yarn format:check` pass.

## Risks and open questions

**Open questions, decided at review 2026-09-26.**

1. **Headroom.** 1.5× on input and 2× on output are guesses. Each task has one recorded
   sample, and nothing has measured how much `gemini-2.5-flash`'s output length varies for a
   fixed prompt. With too little headroom the nightly goes red on noise. With too much, the
   replay-tier check catches only large inflations. The nightly's live artifacts (P1-C)
   produce one sample per task per night, and after a few weeks they are enough to replace
   the guess. This does not change scope.
2. **Budgets beside the pass rate, or inside it.** The draft keeps them out of
   `Trial.passed` so that P1-D's pass-rate comparison is about quality only. If review
   reverses this, budgets become code graders named `budget_*`, they enter `pass^k`, and
   P1-D inherits the mix. That changes the report shape. It does not change the size.
   _Decided: beside._ A pass rate that falls because a correct answer got longer would be
   a quality number measuring cost.
3. **The `act` loop repeats itself, and no PRD owns the fix.** `tool-use-001` spends two of
   its five calls repeating a request the model has already answered — two of the
   nightly's eight. The fix is to give `selectTool` the previous tool
   output. That is a prompt change, so it forces a re-recording and moves the budgets.
   Folding it into P1-F saves one re-recording and makes this PRD change agent behaviour.
   Keeping it separate needs a PRD that does not exist yet. The draft recommends keeping it
   separate. Either answer changes scope. _Decided: separate, and owned by P4-C_, whose
   tool registry is where `selectTool`'s input is redesigned anyway. P1-F sets its budgets
   on today's baseline, repeats included, and says so beside them; P4-C's re-recording
   tightens them.
4. **The seam return types change.** This is what makes `RunResponse.tokenCounts` the
   truth. It touches two node contracts and their fakes in `graph.test.ts`,
   `resume.test.ts` and `spans.test.ts`, and forces the format bump. A side channel would
   avoid all of that and leave the public field counting one call in three. The draft
   recommends the return-type change. _Decided: the return types change._ A public field
   that counts one call in three is the kind of claim this repository exists to correct.

**Risks.**

- **P2-C has not shipped, and its thinking-token derivation has never been checked against
  a real response.** P2-C's second live criterion tests it and removes the derivation if it
  is wrong. If that happens, `completion` and `outputTokens` exclude thinking, and the cost
  is understated for the model this repository uses. The budgets would still be ceilings on
  what is counted. The cost column would be wrong, and the report would have to say so.
- **`modelCalls` counts operations, not HTTP requests.** LangChain's own retries run inside
  one span, and P1-C measured seven requests behind one `invoke` on a 429. A call budget
  does not bound the quota consumed in that case. P1-C's 429 classifier is what bounds it.
- **A contributor without a key cannot change a budget-affecting prompt.** P1-C already
  records this for prompts: the replay tier goes red until the set is re-recorded. P1-F
  adds nothing new to it, but the budget diff is now part of the same re-recording.
- **The price table goes stale without anyone noticing.** It records the date it was read.
  Nothing checks the page, so a price change shows up in the report only when someone
  edits the file. Because nothing asserts dollars, a stale price can make the cost column
  wrong and cannot turn CI red.
- **Size is `M`, and it rests on code that does not exist yet.** P2-C's spans,
  `Transcript.spans` and the replayed marker are all inputs to this PRD, and none has run.
  The re-recording is the first time usage for `selectTool` and `distill` will have been
  observed at all. Following P0-A's rule, treat the size as a floor.

## References

- Kapoor, Stroebl, Siegel, Nadgir, Narayanan, _AI Agents That Matter_ (2024),
  https://arxiv.org/abs/2407.01502 — cost reported jointly with accuracy.
- Gemini API pricing, `gemini-2.5-flash`, read 2026-09-26 (page last updated 2026-09-24):
  https://ai.google.dev/gemini-api/docs/pricing
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
- `docs/prd/P2-C-otel-genai-semantics.md` — usage on inference spans, the replayed marker,
  the output-token derivation, and the hand-off table this PRD answers.
- `docs/prd/P1-C-tiered-eval-pipeline.md` — the two tiers budgets are checked in, and the
  nightly's quota arithmetic.
- `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md` — why a prompt edit
  misses, and why a replayed number is a frozen sample.
- `docs/prd/P1-B-agent-cassette.md` — the recording's per-trial call counts and the
  hand-off on latency.
