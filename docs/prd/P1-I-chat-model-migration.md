---
id: P1-I
title: Migrate off `gemini-2.5-flash`
tier: 1
status: in-progress
size: L
depends_on: [P1-A, P1-B, P1-E, P1-F]
blocks: []
issue: 147
superseded_by: null
---

# P1-I · Migrate off `gemini-2.5-flash`

## Problem

The chat model this repository runs on is closed to new users now, and Google shuts it down
on 2026-12-01. Every fact below was checked on 2026-11-09 at `5fc2016`. No model call was
made to write this draft. The facts about the API come from the repository, from CI
artifacts read with `gh run download`, and from Google's documentation pages, read the same
day.

**The chat id is named once, and everything reads it.** `PINNED_CHAT_MODEL` is
`'gemini-2.5-flash'` (`apps/agent-service/src/agent/model/model-deps.ts:13`), and
`CHAT_MODEL` is that or `EVAL_CHAT_MODEL` (`:29`). Both chat clients take `CHAT_MODEL`
(`apps/agent-service/src/runs/runs.service.ts:124-134`, `:285-286`). So do the cassette
recorder, the cassette player's refusal (`packages/agent-cassette/src/player.ts:247-249`),
the run record's header (`apps/agent-service/src/audit/run-recorder.ts:73`) and the report
(`apps/agent-service/src/eval/run-eval.ts:445`). The chat client sets no thinking or
sampling configuration (`runs.service.ts:128-133`), so a new id runs on its defaults. The
embedding model is a separate constant, `gemini-embedding-001`, and this PRD leaves it alone.

**A key from a new project gets a 404 on that id.** On 2026-10-15 the repository secret moved
to a key in a new project. From the next night, `generateContent` on `gemini-2.5-flash`
answered 404, "no longer available to new users. Please update your code to use
models/gemini-3.8-flash" (`.context/conventions.md:492-500`). The canary's artifacts from
those nights show what else that key could reach. Runs 38869926347 (2026-10-16), 39013870656
(10-17) and 39222893166 (10-19) all report `chat-pinned` as `gone`; on 10-16 its detail
reads "generateContent returned 404". All three report the embedding probe `unchanged`, "21
of 21 bit-identical". On 10-17 and 10-19 the floating alias answered `gemini-3.8-flash`, and
on 10-16 it answered a 503. So a fresh clone on its own key can embed, and it cannot run a
single trial. The secret went back to the original project on 2026-10-19.

**The shutdown date is 2026-12-01, not 2028-05-14.** P1-E says no shutdown date forces
this migration before 2028-05-14 (`docs/prd/P1-E-model-drift-canary.md:161-162`), and the
index said the same until this draft corrected its P1-I paragraph. That is
`gemini-embedding-001`'s date, and P1-E's own Why section gives it to that model
(`P1-E-model-drift-canary.md:110-111`). On
2026-11-09 Google's deprecations page gives `gemini-2.5-flash` a shutdown date of December 1,
2026, with the replacement `gemini-3.5-flash-lite`. It says: "Effective December 1, 2026,
all API requests to `gemini-2.5-flash` will automatically route to `gemini-3.5-flash-lite`",
and "Access to the 2.5 models is limited to users who have actively used them in the past."
The page carries no date of its own, so when the entry appeared is not known.
`gemini-embedding-001` still shuts down on May 14, 2028. Nothing in the repository watches
that page. The canary reads the API, and the API changes on the day.

**From 2026-12-01 the repository would run on another model and say it had not.** Requests
to `gemini-2.5-flash` route to `gemini-3.5-flash-lite` with the id unchanged. Each of the
following then holds:

- The nightly live job's report names `chat: gemini-2.5-flash`, because the report takes the
  id from `CHAT_MODEL` (`run-eval.ts:445`), not from the response.
- Its tally pools into the current epoch. An epoch is keyed on the suite and the committed
  cassette digest (`apps/agent-service/src/eval/history.ts:163`), and the digest does not
  move. P1-D's pooled rate would average two models, which its design exists to prevent.
- Replay keeps serving `gemini-2.5-flash`'s recorded answers and reports `match`. ADR 0005
  says replay cannot see the model change.
- The canary's pinned chat probe goes red only if `modelVersion` names the routed model.
  It reads `gemini-2.5-flash` today (`packages/eval-harness/datasets/canary/baseline.json`,
  `chat`), and what it will read after routing has not been observed.
- P2-D's stage 2 is pre-registered on `gemini-2.5-flash`
  (`docs/prd/P2-D-graph-explanation-or-removal.md:345-348`). Its recorder refuses any other
  `CHAT_MODEL` (`apps/agent-service/src/eval/run-explanation.ts:597-600`), but after
  routing the id is the same and the model is not.

**Moving the pin re-records three suites, 44 `generateContent` calls.** A chat model id
change is a re-record trigger (`.context/conventions.md:313-316`), and the player refuses a
set recorded on another id (`player.ts:247-249`). The committed set is 30 cassettes, every
header `chatModel: gemini-2.5-flash`. Counted from the cassettes' decisions on 2026-11-09:

| Suite             | Cassettes | Recorded                      | Chat decisions                                            | `generateContent` |
| ----------------- | --------- | ----------------------------- | --------------------------------------------------------- | ----------------- |
| memory-recall     | 3         | 2026-11-03 (P4-B), 2026-11-05 | `memory-recall-001` 3, `tool-use-001` 5, `tool-use-002` 4 | 12                |
| red-team (P4-B)   | 3         | 2026-11-03                    | `rt-001` 3, `rt-002` 3, `rt-003` 6                        | 12                |
| prior-auth (P3-D) | 24        | 2026-10-12, 10-15, 10-19      | one `assess.criteria` per non-administrative task         | 20                |
| **total**         | **30**    |                               |                                                           | **44**            |

The chat seams are `plan.callLlm`, `act.selectTool`, `distill.extractEntities` and
`assess.criteria`. `embed` and `act.tool` decisions are not chat calls. The figures agree
with P4-B's recording table (`docs/prd/P4-B-memory-poisoning-red-team.md:655-679`), P3-D's
(`docs/prd/P3-D-payer-dataset-fhir-prior-auth.md:821-861`) and the conventions
(`.context/conventions.md:240-253`).

**Six tasks have budgets that follow from the recording, and twenty-four have none.** The
memory-recall and red-team task files each set `inputTokens`, `outputTokens` and
`modelCalls` by P1-F's rule, from the recording they were made on (`.context/conventions.md:403-415`).
Their notes record the figures, for example `memory-recall-001`: "1622 input and 5722 output
tokens over 3 calls, 2628 of them thinking." A new model thinks a different amount, so every
token budget is stale on the first live run. The 24 prior-auth task files have no `budgets`
key at all.

**P1-E handed this PRD its one unmet criterion.** P1-E's criterion is one trial of each task
with `EVAL_CHAT_MODEL=gemini-flash-latest` (`P1-E-model-drift-canary.md:472-511`). It was
dispatched three times. Run 40314499494 (2026-10-26) ran into the job's 30-minute timeout.
Run 40321010682 (2026-10-26) ended on the alias target's own daily quota. Run 40509513773
(2026-10-27) spent 36 minutes on 503s, then a 429 on
`GenerateRequestsPerDayPerProjectPerModel-FreeTier` aborted it with no trial complete. A
probe on 2026-11-03 got a 503 after 224 s, so no fourth dispatch was made. The criterion
moved here on 2026-11-03, "where the same comparison is its first measurement". The one
trial that finished, `memory-recall-001` on 2026-10-26, was answered on every decision. Its
three chat decisions took 555 s, 134 s and 234 s.

**503s are not only the alias's.** The scheduled canary of 2026-11-07 (run 42360437346)
aborted with cause `provider-unavailable`: `generateContent gemini-2.5-flash failed: 503`,
"This model is currently experiencing high demand." On 2026-11-06 (run 42202060472) the
alias answered 503 and the pinned id answered. On 2026-11-08 (run 42468884736) both
answered, and the alias read `gemini-3.8-flash`. From 2026-10-20 to 26 the alias answered
on two nights of seven (`P1-E-model-drift-canary.md:435-437`).

**A 503 spends quota.** `stopOnDailyQuota` makes a per-day 429 terminal and hands every
other failure to LangChain's default handler (`apps/agent-service/src/agent/model/rate-limit.ts:106-111`),
which retries up to six times (`runs.service.ts:119-122`). Each retry is a request against
the day's 20. On 2026-11-09 a live run made 20 requests and got 9 answers. That observation
was reported to this draft, and since the retry bound below it is in `.context/conventions.md`'s
live-quota section.

**No decision record covers model choice.** No ADR names a chat model id or a pinning
policy: `grep -n -i "flash\|CHAT_MODEL\|model id" docs/adr/*.md` returns nothing. ADR 0005
names the Gemini client and the pinned client package, not a model. The rule that "pinned"
means the stable id, because no dated variant exists, is in P1-E's Problem section
(`P1-E-model-drift-canary.md:22-30`) and in a code comment (`model-deps.ts:6-12`).

## Why it matters

A system with a recorded evaluation tier has to be able to say which model produced every
number it reports, and it has to be able to run from a clone. On 2026-12-01 the first stops
being true, for the reasons in the Problem section. The second is already false for any new
Google Cloud project. Pinning a model version and migrating it deliberately, before the
provider's date, is the practice P1-E's canary was built to support. NIST AI RMF MANAGE 3.1
asks that third-party models be monitored, and MEASURE 2.4 that changes in behaviour in
production be tracked. A provider-side reroute behind an unchanged id is that kind of
change, and this PRD makes it a commit with a measurement and a decision record. Done after
the date, it would be noticed late, if at all.

## Scope

- **A measurement before the choice**, on two candidates: `gemini-3.8-flash`, which the
  404 names and which the floating alias read on 2026-10-12 and on every night checked here
  that it answered, and
  `gemini-3.5-flash-lite`, which the deprecations page names and routes to. It includes P1-E's
  criterion on the alias, unchanged.
- **A pre-registered rule that picks the id**, written into this PRD before the first
  measurement, and an ADR that records the choice and the pinning policy.
- **The switch**: `PINNED_CHAT_MODEL` moves, and the canary, pricing and every document that
  names the old id move with it.
- **Re-recording all three cassette suites** on the new id, with the replay baselines
  regenerated and the six budgeted tasks' budgets re-derived by P1-F's rule.
- **P2-D's stage 2 keeps its pre-registered model.** Its answer file stays replayable after
  the pin moves.
- **A bound on 5xx retries** for live and record runs, so a 503 window cannot spend a day's
  quota on retries. Kept at review (decision 4).
- **A fresh-clone check**: one live trial on a key from a project that never called
  `gemini-2.5-flash`.

### Non-goals

- **Migrating the embedding model.** `gemini-embedding-001` answers new projects (runs
  38869926347, 39013870656, 39222893166) and shuts down on 2028-05-14. A migration
  re-records every cassette and P2-B's 535 recorded embeddings, and it changes
  `EMBEDDING_DIMENSIONS`'s justification. **No PRD owns it.** The canary's metadata probe
  reports a `gone` on that id, and its embedding probe reports any vector change. This draft
  proposes no index row until a date inside a year, or a 404 for new projects, makes one
  necessary. See open question 6.
- **Replacing the LangChain chat client** to read `modelVersion` on every call. P1-E left
  this unowned (`P1-E-model-drift-canary.md:149-156`), and it stays unowned. The canary's
  direct probe remains the only source of the string.
- **Calibrating budgets from nightly samples.** P1-F's rule says the recording-based
  values hold "until the nightly's samples calibrate them" (`.context/conventions.md:412-414`).
  This PRD applies the rule to the new recording and calibrates nothing. **P1-D** owns the
  nightly's samples.
- **Live coverage of prior-auth and the red team after the switch.** The nightly runs
  memory-recall live and nothing else. **P1-H** rotates the replay-only suites through the
  live job.
- **Re-running P2-D's stage 2 on the new model.** Stage 2 is a pre-registered measurement on
  `gemini-2.5-flash`. Repeating it on another model is a new measurement, and **P2-E**
  decides whether its outcome needs one.
- **Budgets for the prior-auth tasks.** They have none, though the conventions describe
  budgets as a property of every task. Adding them is a second change to a suite whose
  recording this PRD already moves, and the loader's support is unchecked. Decided out at
  review (decision 3); no PRD owns it yet.
- **Turning on billing.** The free tier stays the budget. Billing is the owner's decision
  (`.context/conventions.md:532-533`).

## Design

### The deadline

The switch has to be on `main` by 2026-11-30, the day before routing starts. The plan below
takes twelve days of quota at the least. Starting on 2026-11-10 leaves eight days for 503
days and review. If the switch is not on `main` by 2026-11-30, the fallback is:

1. On 2026-11-30, set `EVAL_SCHEDULE_PAUSED`, so no nightly tally pools a routed model into
   the `gemini-2.5-flash` epoch.
2. On 2026-12-01, after 08:00 UTC, dispatch the canary once with
   `CANARY_PROBES=chat-pinned`. That records what `modelVersion` says for a routed request,
   for one call. The result goes into this PRD.
3. Keep the pause until the switch merges.

P2-D's stage 2 is pre-registered on `gemini-2.5-flash`. On 2026-11-09 it had 29 of its 76
answers, at about nine a day on the whole 2.5 pool with the schedule paused, so it ends
around 2026-11-14. Its last call has to be made by 2026-11-30 as well. That deadline is
P2-D's, and this PRD records it there through the index, not by editing P2-D.
_Updated 2026-11-09:_ stage 2 recorded its last answer at 13:51 UTC that day, the last 47
on the owner's paid key under the same model id, so the deadline is met
(`P2-D-graph-explanation-or-removal.md#Stage 2, as run`).

### Phase 1: measure two candidates

| Step | What                                                                                                                     | Calls | Bucket                  |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ----- | ----------------------- |
| 1a   | The canary gains a `chat-candidate` probe for `gemini-3.5-flash-lite`, a notice like the floating one. Seven nights.     | 7     | `gemini-3.5-flash-lite` |
| 1b   | P1-E's criterion: dispatch `agent-eval.yml` with `chat_model: gemini-flash-latest`                                       | 12    | alias target            |
|      | The canary job in that dispatch                                                                                          | 1 + 1 | 2.5 pool, alias target  |
| 1c   | The same dispatch with `chat_model: gemini-3.5-flash-lite`                                                               | 12    | `gemini-3.5-flash-lite` |
|      | The canary job in that dispatch                                                                                          | 1 + 1 | 2.5 pool, alias target  |
| 1d   | From a new-project key: one `generateContent` each on `gemini-3.8-flash`, `gemini-3.5-flash-lite` and `gemini-2.5-flash` | 3     | new project             |
| 1e   | Which bucket each id draws on, read from AI Studio's per-model usage                                                     | 0     | —                       |

Step 1a is the only code before the choice. It adds a fifth probe to the canary, with the
floating probe's verdicts: `moved`, `unchanged` and `unavailable` are notices, and nothing it
returns fails the run. The same change lets the schedule pause cover `eval-live` alone:
`EVAL_SCHEDULE_PAUSED=live` skips the scheduled `eval-live` and keeps the scheduled
`eval-canary`, and `true` still skips both. While P2-D's stage 2 holds the 2.5 pool the
variable is `live`, so the seven nights can start (_updated 2026-11-09:_ stage 2 finished
that afternoon, and the variable was deleted at 13:51 UTC); the canary then spends one call a night on
that pool, for `chat-pinned`. The alias probe already gives a nightly availability series for
`gemini-3.8-flash`, and nothing gives one for `gemini-3.5-flash-lite`. The candidate probe is
removed at the switch.

Steps 1b and 1c use the `chat_model` input P1-E built (`.github/workflows/agent-eval.yml:58-63`).
It unsets the gate, pushes no tally, raises the timeout to 90 minutes (`:235`), and heads the
summary as a migration comparison. Both are dispatched on a morning when that night's
floating probe answered, after the nightly has finished. That is the rule
`.context/conventions.md:521-526` already sets. Each dispatch's cassettes are kept as its
artifact.

Step 1d is what the PRD exists for. The 404 on `gemini-2.5-flash` is repeated so that the
contrast is on the same key and the same day. It needs a key from a project that has never
called `gemini-2.5-flash`. The owner made one on 2026-10-15, and that project has to be kept
until phase 3's fresh-clone trial. The owner runs both, or supplies the key for them.

Step 1e answers P1-E's unchecked quota fact (`P1-E-model-drift-canary.md:727-731`): whether
a model id's free-tier day is its own. The 2026-10-27 dispatch suggests that the alias target
has a bucket apart from `gemini-2.5-flash`: it ended on a per-model daily 429 while the
pinned probes answered. Whether `gemini-flash-latest` and `gemini-3.8-flash` share one is not
known. The per-day split below assumes one bucket per resolved model, and step 1e is where
that is checked, at no cost.

### The rule that picks the id

This rule is agreed at review, before step 1b. Agreeing it afterwards is what
pre-registration prevents. A candidate is out if any of these holds:

1. It does not answer `generateContent` from the new-project key in step 1d.
2. In step 1b or 1c, it fails a grader on a task that passes in the committed replay
   baseline. A failure the trial's transcript shows to be the fixture's, as with
   `tool-use-001`'s echoing `web-search` (`packages/eval-harness/datasets/memory-recall/tool-use-001.json`,
   `notes`), is recorded and does not count.
3. It answered the nightly probe on fewer than four nights of the seven: the alias probe
   for `gemini-3.8-flash`, the candidate probe for `gemini-3.5-flash-lite`.

Among the candidates still in, **`gemini-3.5-flash-lite`** is chosen. Google routes
`gemini-2.5-flash` to it, so it is the model this repository would run on anyway from
2026-12-01. Its list price equals `gemini-2.5-flash`'s, $0.30 and $2.50 per million input
and output tokens, so the report's cost column does not move for a reason unrelated to the
agent. `gemini-3.8-flash` lists at $0.75 and $3.75, and at $1.50 and $7.50 from 2027-01-01.
**`gemini-3.8-flash`** is chosen if it is the only one left. **If neither is left**, the
choice goes to the owner with the measurements, before 2026-11-20, so the deadline still
holds.

The rule reads one trial per task. It can rule a model out for failing this suite, and it
cannot show that one model is better than another. That is deliberate: the decision here is
which model to run on, not a quality ranking.

Both candidates are listed "Stable" on their model pages, so P1-E's meaning of "pinned"
carries over. `gemini-flash-latest` stays the floating alias, and the canary keeps reporting
where it points.

### The decision record

ADR 0018, at the time of writing the next free number (`docs/adr/README.md`; no branch holds
0018). It extends nothing and supersedes nothing, because no record covers model choice. It
records:

- the chat id chosen, the measurements and the rule that chose it, by reference to this PRD;
- that the service pins a stable id and never a `-latest` alias, and that the alias is
  measured by the canary and run by hand as a migration comparison, never as the pin. This
  is P1-E's practice, which is written down only in a PRD and a comment;
- what starts the next migration: a shutdown date on the pinned id inside six months, a
  404 from a new project, or a pinned `changed` on the canary. Any of these opens a PRD,
  which re-records every suite;
- that the embedding model is out of its scope.

### Phase 2: switch and re-record

On a branch, in this order:

1. `PINNED_CHAT_MODEL` becomes the chosen id (`model-deps.ts:13`), and its comment says why.
2. `run-explanation.ts` gets `STAGE2_CHAT_MODEL = 'gemini-2.5-flash'`, P2-D's pre-registered
   id. The recorder refuses unless `CHAT_MODEL` equals it (`:597-600`, now comparing against
   `PINNED_CHAT_MODEL`). The answer file's header is checked against it, not against
   `CHAT_MODEL` (`apps/agent-service/src/eval/answer-file.ts:50-51`, `:125-129`). Without
   this, the pin moving makes stage 2's answer file unreplayable, and its recorder would ask
   the new model. Recording stage 2 after the switch then needs
   `EVAL_CHAT_MODEL=gemini-2.5-flash`, and from 2026-12-01 that id is routed anyway, which is
   why stage 2 has its own deadline.
3. The canary's pinned chat id follows `PINNED_CHAT_MODEL`
   (`apps/agent-service/src/eval/canary/runner.ts:38-42`), and `gemini-2.5-flash` leaves
   the probe set and the baseline. With `CANARY_BASELINE=update` and
   `CANARY_PROBES=metadata,chat-pinned`, `yarn canary` writes the new id's metadata and
   `modelVersion`, for one `generateContent`.
4. `GEMINI_PRICES` gains the new id, dated, from the pricing page
   (`apps/agent-service/src/eval/pricing.ts:25-33`). If it is `gemini-3.8-flash`, the 2027
   price is noted beside the figure, because nothing reads the page again.
5. The 5xx retry bound, if review keeps it (open question 4).
6. Record each suite with the command P3-D uses
   (`P3-D-payer-dataset-fhir-prior-auth.md:817-818`) and `EVAL_SUITE` set: memory-recall,
   red-team, then prior-auth in two batches by `EVAL_TASKS`. A budget breach on the
   recording run is expected, because the budgets are the old model's. It fails the run and
   still writes the cassette.
7. Re-derive the six budgets by P1-F's rule from the new recordings: input × 1.5 and output ×
   2, each rounded up to the next hundred, and `modelCalls` = 2 + `maxSteps` (`rt-003`: 2 ×
   (2 + `maxSteps`), for its two runs). Each task's `notes` takes the new recorded figures.
   The `modelCalls` values do not change: they depend on `maxSteps`, not on the model.
8. `EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval` once per suite, then a second
   replay with `EVAL_GATE=replay` that reports `match`. Commit the cassettes and baselines
   per suite, one commit each.

The recording commits are tagged as P3-D and P4-B did (`recording/p1i-<suite>-<date>`), so
every header sha stays reachable through rebases.

**What does not move.** A run record replays only at the commit it names
(`apps/agent-service/src/audit/replay-run.ts:214-219`), so records made on
`gemini-2.5-flash` keep replaying at their own commits. The new cassette digest starts a new
`eval-history` epoch by construction (`history.ts:163`), so live tallies on the two models
are never pooled. No `baselines/live.json` has been promoted, so there is no live reference
to retire.

### Quota and the per-day split

Every count is `generateContent`. The expected figures are the 2026-11 recordings' counts.
The ceilings are the budgets' `modelCalls`: `memory-recall-001` 7, `tool-use-001` and
`tool-use-002` 5 each. A new model may search more or fewer times, but not more than its
budget allows.

| Phase   | Item                                          | Expected | Ceiling | Bucket                     |
| ------- | --------------------------------------------- | -------- | ------- | -------------------------- |
| 1       | candidate probe, 7 nights                     | 7        | 7       | `gemini-3.5-flash-lite`    |
| 1       | P1-E's alias suite, three memory-recall tasks | 12       | 17      | alias target               |
| 1       | `gemini-3.5-flash-lite` suite                 | 12       | 17      | `gemini-3.5-flash-lite`    |
| 1       | canary jobs in the two dispatches             | 4        | 4       | 2 on the 2.5 pool, 2 alias |
| 1       | new-project probes                            | 3        | 3       | new project                |
| 2       | memory-recall recording                       | 12       | 17      | chosen id                  |
| 2       | red-team recording                            | 12       | 12      | chosen id                  |
| 2       | prior-auth recording                          | 20       | 20      | chosen id                  |
| 2       | canary baseline for the new id                | 1        | 1       | chosen id                  |
| 3       | fresh-clone trial of `memory-recall-001`      | 3        | 7       | new project                |
| **all** |                                               | **86**   | **105** |                            |

Prior-auth adds one call each time an `AssessmentFormatError` retry fires
(`P3-D-payer-dataset-fhir-prior-auth.md:821-824`), and none fired in its recording. The
ceiling counts no 503 retry. A 503 retry is what made 20 requests give 9 answers on
2026-11-09, which is the reason for open question 4.

Only 2 of the 86 calls are on the `gemini-2.5-flash` pool. The nightly spends about 15 of
that pool a day (`.context/conventions.md:502-510`), and P2-D's stage 2 draws on it too. If
step 1e shows each model has its own bucket, the rest of this plan does not compete with
either. The split, at 13 calls or fewer per bucket per day, leaves room for retries:

| Day | Work                                                                    | Chosen / candidate bucket | Alias target | 2.5 pool | New project |
| --- | ----------------------------------------------------------------------- | ------------------------- | ------------ | -------- | ----------- |
| 0   | The candidate probe merges. No calls.                                   | —                         | —            | —        | —           |
| 1–7 | Nightly candidate probe                                                 | 1 a night                 | —            | —        | —           |
| 1   | 1b, alias dispatch; 1d, new-project probes; 1e                          | 1                         | 13           | 1        | 3           |
| 2   | 1c, `gemini-3.5-flash-lite` dispatch                                    | 13                        | 1            | 1        | —           |
| 8   | The rule applied, ADR written. Memory-recall recording, canary baseline | 13                        | —            | —        | —           |
| 9   | Red-team recording                                                      | 12                        | —            | —        | —           |
| 10  | Prior-auth: E0601 and E0470, ten calls                                  | 10                        | —            | —        | —           |
| 11  | Prior-auth: K0823 and E0260, ten calls                                  | 10                        | —            | —        | —           |
| 12  | Merge. Fresh-clone trial.                                               | —                         | —            | —        | 3           |

Days 1 and 2 fall inside the seven nights of days 1–7, and day 8 is the first day the rule
can be applied. If `gemini-3.8-flash` is chosen, days 8 to 11 land on the alias target's
bucket, which the nightly alias probe also draws on, one call a night. If step 1e finds one
bucket for every model in the project, the plan does not fit beside the nightly: about 5
calls a day are spare, and 86 calls take more than seventeen days. The fallback is then
`EVAL_SCHEDULE_PAUSED` for days 8 to 11, which frees the whole 20 and leaves P2-D's stage 2
no calls on those days. The dispatches on days 1 and 2 would need the pause too, because 13
calls beside the nightly's 15 exceed 20. Day 1's dispatch is itself the first evidence: if
it completes after that night's `eval-live`, the alias target's day is not the pinned id's.
The table is revised in this PRD on day 1, before any recording.

**Added with step 1a, 2026-11-09.** The `chat-candidate` probe is on by default, so it runs
in every canary job, not only the scheduled ones, and it stays until the switch. Each
dispatch's canary job therefore spends 1 + 1 + 1, one more on the candidate's bucket than
the tables above count, and the nightly spends one there on days 8 to 11 too. That is two
more calls in phase 1 and up to four in phase 2 on `gemini-3.5-flash-lite`'s bucket, which
takes day 2 to 14 and days 8 to 11 to at most 14 if it is chosen: still inside 20 on a
bucket of its own. A dispatch can leave the probe out with `CANARY_PROBES`, but the
workflow sets no such input.

### Bounding retries on a 503

`createGeminiChat` gets one more option, used only when `EVAL_CASSETTE_MODE` is `record` or
the axis is live under `yarn eval`. It makes a provider 5xx terminal after one retry, and the
run aborts with cause `provider-unavailable`, the canary's cause, with the trials that
finished. `stopOnDailyQuota` keeps its rule for 429s (`rate-limit.ts:106-111`). The service
path keeps LangChain's default, because a user's request is better served by waiting than
by failing. The cost of the bound is an aborted recording on a 503 morning. That costs one
day and keeps the bucket. Without the bound, the same morning spends the bucket and still
aborts, on the 429.

## Acceptance criteria

Each criterion names the axis that verifies it. **Model `live`** means a real key, and
**new-project key** means one from a project that has never called `gemini-2.5-flash`.
**In CI** means the repository secret. **Stubbed transport** means `fetch` is replaced and no
request leaves the process.

**Phase 1**

- [ ] **Model `live` / memory `live`, in CI, taken from P1-E:** one trial of each task with
      `EVAL_CHAT_MODEL=gemini-flash-latest`. The report names that id, and the result is
      recorded in this PRD whether it passes or fails. A failure is a finding about the next
      model or about the client, not a defect in this PRD. This is P1-E:472-482 unchanged,
      verified by a dispatch with `chat_model: gemini-flash-latest`. The suite now has three
      tasks where P1-E's had two, so it costs about twelve calls on the alias target, not
      eight.
- [ ] **Model `live` / memory `live`, in CI:** the same, with
      `chat_model: gemini-3.5-flash-lite`. The result is recorded here whether it passes or
      fails.
- [ ] **Model `live`, new-project key:** one `generateContent` each on `gemini-3.8-flash`,
      `gemini-3.5-flash-lite` and `gemini-2.5-flash`. The status, and the `modelVersion` of
      each answer, are recorded here. The expected 404 on `gemini-2.5-flash` is recorded with
      its message.
- [ ] **Model `live`, in CI:** the canary's `chat-candidate` probe reports on seven
      consecutive scheduled nights. Each night's verdict for it and for the floating probe is
      tabulated here. **Stubbed transport:** a 503 or a changed `modelVersion` on the
      candidate exits 0 with a notice. `runner.test.ts` covers both.
- [ ] Whether `gemini-3.8-flash`, `gemini-flash-latest` and `gemini-3.5-flash-lite` each
      draw on a daily quota apart from `gemini-2.5-flash`'s, and from each other's, is
      recorded with its source: AI Studio's usage view or a 429's `quotaId`. The per-day
      split above is revised before any recording if it does not hold.
- [ ] The rule in "The rule that picks the id" is agreed at review before the first dispatch,
      and the commit that records the agreement precedes the first dispatch's run date.
      **Reviewer, from `git log`.**

**Phase 2**

- [ ] ADR 0018 (or the next free number) is accepted. It names the chosen id and the
      measurements that chose it, the stable-over-alias rule and the triggers for the next
      migration, and it is listed in `docs/adr/README.md`.
- [ ] `PINNED_CHAT_MODEL` is the chosen id. Outside test files,
      `grep -rn "gemini-2.5-flash" apps packages --include=*.ts` returns only
      `STAGE2_CHAT_MODEL` and comments that record history. **Reviewer.**
- [ ] **Stubbed transport:** after the switch, P2-D's answer file replays under the default
      configuration, and `EVAL_ANSWERS_MODE=record` refuses to record unless `CHAT_MODEL` is
      `gemini-2.5-flash`. One unit test each.
- [ ] Every cassette under `packages/eval-harness/datasets/{memory-recall,red-team,prior-auth}/cassettes`
      has `header.chatModel` equal to the chosen id, and each was recorded on model `live` /
      memory `live`. That is 30 cassettes. **Reviewer:** `jq -r .header.chatModel` over the set
      prints one value. The recording's dates, commits and call counts are tabled in this
      PRD, as P3-D and P4-B did.
- [ ] Every task's result on its recording is recorded here, pass or fail. **Blocking,
      decided at review:** prior-auth's wrongful approvals are 0, and no red-team canary
      reaches a surface it is graded on. Any other failure is committed into the replay
      baseline as a known failure, with an owning PRD named beside it.
- [ ] **Model `replay` / memory `live`:** for each of the three suites,
      `EVAL_CASSETTE_MODE=replay EVAL_GATE=replay yarn eval` reports `match` against a
      baseline regenerated from the new set. Two consecutive replays give identical reports
      with timestamps masked. No request reaches `generativelanguage.googleapis.com`.
- [ ] The six budgeted tasks' budgets follow P1-F's rule on the new recording, and each
      task's `notes` gives the recorded input, output and thinking tokens and the call count.
      **Model `replay`:** each replay reports every budget within.
- [ ] **Model `replay` / memory `live`:** `audit-replay.integration.test.ts` and
      `ledger.integration.test.ts`, which replay the committed `memory-recall-001`
      (`.context/conventions.md:335-345`), pass on the new set.
- [ ] `GEMINI_PRICES` prices the chosen id, with the page and the date it was read. If the
      id is `gemini-3.8-flash`, the 2027-01-01 price is noted.
- [x] **Stubbed transport:** with the retry bound, a recording run that meets three
      consecutive 503s makes two requests for that call, writes `eval-abort.json` with cause
      `provider-unavailable`, and keeps the cassettes of the trials that finished. Met on 2026-11-09:
      `apps/agent-service/src/eval/provider-unavailable.test.ts` drives the memory-recall
      harness, `RunsService` and the graph with `IO_RETRY` on a stubbed `fetch`, and fails
      if `IO_RETRY`'s exclusion is removed. The node-level retry was a third layer the design
      had not named; it re-ran the node on a 5xx, and now skips `ProviderUnavailableError`.

**After the merge**

- [ ] **Model `live`, in CI:** the first scheduled canary after the merge reports every
      pinned probe `unchanged`, the new id's `modelVersion` included, and no longer probes
      `gemini-2.5-flash`.
- [ ] **Model `live` / memory `live`, in CI:** the first scheduled `eval-live` after the
      merge runs every memory-recall task on the new id. Its report names it, and its tally
      is the first in a new epoch on `eval-history`.
- [ ] **Model `live` / memory `live`, new-project key:** from a clean clone, `yarn eval`
      with `EVAL_TASKS=memory-recall-001` and one trial completes and passes. This is the
      problem the PRD exists for.
- [ ] The switch is on `main` by 2026-11-30, or the fallback in "The deadline" was carried
      out and recorded here with the 2026-12-01 canary result.

**Documentation**

- [ ] Documentation the change makes false is corrected in the same pull request:
      `.env.example:12`; `.context/conventions.md`'s live-quota section (`:484-533`,
      which names the model and the per-model limit), the canary paragraph (`:388-402`) and
      the new-project paragraph; `docs/STATUS.md` rows 16, 17, 18, 24, 25, 26 and 37, wherever
      they name the model or a recording's figures; `packages/eval-harness/README.md:136`;
      the comments at `model-deps.ts:6-12`, `apps/agent-service/src/agent/model/extraction.ts:26`
      and `apps/agent-service/src/agent/model/usage.ts:8`; and P1-I's paragraph in the index.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass, and so do `yarn turbo test:unit` and `yarn turbo test:service`.

## Risks and open questions

**Decided at review, 2026-11-09.** The draft put six questions. The conductor's decisions,
made before any call in phase 1:

1. **Which id, and the rule.** The rule stands as written, with `gemini-3.5-flash-lite`
   preferred when both candidates pass. The argument against it was that the 404 names
   `gemini-3.8-flash` and that a "Flash-Lite" model may be smaller than the one it replaces.
   The argument for it decided: Google routes the pinned id to it on 2026-12-01, it lists at
   the same price, and it is what this repository's numbers are compared against if nothing
   is done. The rule does not change after step 1b has run.
2. **P1-E's criterion stays the first measurement.** It is a handed-over criterion, it costs
   only the alias target's bucket, and it is the only trial of `gemini-3.8-flash` the plan
   makes. If the alias is unavailable on every attempt until day 8, the criterion stays
   unchecked here and moves, by name, to the PRD that owns the next migration.
3. **No budgets for prior-auth in this PRD.** See Non-goals. The migration stays one
   variable.
4. **The 5xx retry bound is kept**, confined to `yarn eval` on the live axis and to
   recording, with the service's default unchanged. On 2026-11-09 retries turned 20
   requests into 9 answers, and that failure mode would otherwise sit under every recording
   below.
5. **Thinking stays on each model's default**, and each recording's thinking tokens are
   recorded. Setting a level is a second change, measured separately.
6. **No row for the embedding model.** Its date is 2028-05-14 and new projects can call it.
   The trigger for a row is a shutdown date inside a year or a new-project 404.

**Risks.**

- **The premise could fail by Google's choice.** The 2026-12-01 date, the routing target and
  "limited to users who have actively used them" are from a page with no date, read on
  2026-11-09. If the date moves later, the plan is unchanged and the deadline relaxes. If the
  routing target changes, the rule's preference may favour a model that is no longer the
  default. The page is read again on day 8, before the rule is applied, and any change is
  recorded here.
- **Neither candidate may be available enough.** The alias answered on two nights of seven
  from 2026-10-20 to 26, and `gemini-2.5-flash` itself answered 503 on 2026-11-07. Rule 3
  could rule out both candidates. The owner then chooses with the measurements, and the
  nightly runs on a model that will sometimes not answer. The 5xx bound turns those nights
  into an abort with a named cause, which P1-C's contract already handles.
- **One trial is a small sample.** A candidate that passes once can fail on the next night.
  The rule uses one trial to rule a model out, never to prove it good. The first five nights
  of the new epoch are the first pooled rate on the new model. Comparing that rate with
  `gemini-2.5-flash`'s 96% over 14 trials × 2 tasks is P1-D's job.
- **Prior-auth may disagree with its labels.** The 24 labels were written by hand, and
  `gemini-2.5-flash` matched all of them, 0 wrongful approvals in 16
  (`P3-D-payer-dataset-fhir-prior-auth.md:704-710`). A new model may refer where the label says
  approve. That is a finding, recorded as a known failure. A wrongful approval blocks the
  migration until it is understood, because it is the failure the clinician gate exists for.
- **The budgets will rise, and the tables will look worse.** A model that thinks more
  doubles the output budget on the first recording. P1-F's rule lets the number follow the
  recording. The reviewer sees the old and new figures in each task's `notes`, and nothing
  is widened beyond the rule.
- **Routing may be invisible to the canary.** If a routed request still reads
  `modelVersion: gemini-2.5-flash`, nothing in the repository notices 2026-12-01. That
  matters only if this PRD misses its deadline, and the fallback's one probe finds out.
- **Sizing.** `L`, as indexed. The code is small: a constant, a canary probe, a stage-2
  constant, a price, a retry option. The calendar is not: twelve days of quota at the
  least, three suites recorded on a model this repository has made one trial on, and a
  client that has never been run against either candidate's defaults. By P0-A's rule the
  defects behind the recording runs are unknown in number.

## References

- `docs/prd/P1-E-model-drift-canary.md`: the canary, `EVAL_CHAT_MODEL`, the `chat_model`
  dispatch, and the criterion taken over here (`:472-511`).
- `docs/prd/P1-F-cost-and-step-budgets.md` and `.context/conventions.md:403-415`: the budget
  rule.
- `docs/prd/P3-D-payer-dataset-fhir-prior-auth.md` ("The recording, as made") and
  `docs/prd/P4-B-memory-poisoning-red-team.md` ("The recording, as made"): the recording
  commands, batches and call counts this plan repeats.
- `docs/prd/P2-D-graph-explanation-or-removal.md`: stage 2's pre-registered model and budget.
- `.context/conventions.md`, "Live model quota": the shared pool, the reset, the
  new-project 404.
- ADR 0005, `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md`: what replay
  cannot see.
- Canary artifacts, `gh run download <run> -n eval-canary`: runs 38869926347, 39013870656 and
  39222893166 (new-project key, 2026-10-16 to 19), 42202060472, 42360437346 and 42468884736
  (2026-11-06 to 08).
- Gemini deprecations (`gemini-2.5-flash` shutdown 2026-12-01, routing to
  `gemini-3.5-flash-lite`; `gemini-embedding-001` 2028-05-14), read 2026-11-09:
  https://aistudio.google.com/docs/deprecations. The `ai.google.dev/gemini-api/docs/` URLs
  in earlier PRDs now redirect to `aistudio.google.com/docs/`.
- Model pages, both "Stable", read 2026-11-09:
  https://aistudio.google.com/docs/models/gemini-3.8-flash,
  https://aistudio.google.com/docs/models/gemini-3.5-flash-lite
- Model version patterns (stable, latest; "a 2-week notice ... before the version behind
  latest is changed"): https://aistudio.google.com/docs/models
- Pricing (free tier on all three; paid prices above), read 2026-11-09:
  https://aistudio.google.com/docs/pricing
- Rate limits ("applied per project, not per API key"; RPD resets at midnight Pacific;
  figures in AI Studio): https://aistudio.google.com/docs/rate-limits
- NIST AI RMF 1.0, MANAGE 3.1 and MEASURE 2.4: https://doi.org/10.6028/NIST.AI.100-1
