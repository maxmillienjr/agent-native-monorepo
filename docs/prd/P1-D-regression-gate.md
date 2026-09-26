---
id: P1-D
title: Statistical regression gate against committed baselines
tier: 1
status: in-progress
size: L
depends_on: [P1-A, P1-C]
blocks: []
issue: 76
superseded_by: null
---

# P1-D · Statistical regression gate against committed baselines

## Problem

Nothing decides whether an evaluation result should stop a merge. Every fact below was
checked on 2026-09-26 at `32daf96`. The ones about behaviour were checked by running the
replay suite against disposable Postgres and Neo4j containers, with `GOOGLE_API_KEY=` and
`EVAL_CASSETTE_MODE=replay`.

**No check is required to merge into `main`.**
`gh api repos/maxmillienjr/agent-native-monorepo/branches/main/protection` returns
`404 Branch not protected`. `…/rulesets` and `…/rules/branches/main` both return `[]`. The
repository is public, and it allows merge, squash and rebase merges. P1-C found the same
thing and handed it here: "A red job blocks nothing until P1-D makes it a required check"
(`P1-C-tiered-eval-pipeline.md:139-143`).

**The only verdict the runner has is "every trial passed".** `run-eval.ts:143-145` sets
exit code 1 when `report.passRate < 1`, and the rate is computed over the trials that ran
(`harness.ts:155-168`). There is no baseline to compare against, which has these
consequences:

- **A task that stops running raises the rate.** Probe: `tool-use-001.json:5` was changed
  to `"requires": { "model": ["live"] }` and `mergedConceptsMin` was removed from
  `memory-recall-001.json`. The replay run then logged
  `"tasksSkipped":["tool-use-001"]` and `"passRate":1`, and the summary read
  `overall pass rate 100% over 1 of 2 tasks`. **The command exited 0.** The run graded 10
  results where the unmodified run grades 21. The harness drops skipped tasks before the
  trials start (`harness.ts:108-110`), and `buildGraders` builds only the assertions that
  are present in the file (`dataset.ts:156-173`). So deleting a task's requirement or one
  of its assertions produces a green run. P1-G left the question of whether a skipped
  task should block a merge to this PRD (`P1-G-task-axis-requirements.md:94`).
- **A trial that is known to fail cannot be committed.** Any recorded trial that fails a
  grader makes every replay exit 1, permanently. As a result the replay set can only hold
  recordings in which everything passed. It cannot hold a failure kept as a regression
  test.
- **An improvement, or a score that moves without changing its label, is invisible.**
  Scores are fractional (`types.ts:163-167`). Replayed, `tool-use-001` scores
  `trajectory_precision` at `0.777…` and `tool_trajectory_precision` at `0.333…`. Both are
  `pass` because each threshold is 0 (`tool-use-001.json:50-56`). A change that moves
  either value leaves the exit code where it was.

**A replayed run is deterministic, so comparing two replays needs no statistics.** Two
consecutive replays on the same containers produced identical tables of
`(task, trial, grader, label, value)`, all 21 cells. Their `explanation` strings differed
in exactly two places, both from `episodic_row_written` (`2 episodes row(s) for run <uuid>`). P1-B
predicted this and handed it here: a comparison that masks only the four timing and id
fields "will see a false difference in exactly two strings"
(`P1-B-agent-cassette.md:492-497`). P1-C reports that consecutive replays are
byte-identical once run ids are masked (`P1-C-tiered-eval-pipeline.md:181-184`).

**Live results have sampling variance, and there are almost none of them.** The live-axis
evidence is one trial of each task, from the 2026-09-10 recording
(`docs/STATUS.md` row 18). One trial of both tasks costs eight `generateContent` calls:
three for `memory-recall-001` and five for `tool-use-001` (`P1-B-agent-cassette.md:458-463`).
The free tier allows twenty a day (`packages/eval-harness/README.md:130`). `gh secret list`
prints nothing, so CI has no key. P1-C runs the live tier nightly at one trial per task,
with the job conditional on a secret that does not exist. It handed the 5×2 live pass rate
to this PRD for the case where no billed key appears (`P1-C-tiered-eval-pipeline.md:163-167`).

**Nothing keeps a result past artifact retention, and nothing computes an interval.** P1-C
uploads reports as artifacts at the default retention and leaves the choice of a store
here (`P1-C-tiered-eval-pipeline.md:144-146`). `packages/eval-harness/src/stats/` does not
exist. P2-B, which is accepted but not implemented, plans
`stats/paired-bootstrap.ts` "because P1-D needs the same thing"
(`P2-B-retrieval-ablation.md:417-419`).

**The suite has two tasks.** `packages/eval-harness/datasets/memory-recall/` holds
`memory-recall-001.json` and `tool-use-001.json`, and `loadSuite` reads every `.json` file
at the top level of that directory (`dataset.ts:198-217`). P2-B adds a third,
`graph-recall-001`.

### What was handed here

| From | What                                                                                                                                                         | Where                                      |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| P1-A | Statistical gating and baseline comparison; revisiting the no-LangSmith decision "once P1-D needs baseline storage"                                          | `P1-A-eval-harness.md:71`, `:395-396`      |
| P1-B | Comparing a replayed rate against a baseline; the run id inside a grader's explanation                                                                       | `P1-B-agent-cassette.md:113-114, :492-497` |
| P1-C | Which failures block; making a check required; a stored baseline and retention; the 5×2 live rate; whether a stale cassette blocks a contributor with no key | `P1-C-…:139-146, :163-167, :459-462`       |
| P1-G | Whether a skipped task blocks a merge                                                                                                                        | `P1-G-task-axis-requirements.md:94`        |
| P2-B | The bootstrap, to be reused rather than written twice                                                                                                        | `P2-B-retrieval-ablation.md:417-419`       |
| P2-C | `SuiteReport` carries the semantic-conventions commit, so that reports compared across a bump can be told apart                                              | `P2-C-otel-genai-semantics.md:596-600`     |

## Why it matters

A merge gate on a stochastic system has two ways to fail. It can block on noise, and then
people learn to re-run it until it goes green. Or it can pass on too little evidence, and
then it certifies nothing. The literature on evaluation statistics addresses both. Miller
("Adding Error Bars to Evals", 2024) asks for inference on paired, question-level
differences, for clustered errors where observations are correlated, and for a power
analysis before an evaluation is trusted to test a hypothesis. Dror et al. (ACL 2018) ask
that the test be chosen from what is actually known about the metric's distribution,
rather than by habit. A reviewer of a repository whose thesis is evaluation in CI will
look for two things: whether the gate knows which of its inputs are deterministic, and
whether it will say "not enough evidence" instead of guessing. This PRD is the answer to
both. It also turns P1-C's pipeline into something that can stop a merge. Today a red
evaluation job is only a colour.

## Scope

- **A replay gate that compares against a snapshot.** The gate compares a replayed run
  with a committed baseline cell by cell (task, trial, grader, label, value). Any
  difference fails it, and the summary classifies each one.
- **A live comparison that is statistical.** It is a stratified bootstrap over live trials
  pooled within a cassette epoch, compared with a committed reference. It gives one of four
  verdicts, one of which is `insufficient-evidence`, and a sample-size floor stops it from
  reporting `held` on too few trials.
- `packages/eval-harness/src/stats/`: a seeded PRNG and a percentile interval, shared with
  P2-B. It also holds `stratifiedBootstrap`, and the task-level `pairedBootstrap` for suites
  of 20 or more tasks. Whichever of P1-D and P2-B lands first writes the shared files.
- `EVAL_GATE` on the runner (`replay`, `live`, `update`). When it is set, the gate's
  verdict decides the exit code in place of `passRate < 1`. It is declared on `turbo.json`'s
  `eval` task.
- **An append-only history of nightly live results** on an orphan `eval-history` branch.
  The nightly live job writes to it. It keeps live evidence past artifact retention.
- **A repository ruleset, kept as code** in `.github/rulesets/main.json`, that requires the
  replay gate and the existing CI checks. A lint check keeps every required context equal
  to a job name that exists. Applying the ruleset is an owner action.
- The decisions P1-C, P1-G and P1-B left open, written down (see _Which failures block_).

### Non-goals

- **Running the live tier on pull requests.** Rejected, not deferred. P1-C keeps the key
  off every path a pull request triggers (`P1-C-tiered-eval-pipeline.md:155-159`), and a
  single live trial would give a verdict of `insufficient-evidence` anyway (see Design).
  The live comparison runs after merge, on the nightly job.
- **Growing the task suite.** **Unowned**, and this is a gap (see open question 3). P2-B
  adds `graph-recall-001`. P3-D's synthetic payer dataset has no file yet. No PRD takes
  the suite to the 20 tasks at which task-level inference starts to mean something.
- **Detecting model drift within an epoch.** Pooling nights assumes the model under the
  alias is the same on each of them. **P1-E**'s canary is what tests that assumption.
- **Gating on cost, latency or step counts.** **P1-F**. The same baseline file can carry
  those numbers later, and this PRD does not assert them.
- **Re-recording cassettes in CI.** Rejected by P1-C (`:155-159`) and still rejected. The
  abort summary names the local command, and a maintainer pushes the re-recorded set to
  the pull request branch.
- **Gating `release.yml` on the live verdict.** Rejected. The release runs on every push
  to `main` (`release.yml:3-5`), hours before the first nightly on that commit, and the
  repository has no release cadence for a gate to hold back.
- **A third-party results store (LangSmith or similar).** Rejected, which answers P1-A's
  question. It would need a second secret on the nightly and an account a reader cannot
  inspect. The history branch can be read by anyone with `git`.

## Design

### "Paired" means different things on the two axes, which is why the title changed

The index titled this PRD "with paired bootstrap". That title fits neither axis as it
stands:

- **On replay, the pairing is exact and the bootstrap is degenerate.** Trial `i` of a task
  replays cassette `i` in both the baseline and the candidate run. The two runs share every
  model decision, which is the common-random-numbers design in its strongest form. A
  per-cell difference is therefore −1, 0 or +1 with zero variance, and bootstrapping it
  returns `[d, d]`. Any flip is certain evidence that the code changed. The statistics are
  trivial, and so the gate is a snapshot test.
- **On live, the trials are not paired.** Baseline trial 3 and candidate trial 3 share
  nothing, because Gemini gives no reproducibility guarantee to pair them on. The only
  thing both arms share is the task. The estimator is a difference of per-task pass rates,
  and the bootstrap resamples trials within each task (stratified) for each arm
  separately. That is a two-sample stratified bootstrap and not a paired one.
- **The task-paired bootstrap applies once tasks can be treated as a sample.** It resamples
  per-task differences, which Field & Welsh (2007) call the cluster bootstrap. With two
  tasks it has three distinct resamples, so its "95% interval" is the range of the two
  differences. It is used from 20 tasks upwards (see _Two regimes_). That is the point at
  which P2-B's `pairedBootstrap` becomes P1-D's code as well.

### The replay gate: a snapshot, not a test statistic

**The unit is the cell** `(task, trial, grader) → (label, value)`. On the committed set
that is 21 cells. The baseline records every cell, plus provenance:

```ts
// packages/eval-harness/src/gate/baseline.ts
export const ReplayBaselineSchema = z.object({
  kind: z.literal('replay'),
  suite: z.string(),
  /** sha256 over the committed cassette files, sorted by path. Ties the snapshot to its recording. */
  cassetteDigest: z.string(),
  recordedAt: z.string(), // from ReplayProvenance
  gitSha: z.string(), // from ReplayProvenance
  semconvCommit: z.string().optional(), // P2-C's field, when present
  cells: z.array(
    z.object({
      task: z.string(),
      trial: z.number().int().nonnegative(),
      grader: z.string(),
      label: z.enum(['pass', 'fail']),
      value: z.number(),
    }),
  ),
});
```

It lives at `packages/eval-harness/datasets/memory-recall/baselines/replay.json`. It has to
be in a subdirectory, for the same reason the cassettes are. `loadSuite` parses every
top-level `.json` file as a task and throws on anything else (`dataset.ts:34-41`). The
writer puts the cells in sorted order, one per line, so that a pull request's diff of the
baseline reads as a list of the behaviour it changes. The directory is added to
`.prettierignore` next to the cassettes (`.prettierignore:8-10`), because it is generated.

**The explanation is not in the snapshot.** It is prose for a human, and it holds a run id.
Leaving it out closes P1-B's hand-off by construction, where masking would need a list of
fields that someone has to keep up to date.

**The comparison.** `compareReplay(report, baseline, cassetteDigest)` returns one verdict
and a list of every difference:

| Difference     | Meaning                                                            | Blocks |
| -------------- | ------------------------------------------------------------------ | ------ |
| `regressed`    | `pass` → `fail` in a cell                                          | yes    |
| `improved`     | `fail` → `pass` in a cell                                          | yes    |
| `value-moved`  | label unchanged, value changed                                     | yes    |
| `missing`      | a cell in the baseline that the run did not produce (skip, delete) | yes    |
| `unbaselined`  | a cell the run produced that is not in the baseline                | yes    |
| `stale-digest` | the cassette set changed and the baseline was not regenerated      | yes    |

Every difference blocks, because on a deterministic axis each one is a real change in
behaviour, and whoever made it should accept it in review. An improvement blocks too. If it
did not, the baseline would keep an expected `fail`, and a later regression back to `fail`
would match the baseline. Accepting a change takes one command,
`EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval`. It rewrites the baseline and needs
no key. The resulting diff is part of the pull request. **Accepting a regression is a
commit that someone can review, not a button.**

Because every cell is compared exactly, the replay gate has no multiple-comparisons
problem. Twenty-one exact comparisons give no false positives. What they can give is a
**flake**, if the memory axis is not as deterministic as two local runs suggest (see
Risks).

**An aborted run blocks.** P1-C establishes that `eval-report.json` exists only when the
suite completed, and that an abort writes `eval-abort.json`
(`P1-C-tiered-eval-pipeline.md:285-304`). The gate reports `aborted` if `eval-abort.json`
exists or if `eval-report.json` does not. It checks the abort file first, because the
replay watcher throws _after_ the reports are written (`run-eval.ts:120-141`).

### The replay-tier question P1-C left: a stale cassette blocks

A prompt edit makes every replay miss (ADR 0005, "A prompt edit invalidates the set"). A
contributor without a key cannot re-record. **It blocks anyway.** Merging a stale set
does not remove the block, it moves it. Every later pull request's replay job then aborts
on `main`'s cassettes, and the person blocked is someone who did not cause it. The path for
that contributor is the one P1-C already prints. A maintainer with a key runs the
re-record command and pushes the new set and the regenerated baseline to the pull
request's branch, which "allow edits from maintainers" permits. Both diffs are reviewed
like any other code.

### The live comparison: statistical, conditional, and usually `insufficient-evidence`

**What gets pooled: nights within an epoch.** An epoch is a value of `cassetteDigest`.
Any change to what the model is sent, on the recorded paths, forces a re-record, because
replay misses otherwise. Any change after the model's answer (parsing excepted, see below)
shows up exactly in the replay snapshot. So, within one epoch, merged code differs only in
ways that either do not reach the model or are already gated. The exceptions are the
client-side defects ADR 0005 names: `parseExtraction`, `l2Normalize` and the
`embedContent` check. Those are pooled across, and they are what a live `regressed` verdict
is for. A digest over whole files starts a new epoch on every re-record, including one that
changed nothing. That wastes evidence but never mixes two prompts.

**Where the evidence lives.** After each nightly live run, the job appends one compact
tally to the orphan branch `eval-history`, at
`live/memory-recall/<cassetteDigest:12>/<startedAt>-<gitSha:7>.json`:

```ts
export const LiveTallySchema = z.object({
  kind: z.literal('live-tally'),
  suite: z.string(),
  cassetteDigest: z.string(),
  gitSha: z.string(),
  startedAt: z.string(),
  // one boolean per trial: did every grader pass. Per-grader arrays are diagnostic only.
  tasks: z.record(
    z.object({ trials: z.array(z.boolean()), graders: z.record(z.array(z.boolean())) }),
  ),
});
```

Only the live job gets `permissions: contents: write`. It runs only on `schedule` and
`workflow_dispatch`, from `main`, and P1-C's concurrency group prevents two runs from
pushing at the same time. The ruleset targets the default branch only, so the push is
allowed. The branch holds data and no gate reads it directly.

**The reference is committed and reviewed, like the replay baseline.**
`baselines/live.json` holds the pooled tallies of one past epoch, plus the list of runs that
produced them. It is promoted from `eval-history` by a pull request
(`yarn eval:promote-live <digest>`). The reference is not "the previous epoch" by default.
That default would let a regressed epoch become the reference for the next one, which
launders the regression one re-record later.

**The statistic.** `Δ = (1/K) Σ_t (p̂_cand,t − p̂_ref,t)`, where `p̂` is the fraction of
trials in which every grader passed. That is the trial-level definition `passed` already
uses (`harness.ts:141`). Each task has equal weight, which matches `passRate` when the
trial counts are equal. **Only this one statistic is gated.** Per-grader differences are
printed and are not tested. Gating eleven graders separately would need a correction for
multiple comparisons, which Dror et al. discuss, for no decision that the trial-level rate
does not already make.

### Two regimes, chosen by the number of tasks

Miller splits the variance of an evaluation score into two parts. One comes from _which
questions were drawn_ from the super-population. The other is the conditional variance of
the answers to the questions actually drawn. More answers per question reduce only the
second part. With K = 2, the first part cannot be estimated.

| Regime         | When   | Resampling unit                                    | What the interval is about                   |
| -------------- | ------ | -------------------------------------------------- | -------------------------------------------- |
| `tasks-fixed`  | K < 20 | trials, within each task, each arm independently   | **these K tasks only**; nothing beyond them  |
| `tasks-random` | K ≥ 20 | tasks (the per-task differences), P2-B's resampler | tasks like these, which is Miller's question |

The report prints the regime name next to the interval. Today it prints `tasks-fixed`, and
the summary says in words that the result is conditional on two tasks. The threshold of 20
comes from Huang (2018). In simulation, cluster-bootstrap standard errors performed well
from 20 clusters upwards and were mixed at 10. Pooling all trials as independent draws,
which is the obvious third option, is the error Miller warns about: answers to the same
question are not independent.

### The decision rule, pre-registered

This is stated before any live number exists, in the same way P2-B does it
(`P2-B-retrieval-ablation.md:433-444`). The margin is δ = 0.20 on Δ, decided at review; the draft proposed 0.10, and the table below shows why it moved. The interval
is a 95% percentile interval over 10,000 seeded resamples.

- **`regressed`**: the floor is met, `Δ ≤ −δ`, and the upper bound is below 0.
- **`held`**: the floor is met and the lower bound is above `−δ`.
- **`insufficient-evidence`**: everything else, including every case where the floor is
  not met. It is never displayed as passing.
- **`incomparable`**: different task sets, different axes, or no reference yet.

**The floor is the part that makes `held` honest.** When a task's trials are all passes,
the percentile bootstrap has zero variance in that stratum, and it reports `[0, 0]` from
five trials as readily as from five hundred. The floor is the rule of three (Hanley &
Lippman-Hand, 1983). Zero failures in n trials bounds the failure rate at about 3/n with
95% confidence. So `held` requires at least `⌈3/δ⌉` = 30 trials per task in each arm, and
at that point an all-pass sample actually rules out a rate below `1 − δ`. The floor also
applies to `regressed`, so a single failed night cannot turn the nightly red.

**Operating characteristics.** A 400-simulation sketch of this rule (2,000 resamples each,
K = 2, the same true rate on both tasks) gave these results:

| True reference → candidate | Trials per task per arm | `held` | `regressed` | `insufficient` |
| -------------------------- | ----------------------- | ------ | ----------- | -------------- |
| 0.9 → 0.9                  | 5                       | 0%     | 0%          | 100%           |
| 0.9 → 0.9                  | 30                      | 47%    | 1%          | 52%            |
| 0.9 → 0.9                  | 71                      | 82%    | 0%          | 18%            |
| 0.9 → 0.7                  | 71                      | 0%     | 99%         | 1%             |
| 0.9 → 0.8 (exactly δ)      | 71                      | 2%     | 50%         | 48%            |
| 1.0 → 1.0                  | 30                      | 100%   | 0%          | 0%             |
| 1.0 → 0.7 on one task      | 30                      | 0%     | 86%         | 14%            |

**The arithmetic the quota imposes.** For `held` to be the likely verdict (80% power) when
nothing has changed, `n ≥ z²·p(1−p)/δ²` trials per task per arm, where `z = 1.96 + 0.84`
and K = 2. The floor applies on top of that. Each trial of both tasks costs 8
`generateContent` calls.

| δ    | True rate p | n per task per arm | `generateContent` calls per arm | Nights at 1 trial/task |
| ---- | ----------- | ------------------ | ------------------------------- | ---------------------- |
| 0.10 | 0.9         | 71                 | 568                             | 71                     |
| 0.10 | 1.0         | 30 (floor)         | 240                             | 30                     |
| 0.15 | 0.9         | 32                 | 256                             | 32                     |
| 0.20 | 0.9         | 18                 | 144                             | 18                     |
| 0.20 | 1.0         | 15 (floor)         | 120                             | 15                     |

Stated plainly, at P1-C's nightly rate of one trial per task, a live `held` at δ = 0.20
takes two and a half to three weeks per epoch (at 0.10 it would have taken one to two and a
half months), and any re-record starts a new epoch. **Until
then the verdict is `insufficient-evidence`, and the summary prints the trials each task
still needs.** What would change that is a billed key or a separate project, which is P1-C's
decision 1 and belongs to the owner. A `workflow_dispatch` with `trials` set to n then
produces a whole arm in one run. Adding tasks does not lower the cost per call. In the
`tasks-fixed` regime `Var(Δ) ∝ 1/(nK)`, and calls grow with `nK`. What more tasks buy is
the `tasks-random` regime, meaning a statement about tasks the suite did not contain.

**The 5×2 live pass rate P1-C handed over** falls out of the history. After five nights in
one epoch the nightly summary prints the pooled rate as `5 trials × 2 tasks` and lists the
five runs, with their dates and commits. It is a number pooled over five days and is
labelled that way, because it depends on the model staying the same across them (P1-E).

### Which failures block, and where

| Event                                                  | PR check `eval-replay` | Nightly                    |
| ------------------------------------------------------ | ---------------------- | -------------------------- |
| Any replay difference in the table above               | red, blocks merge      | red                        |
| Replay aborted (stale cassette, model call, stores)    | red, blocks merge      | red                        |
| A live trial fails a grader                            | —                      | green; it is data          |
| Live verdict `regressed`                               | —                      | red                        |
| Live verdict `insufficient-evidence` or `incomparable` | —                      | green, with `::notice::`   |
| Live run aborted (quota, stores, axis mismatch)        | —                      | red (P1-C's abort summary) |

On the live axis, a failed trial no longer turns the job red. With `EVAL_GATE=live`, the
exit code comes from the verdict and no longer from `passRate < 1`. On a stochastic axis,
one failed trial is an expected sample, and a nightly job that goes red because of one is
the job people learn to ignore.

### The blocking mechanism: a ruleset as code, applied by the owner

```json
{
  "name": "main",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["~DEFAULT_BRANCH"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    {
      "type": "pull_request",
      "parameters": {
        "required_approving_review_count": 0,
        "dismiss_stale_reviews_on_push": false,
        "require_code_owner_review": false,
        "require_last_push_approval": false,
        "required_review_thread_resolution": false
      }
    },
    {
      "type": "required_status_checks",
      "parameters": {
        "strict_required_status_checks_policy": false,
        "required_status_checks": [
          { "context": "ci (24.x)", "integration_id": 15368 },
          { "context": "e2e", "integration_id": 15368 },
          { "context": "eval-replay", "integration_id": 15368 }
        ]
      }
    }
  ]
}
```

- **Rulesets instead of classic branch protection.** A ruleset is a single JSON document
  that the REST API accepts as-is, so the file can be applied, diffed and reviewed as code.
  Rulesets are available on public repositories on GitHub Free. The owner applies it with
  `gh api --method POST repos/maxmillienjr/agent-native-monorepo/rulesets --input .github/rulesets/main.json`.
  **This PRD cannot apply it.** Only the owner can, so the criterion that needs it is an
  owner criterion.
- **`integration_id: 15368`** is `github-actions`, read from the check runs on `32daf96`.
  Pinning it stops a status posted by any other app from satisfying the check.
- **Context names are the fragile part.** `ci (24.x)` is the job name with the matrix
  value added (`ci.yml:10-14`). A change to the Node version renames the check, and a
  required check that nothing reports stays at "Expected — waiting" indefinitely. P1-C's
  replay job gets an explicit `name: eval-replay`, because P1-C's sketch has none and a
  bare `replay` could collide with a job in another workflow. `scripts/lint-docs.mjs`, which
  already reads every workflow to check the Node version, gains one more check: every
  `context` in the ruleset resolves, after matrix expansion, to exactly one job name.
- **No bypass actors.** On a single-maintainer repository, an admin bypass would make the
  gate optional. The owner's escape hatch is to set `enforcement` to `disabled`, which is
  recorded in the audit log.
- **`strict: false`.** Requiring branches to be up to date would force a rebase after every
  squash-merge. The cost is that two pull requests can each pass against `main` and fail
  once combined. P1-C's `push: main` replay run catches that after merge, and a snapshot
  conflict between two baseline edits shows up as a git conflict before merge.
- **Not required: `images (…)` and the Playwright job.** `images (console)` failed on one
  of the two runs at `32daf96` and passed on the other. Requiring it without a flake rate
  would repeat the problem this PRD is meant to fix. Adding it later is a one-line change
  to this file.
- **Two workflow rules follow from GitHub's semantics.** A job skipped by a condition
  reports success and satisfies a required check. So `eval-replay` has no job-level `if`.
  A workflow that path filters never starts. So `agent-eval.yml`'s `pull_request` trigger
  has no `paths`.

### Layout

```
.github/rulesets/main.json                                   the ruleset, applied by the owner
.github/workflows/agent-eval.yml                             replay job: name + EVAL_GATE=replay;
                                                             live job: EVAL_GATE=live, history push
.prettierignore                                              + datasets/*/baselines/
packages/eval-harness/
  src/stats/prng.ts, percentile.ts                           shared with P2-B
  src/stats/paired-bootstrap.ts                              P2-B's; P1-D's tasks-random regime
  src/stats/stratified-bootstrap.ts                          tasks-fixed regime
  src/gate/baseline.ts                                       ReplayBaseline, LiveTally, LiveReference
  src/gate/compare-replay.ts, compare-live.ts                verdicts
  src/gate/render.ts                                         the summary section
  datasets/memory-recall/baselines/replay.json               generated, reviewed
  datasets/memory-recall/baselines/live.json                 promoted from eval-history, reviewed
apps/agent-service/src/eval/run-eval.ts                      EVAL_GATE; eval-gate.json
apps/agent-service/src/eval/promote-live.ts                  yarn eval:promote-live
scripts/lint-docs.mjs                                        ruleset contexts resolve to jobs
turbo.json                                                   EVAL_GATE, EVAL_HISTORY_DIR on `eval`
```

## Acceptance criteria

Each criterion names the axis that verifies it. **Pure** means a unit test with no store and
no model.

- [x] `compareReplay` returns `match` for identical tables. For each of the six difference
      kinds it returns `differs` with that kind named, and it ignores `explanation`. **Pure.**
      `compare-replay.test.ts`: one case per kind, and the `match` case gives the two runs
      different explanations, one of them a different run id.
- [x] **Model `replay` / memory `live`:** `EVAL_GATE=update` writes `baselines/replay.json`
      with 21 cells. Two consecutive `EVAL_GATE=replay` runs then exit 0 with verdict
      `match`, even though their explanations differ in the run id. Against empty Postgres
      and Neo4j containers on 2026-09-26: `update` exited 0 and wrote 21 cells on cassette
      set `3150d589a5c0`; the two replays exited 0 with `match`, and their
      `episodic_row_written` explanations named runs `3703026f…`/`c44ed421…` and
      `cca9dfbc…`/`01222ccd…`. Repeated after rebasing onto P2-C and P5-C's LangGraph 1.x:
      `update` added only the `semconvCommit` line, the two replays matched, and the
      Problem's probe below again named 11 `missing` cells.
- [x] **Model `replay` / memory `live`:** the Problem section's probe (a task's `requires`
      narrowed, an assertion removed) makes `EVAL_GATE=replay` exit non-zero, naming 11
      `missing` cells. Today it exits 0. Exit 1, and the summary reads 11 `missing` (10 cells
      in the run, 21 in the baseline): `entity_merged` on `memory-recall-001` and all ten of
      `tool-use-001`'s, while the rate above it still read 100% over 1 of 2 tasks.
- [x] **Model `replay` / memory `live`:** a threshold raised so that a replayed cell fails
      gives `regressed`, and restoring the threshold gives `match` again. Lowering a
      threshold on a cell that was `fail` in a hand-edited baseline gives `improved`, which
      also blocks. `tool-use-001`'s `trajectory_precision` threshold 0 → 0.9: exit 1,
      `regressed`, pass 0.778 → fail 0.778; restored: exit 0, `match`. The failing cell
      accepted with `EVAL_GATE=update` (a one-line baseline diff, `pass` → `fail`) and the
      threshold lowered back to 0: exit 1, `improved`. With the threshold left at 0.9 the
      accepted baseline matches, exit 0, at a pass rate of 50% — a committed known failure.
- [x] **Model `replay` / memory `live`:** with `eval-abort.json` present, the gate reports
      `aborted` and exits non-zero whether or not `eval-report.json` exists. It is checked
      with P1-C's hash-flip probe and with a report written before the watcher throws.
      Hash-flip probe on `memory-recall-001.trial-0.json`: exit 1, `eval-gate.json` reads
      `aborted` with reason `` `eval-abort.json` is present (`cassette-miss`) ``. The runner no
      longer writes a report before the watcher throws (P1-C, "What shipped"), so the
      directory holding both files is constructed in `gate.test.ts` › "is aborted when
      eval-abort.json is present, whether or not a report is".
- [x] **Model `replay` / memory `live`, in CI:** `eval-replay` runs on the pull request
      that adds it, reports `match`, and its summary shows the gate section. It is run five
      more times on one commit via re-run with zero differences, which is the determinism
      evidence the risk below needs. Pull request #80, run 36268329998 at `48e187c`: the
      job logged `"verdict":"match"`, and the uploaded `eval-summary.md` ends with the
      section headed `Gate — replay: match` over all 21 cells. Attempts 2–6 of the same
      job on the same commit each logged `match` and succeeded. An earlier head of the
      branch, before the rebase onto P2-C, gave the same six out of six (run 36267140212).
      Twelve CI replays and six local ones: no flake yet.
- [x] `stratifiedBootstrap` returns identical intervals for the same input and seed, and
      `[0, 0]` for identical arms. `pairedBootstrap`, which is P2-B's, gives the same
      guarantees. **Pure.** `stratified-bootstrap.test.ts` › "returns the identical interval
      for identical input and seed" and "returns exactly [0, 0] for identical arms with no
      variance"; `paired-bootstrap.test.ts`, P2-B's file byte for byte, has the same two.
- [x] `compareLive` returns `insufficient-evidence` whenever any task has fewer than
      `⌈3/δ⌉` trials in either arm, whatever the interval, and `incomparable` for mismatched
      task sets. It picks `tasks-random` at K ≥ 20 and names the regime. **Pure.**
      `compare-live.test.ts`: 14 failures against 14 passes gives Δ = −1 with a zero-width
      interval and still `insufficient-evidence`; one short arm on one task does the same;
      K = 19 is `tasks-fixed` and K = 20 `tasks-random`.
- [x] A seeded simulation test of the rule at δ = 0.20, K = 2, 400 simulations: with no
      change at p = 0.9 and n = 18, `held` ≥ 75% and `regressed` ≤ 5%. With p dropping
      from 0.9 to 0.5, `regressed` ≥ 95%. With n = 5, `insufficient-evidence` is 100%.
      The thresholds are the simulation's to confirm; if 400 seeded runs miss one, the
      criterion reports the measured rate and the rule is revisited, not the threshold.
      **Pure.** Measured, at 2,000 resamples per interval as in the PRD's own sketch: no
      change gives `held` 342/400 (85.5%) and `regressed` 2/400 (0.5%); 0.9 → 0.5 gives
      `regressed` 390/400 (97.5%); n = 5 gives `insufficient-evidence` 400/400. The test
      asserts the thresholds, so a change to the rule that misses one fails it.
- [ ] **Model `live` / memory `live`:** `EVAL_GATE=live` exits 0 on a run with a failed
      trial and a verdict other than `regressed`, and appends a tally that validates
      against `LiveTallySchema`. It is verified locally with the developer key
      (`EVAL_TRIALS=1`, 8 calls) and stated as such, because no repository secret exists.
      **Not run:** this implementation was not cleared to spend the developer key's daily
      quota. The runner half is unit-tested — `gate.test.ts` › "on live, appends a tally
      that validates and stays green on a failed trial" — but no live model produced the
      trial. **Owner:** the repository owner, one local run of eight calls.
- [ ] **Model `live` / memory `live`, in CI:** the nightly pushes its tally to
      `eval-history`, and after five nights in one epoch its summary reports the pooled
      5×2 rate with the list of runs. This needs the repository secret. If none exists at
      ship time, the criterion stays unchecked and passes to **P1-E**, as P1-C's nightly
      criterion does. No secret exists, so it passes to **P1-E**. The pieces it needs are
      tested without one: the writer against a bare repository (`history.test.ts`), and the
      pooled line and run list (`render.test.ts` › "prints the pooled 5×2 rate with the five
      runs").
- [x] `scripts/lint-docs.mjs` fails when a ruleset `context` matches no job, or more than
      one, after matrix expansion. It is shown by renaming `eval-replay` in a scratch
      commit. **Pure.** A scratch commit renaming the job to `eval-replay-renamed` made
      `yarn lint:docs` report the check `eval-replay` as one no workflow job reports; it was
      then reset. `ruleset.test.mjs` keeps the rename, a Node bump in `ci`'s matrix and a
      duplicate name as tests that run under `yarn lint:docs`.
- [ ] **Owner:** the ruleset is applied, and
      `gh api repos/maxmillienjr/agent-native-monorepo/rules/branches/main` lists
      `pull_request`, `required_status_checks`, `deletion` and `non_fast_forward`. A
      throwaway pull request that flips a replayed cell shows `eval-replay` as required
      and failing, and the merge button is disabled. Not applied here, by decision.
- [x] Documentation this change makes false is corrected in the same pull request:
      `run-eval.ts:143-144`, `packages/eval-harness/README.md:162`, `README.md:14` and
      `:89`, `docs/STATUS.md:70` and rows 17–18, and `.context/conventions.md` (the
      baseline update command goes beside the re-record rule at `:133`). The comment moved
      to `run-suite.ts` with P1-C and now says the gate replaces it; the other six are
      rewritten, STATUS has a row 22 for the gate, and the conventions carry the baseline
      command beside the re-record rule and a rule that a CI eval job exits on the verdict.
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn turbo test:unit`, `yarn lint:docs` and
      `yarn format:check` pass. So does `yarn turbo test:service`.

## What shipped, and where it diverged from the design

Measured 2026-09-26. No run below made a model call.

**The status stays `in-progress`.** Three criteria are open, and none is this change's to
close: the owner applies the ruleset, P1-E takes the nightly that needs a secret, and the
local live run waits for someone who may spend the developer key's quota. Until the ruleset
is applied a red `eval-replay` still blocks nothing, and every document that says so names
that action.

Where the build is not what the Design section describes:

- **There is no `prng.ts` or `percentile.ts`.** P2-B wrote the shared file first, on its
  own branch, as one `stats/paired-bootstrap.ts` holding `mulberry32`, the seed default and
  the percentile indices. This change takes that file and its test byte for byte (P2-B's
  `46dca7b`) and imports the generator from it, so the two branches add the same content
  at the same path and git merges them cleanly. The barrel's export block is P2-B's too.
  Whichever of P1-D and P2-B merges second checks that the file did not move in between.
  `stratifiedBootstrap` repeats the three lines of percentile arithmetic rather than
  editing P2-B's file, which would reopen the conflict the copy exists to avoid.
- **A live run's epoch is read from git, not from disk.** The live job deletes the
  committed cassettes before it records (P1-C), so by the time a tally is written the
  directory holds that night's recordings. `committedCassetteDigest` hashes the set
  committed at `HEAD`, with the same function the replay gate applies to the files on disk;
  a unit test asserts the two agree on a clean checkout and that the git one survives the
  deletion.
- **The git half of the history is its own command.** `EVAL_GATE=live` only writes the
  tally into `EVAL_HISTORY_DIR` and reads the epoch back. Opening the branch (fetch, or
  start the orphan) and publishing it (commit, push, and on a rejected push fetch, rebase
  and retry) are `yarn workspace @repo/agent-service eval:history open|publish`, tested
  against a bare repository and clones, including two first nights that each start the
  orphan. The branch is a worktree of the checkout, so the push uses the credentials
  `actions/checkout` left and needs none of its own. The tally file name drops the colons
  from `startedAt`, which a Windows checkout cannot hold.
- **`baselines/live.json` has a schema the Design did not give.** It is the pooled epoch —
  suite, digest, the list of runs, and per task every trial's pass/fail — with
  `kind: 'live-reference'`. `yarn eval:promote-live <digest>` writes it and refuses to
  create `eval-history` when the remote has none.
- **The gate refuses an axis it cannot judge, before the Nest context.** `EVAL_GATE=replay`
  or `update` off the replay axis, `live` off the live axis, or `live` without
  `EVAL_HISTORY_DIR`, is an abort. A missing replay baseline is every cell `unbaselined`,
  and an error inside the gate itself (a baseline that does not parse) is written as
  `aborted` with the reason, so `eval-gate.json` exists whenever `EVAL_GATE` was set.
- **The ruleset lint uses a YAML parser and has its own tests.** While this was in flight
  P4-A made `yaml` a root dependency and put `node --test` under `yarn lint:docs`, so the
  check is `scripts/lib/ruleset.mjs` with `scripts/ruleset.test.mjs`, rather than a line
  reader inside `lint-docs.mjs`. It refuses a job name with an expression or a matrix with
  `include` or `exclude`, instead of guessing how GitHub would name it.
- **The history's git runs without inherited `GIT_*` variables**, the convention P4-A wrote
  after a fixture test ran against this repository under `rebase --exec`.
- **`semconvCommit` is provenance, not a cell.** P2-C merged mid-flight and `SuiteReport`
  now carries `genAiSemconvCommit`; the baseline records it and the comparison ignores it,
  because a conventions bump renames span attributes and moves no grader result.
- **STATUS row 17's owner is now P1-E**, which takes the live 5×2 rate with the nightly.
  The gate is a new row 22.

**For P2-B, whichever merges second.** P2-B adds `graph-recall-001` to the suite this gate
snapshots. Once both have merged, the replay gate reports that task's cells as `unbaselined`
until its cassette exists and the baseline is regenerated with
`EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval`. P2-B's `EVAL_TASKS` narrows the
suite and renames it, and a narrowed replay under `EVAL_GATE=replay` reports every other
task's cells as `missing`, which is correct: a narrowed run is not the gated run.

## Risks and open questions

**Open questions, decided at review 2026-09-26.**

1. **The margin δ, and therefore how long `insufficient-evidence` lasts.** 0.10 is the
   proposal. The table above shows its price: 30 to 71 nights per epoch on the free tier.
   δ = 0.20 halves or better the wait and can only detect a drop of twenty points. Like
   P2-B's margin, it has to be agreed before any live number exists. _Decided: δ = 0.20._
   On two tasks at one live trial a night, 0.10 would leave the live half reading
   `insufficient-evidence` for up to ten weeks after every re-record, a gate nobody could
   read. The replay half is exact either way. Tightening δ is a later decision made with
   the pooled data in hand, recorded as a change to this PRD's successor, never an edit to
   a verdict already issued.
2. **The store for live evidence.** The proposal is the orphan `eval-history` branch,
   written by the nightly with `contents: write`. The alternatives are artifacts only (90
   days, which is shorter than one epoch at δ = 0.10), release assets, or a third-party
   store (rejected above). If the answer is "artifacts only", the pooling criterion is
   unreachable at δ = 0.10, and the live half of this PRD shrinks to single-run reporting.
   _Decided: the orphan `eval-history` branch_, as proposed.
3. **Who grows the suite.** The `tasks-random` regime is built and tested on synthetic data,
   and nothing will exercise it on real data until 20 tasks exist. The recommendation is a
   new Tier 1 PRD that owns the task set: which failure modes it covers and how its tasks
   get recorded, which costs quota. The alternative is to leave `tasks-random` out and
   state the gap. _Decided: no new PRD._ The suite grows through the PRDs that already add
   tasks — P2-B's `graph-recall-001`, P3-D's prior-authorization tasks, P4-B's red-team
   cases and P4-C's second tool — and `tasks-random` is built and tested now so that it
   switches on when the count reaches 20, rather than being designed then. Whether it ever
   reaches 20 is stated in the report, not assumed.

**Risks.**

- **A flake on the memory axis would block unrelated pull requests.** Determinism has been
  shown by two local replays (P1-B and this draft) and one CI run (P1-C). Both service
  images use floating tags (`agent-eval.yml:13`, `:23`), and P1-C already flags an ordering
  change from a store upgrade as a possible cassette miss. The five-re-run criterion is
  there to measure this. If a flake appears, the gate's per-cell diff names the cell, and
  the fix is to pin the image digests, not to retry the gate.
- **The epoch key assumes that a prompt change always forces a re-record.** That holds on
  the recorded paths only. A live trial can take a path the cassette never did, for
  example a different tool selection, and a prompt used only on that path can change
  without the replay missing. The pooled sample then mixes two prompts. The known path
  today is `selectTool`'s instruction (`runs.service.ts`), which both tasks exercise, so
  the gap is theoretical at K = 2. It grows as tasks diverge.
- **Pooling nights assumes the model is stationary.** `CHAT_MODEL` is a floating alias
  (`runs.service.ts:63`, per P1-C). A provider-side change within an epoch shifts the
  candidate arm, and this rule would attribute that to the code. P1-E's canary is what
  separates the two causes, and until it exists the nightly summary says that the
  comparison cannot tell them apart.
- **The ruleset JSON is unverified until it is applied.** No dry run exists for a
  repository ruleset on GitHub Free (`evaluate` enforcement is an Enterprise feature). A
  `422` on first apply is fixed in the file, not in the UI, so that the file stays the
  source of truth.
- **The live sample size may never be reached.** On the free tier with a re-record every
  few weeks, the live verdict may stay `insufficient-evidence` indefinitely. The PRD
  intends it to say so. It is not a defect of the design, but it does mean the live half
  has no conclusive output until the owner decides the quota question.
- **Sizing.** `L`, where the index had `M`. Every part of it sits on P1-C's workflow and
  runner changes, and none of those has run yet. The history push and the ruleset have
  never been run in this repository either. Following `.agents/prd-author.md`, code that
  has never run is sized as unknown. The known work (two comparators, three resamplers
  counting the shared one, a history writer, a promotion script, a lint check and a
  ruleset) already fills five days before the first surprise.

## References

- Efron, Tibshirani, _An Introduction to the Bootstrap_, Chapman & Hall, 1993: the
  percentile interval and the two-sample bootstrap.
- Dror, Baumer, Shlomov, Reichart, "The Hitchhiker's Guide to Testing Statistical
  Significance in Natural Language Processing", ACL 2018, pp. 1383–1392:
  https://aclanthology.org/P18-1128/
- Miller, "Adding Error Bars to Evals: A Statistical Approach to Language Model
  Evaluations", 2024: https://arxiv.org/abs/2411.00640. The variance decomposition
  (§3), clustered standard errors, question-level paired differences, and power analysis.
- Field, Welsh, "Bootstrapping clustered data", _JRSS B_ 69(3):369–390, 2007: the cluster
  bootstrap versus the two-stage bootstrap.
- Huang, "Using Cluster Bootstrapping to Analyze Nested Data With a Few Clusters",
  _Educational and Psychological Measurement_ 78(2), 2018:
  https://pmc.ncbi.nlm.nih.gov/articles/PMC5965657/. It is the source of the 20-task threshold.
- Hanley, Lippman-Hand, "If nothing goes wrong, is everything all right? Interpreting zero
  numerators", _JAMA_ 249(13):1743–1745, 1983: the rule of three.
- GitHub, rulesets and the REST endpoint:
  https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository
- GitHub, a skipped job satisfies a required check:
  https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/defining-the-mergeability-of-pull-requests/troubleshooting-required-status-checks
- ADR 0005: why a replayed number is a frozen sample, and the defect class only the live
  tier covers.
