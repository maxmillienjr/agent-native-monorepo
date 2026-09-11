---
id: P1-G
title: Task-level axis requirements for the evaluation suite
tier: 1
status: shipped
size: S
depends_on: [P1-A]
blocks: []
issue: 49
superseded_by: null
---

# P1-G · Task-level axis requirements for the evaluation suite

## Problem

The suite reports a pass rate that mixes two different things, and the reader cannot tell
them apart.

`docs/STATUS.md:47` records "50% over 5 trials × 2 tasks on model `stub` / memory `live`".
There are two tasks. One of them cannot pass on that axis.

`runs.service.ts:190` is the stub model's tool selector:

```ts
selectTool: async () => null, // Stub: no tool needed
```

It returns `null` for every input. `datasets/memory-recall/tool-use-001.json` declares
`toolCalls: ["web-search"]` with `tool_trajectory_recall: 1`, so the task is graded on
making a tool call the stub axis cannot make. Its score on that axis is 0 for every trial
that has run and every trial that will run, and the number is a property of the fixture
rather than of the agent.

Run on the live model axis on 2026-09-10 — one trial, memory `live`, `EVAL_TRIALS=1` — the
same task passes. The transcript records three selections:

```json
{"name":"web-search","input":{"query":"LangGraph latest release notes"}}
{"name":"web-search","input":{"query":"Latest LangGraph Release"}}
{"name":"web-search","input":{"query":"LangGraph latest release github pypi"}}
```

`passed: true`, `passAtK: true`, `passHatK: true`. One trial disproves "the agent cannot
select this tool"; it does not establish a pass rate, and this PRD does not claim one.

`docs/prd/README.md:26` says `tool-use-001` "has never run on the live model axis". That
sentence was true when written and is false at HEAD.

The harness already has the concept this needs, one level down. `Grader.requires`
(`types.ts:139`) declares the axes a grader is meaningful on, `unmet` compares them
(`axes.ts:29-38`), `assertAxesSatisfy` collects every violation (`axes.ts:59-70`), and
`harness.ts:80-82` runs the check before the first trial so an unmeetable requirement costs
no model calls. `graders/code.ts:35` uses it. `Task` (`types.ts:174-181`) has no equivalent
field, so a task cannot say what it needs.

## Why it matters

`pass@k` and `pass^k` are the numbers this repository offers as evidence that the agent
works, and they are the first thing a reader checks. A rate whose denominator includes a
task that the configuration makes impossible is not a measurement of the agent — it is a
measurement of the fixture, reported in the same units and the same table as the real
result.

The consumers are named and close. P1-C wires the suite into a pipeline; P1-D decides which
failures block a merge. Both read this number, and a gate built on a rate that silently
includes an impossible task fires on the wrong thing.

## Scope

- `AxisRequirements` accepts a set of acceptable values per axis, not only one value.
- `Task.requires`, parsed from a `requires` field in the task JSON.
- The harness **skips** a task whose requirements are unmet, rather than refusing the suite.
- `SuiteReport` carries the skipped tasks and the reason each was skipped.
- `passRate` excludes skipped tasks from its denominator, and every report says which tasks
  were excluded, so the exclusion cannot be read as a perfect score.
- `tool-use-001` declares that it needs a model axis that can select a tool.
- The two stale sentences are corrected: `docs/prd/README.md:26` and `docs/STATUS.md:47`.

### Non-goals

- **Descriptions and input schemas on `Tool`.** `act.node.ts:6-9` defines `Tool` as
  `{ name, execute }` and `runs.service.ts:149` passes `tools.map((t) => t.name)` into the
  selection prompt, so the model chooses from bare names. With one tool called `web-search`
  that is sufficient, as the live trial above shows. It may stop being sufficient when a
  second tool is registered, or when two tools have names that do not distinguish
  themselves. **No PRD owns that today**, and this one deliberately does not take it: there
  is no evidence of a defect to fix, and writing the interface before the second tool exists
  designs against a guess.
- **Making the stub select a tool.** A canned selection in `createStubModelDeps` would turn
  the 0 into a pass, and the pass would be the fixture's rather than the agent's. That is
  the failure `.agents/prd-author.md` names and that P2-A shipped and had to be reopened
  for. Rejected rather than deferred.
- **Whether a skipped task blocks a merge.** P1-D owns the gate.

## Design

**Requirements become sets.** `unmet` (`axes.ts:29-38`) compares with `!==` against a single
value. A task that needs "any axis that can call a model" cannot be expressed that way, and
the reason is not hypothetical: P1-B's criteria add `'replay'` to `ModelAxis`, and a task
pinned to `model: 'live'` would refuse to run on exactly the axis P1-B exists to make
affordable.

```ts
export type AxisRequirement<T> = T | readonly T[];

export interface AxisRequirements {
  readonly model?: AxisRequirement<ModelAxis>;
  readonly memory?: AxisRequirement<MemoryAxis>;
}
```

`unmet` tests membership. A scalar stays legal, so every existing grader is unchanged.

**Tasks declare, and the dataset carries it.**

```ts
export interface Task<TOutcome = Outcome> {
  readonly id: string;
  // ...
  readonly requires?: AxisRequirements;
}
```

`tool-use-001.json` gains:

```json
"requires": { "model": ["live", "replay"] }
```

Named as a set now, so P1-B needs no edit to the fixture when it introduces the axis.

**A task skips; a grader still refuses.** The existing behaviour for graders is correct and
does not change: an unmet grader requirement means the suite cannot report honestly, so it
throws before any trial (`axes.ts:40-56`). A task is different. Refusing the whole suite
because one task needs a key would make `yarn eval` unusable on a clone with no `.env`,
which is the ergonomics the quickstart depends on. So an unmet task requirement removes the
task from the run and is recorded.

**The trap this must not walk into.** `harness.ts:120-123` computes `passRate` over
`allTrials`. A skipped task contributes no trials, so skipping `tool-use-001` on the stub
axis turns a misleading 50% into a misleading 100%. Trading one wrong number for a more
flattering wrong number is worse than leaving it alone. The report therefore carries the
exclusion beside the rate, in all three reporters (`reporters/json.ts`, `reporters/junit.ts`,
`reporters/summary.ts`):

```ts
export interface SkippedTask {
  readonly taskId: string;
  readonly problems: readonly string[];
}

export interface SuiteReport<TOutcome = Outcome> {
  // ...
  readonly passRate: number;
  readonly skipped: readonly SkippedTask[];
}
```

The Markdown summary prints the axis line, the rate, and — when `skipped` is non-empty — the
tasks that were not run and what each needed.

## Acceptance criteria

- [x] `AxisRequirements` accepts a scalar or an array on both axes, and every grader that
      declares a scalar today is unchanged. Unit test for both forms, on both axes.
- [x] `Task.requires` exists and `TaskSpecSchema` parses a `requires` object from the task
      JSON, rejecting an axis value that is not a member of its union.
- [x] `tool-use-001.json` declares `"requires": { "model": ["live", "replay"] }`.
- [x] On model `stub` / memory `live`, `yarn eval` runs `memory-recall-001`, does not run
      `tool-use-001`, and exits 0.
- [x] That run's `eval-report.json` carries `skipped` naming `tool-use-001`, with a reason
      that states both the axis the run had and the set the task needed — the stub model
      axis against `live` or `replay`.
- [x] `eval-summary.md` from that run names the skipped task and its reason next to the pass
      rate. A reader cannot see the rate without seeing the exclusion.
- [x] The JUnit XML reports the skipped task as a skipped test case, not as a pass and not
      as an absence.
- [x] `passRate` on that run is computed over the tasks that ran: the report's trial count
      equals `trialsPerTask` multiplied by the number of tasks not skipped.
- [x] An unmet **grader** requirement still throws `AxisRequirementError` before the first
      trial. Existing behaviour, asserted by the existing test, unchanged.
- [ ] On model `live` / memory `live`, both tasks run and neither is skipped. **Not
      verified by a run, and P1-C owns running it.** A 5 × 2 live suite costs roughly forty
      `generateContent` calls against a 20-request free-tier quota that was already part
      spent on the day this shipped, and the risks section below says the same thing about
      the live-axis evidence this PRD rests on. What is verified without spending quota is
      the decision the criterion is about: the skip is a function of the axes alone, and
      `dataset.test.ts` asserts that `skippedTasks` returns nothing for the shipped suite on
      model `live` / memory `live`. Whether both tasks then _pass_ there is a different
      claim, and no criterion here makes it.
- [x] `docs/STATUS.md` row 17 states that the 5×2 stub-axis measurement included a task the
      stub axis cannot pass, and what the number is once that task is excluded.
- [x] `.context/conventions.md` says a task declares the axes it is meaningful on, and that
      a skipped task must be visible beside any rate computed without it.

## What shipped

The mechanism is `unmetRequirements` (`axes.ts:43`), which tests membership rather than
equality, so a scalar and a set read the same way and every existing grader is untouched.
`assertAxesSatisfy` (`axes.ts:75`) keeps refusing the suite for a grader; `skippedTasks`
(`axes.ts:100`) collects the tasks to drop, and the harness computes it before the grader
check so a skipped task's graders cannot take the run down with them — one task's declared
requirement should not cost the suite the other task's measurement.

Measured on model `stub` / memory `live`, 5 trials per task, on 2026-09-10:

|                | Before                                      | After                                |
| -------------- | ------------------------------------------- | ------------------------------------ |
| `passRate`     | 50% over 10 trials                          | 100% over 5 trials                   |
| Tasks run      | `memory-recall-001` 5/5, `tool-use-001` 0/5 | `memory-recall-001` 5/5              |
| `tool-use-001` | counted as five failures                    | skipped, reported in all three files |
| Exit code      | 1                                           | 0                                    |

The 50% and the 100% are the same agent. The difference is the denominator, which is why
the exclusion is printed between the rate and the table in `eval-summary.md`, emitted as a
`<skipped/>` case in the JUnit XML, and carried as `skipped` in `eval-report.json` — and
why `docs/STATUS.md` row 17 keeps both numbers rather than replacing the unflattering one.

## Risks and open questions

- **The live-axis evidence is one trial.** It is enough to show the task is not structurally
  impossible on that axis, which is all this PRD's argument needs. It is not enough to say
  the agent selects the tool reliably, and no criterion here claims that. A 5-trial live run
  costs roughly forty `generateContent` calls against a 20-request free-tier quota, which is
  why it has not been done; P1-B's replay path is what makes it affordable, and P1-C owns
  running it.
- **Skipping is a way to hide a failure.** The mitigation is that the exclusion travels with
  the number in all three reporters, and that the requirement lives in the task file where a
  reviewer reads it. It remains true that a task can be silenced by declaring an axis it
  does not need, and nothing here detects that.
- **This PRD assumes the stub axis should not be extended to cover tool selection.** If that
  is reversed, the skip becomes unnecessary for `tool-use-001` and this work is scoped to the
  general mechanism rather than to that task.
- **`ModelAxis` gains `'replay'` in P1-B.** The set form is designed for it, but if P1-B
  lands first, re-read the fixture's declared set before implementing.

## References

- `docs/prd/P1-A-eval-harness.md` — the axis model and the grader-level `requires` this
  extends.
- `docs/prd/P1-B-agent-cassette.md` — introduces the `replay` model axis.
- `.agents/prd-author.md` — the rule against a criterion verified on a stub.
