---
id: P1-C
title: Tiered evaluation pipeline replacing the nightly stub
tier: 1
status: in-progress
size: M
depends_on: [P1-A, P1-B]
blocks: [P1-D, P1-E, P1-F]
issue: 56
superseded_by: null
---

# P1-C · Tiered evaluation pipeline replacing the nightly stub

## Problem

No workflow runs the agent. Every fact below was checked on 2026-09-26 at `4516f4e`.

**The nightly job runs a suite that already runs on every pull request.**
`.github/workflows/agent-eval.yml:3-6` runs the job at 03:00 UTC and on dispatch. It seeds
fixtures (`:39-45`) and runs `yarn turbo test:eval` (`:47`). Exactly one workspace declares
that script: `packages/memory-core/package.json:15`, whose value is the
`test:integration` command on the line above it with `REQUIRE_INTEGRATION_ENV=1` in
front. The latest scheduled run (36229329111, 2026-09-26, 1m10s, green) logged
`Test Files 5 passed (5)` and `Tests 27 passed (27)`, all from `@repo/memory-core`. The
same five files run on every pull request: `e2e.yml:39` runs `yarn turbo test:integration`
against the same two service containers, and PR run 34553312030 logged
`Test Files 5 passed (5)` from `@repo/memory-core:test:integration`. The nightly differs
by one flag. The flag turns a missing store variable into a failure
(`packages/memory-core/test/integration-env.ts:50-57`) where the PR job would skip.

**The seed step seeds for nothing.** `scripts/seed-eval-fixtures.mjs` is called only from
`agent-eval.yml:40`, and the memory-core suite does not read what it writes. The eval
runner does not need it: `AgentServiceHarness.reset` applies each task's seed before every
trial, and its comment says the script "stays because the nightly workflow seeds before it
runs anything, and P1-C owns that path" (`apps/agent-service/src/eval/agent-harness.ts:101-103`).
Verified: a replay run against freshly started, empty Postgres and Neo4j containers, with
no seed step, passed every grader. `MemoryModule` runs migrations on boot
(`memory.module.ts:63`) and sets up the checkpointer tables (`:117`).

**The replay tier exists, costs nothing, and nothing runs it.** No file under `.github/`
contains `yarn eval`. Run locally with `GOOGLE_API_KEY=`, `EVAL_CASSETTE_MODE=replay` and
the two stores in disposable containers, it logged
`"axes":"model=replay memory=live"`, ran one trial of each task (the cap from P1-B), passed
all graders, and wrote all three reports. It took 17s wall clock including Turbo and the
Nest boot, and about 2.3s of trials. With the stores unset it refuses before any trial:
`the memory axis is unconfigured: set DATABASE_URL and NEO4J_URI` (`agent-harness.ts:227-234`).
The pull-request tier therefore needs the two service containers but no key.

**CI has no model key.** `gh secret list` prints nothing. `GET /repos/{owner}/{repo}/actions/secrets`
returns `total_count: 0`, and the repository has no environments. ADR 0005 says the live
tier covers the defect class that replay cannot see, and it assigns that tier to this PRD
("P1-C owns keeping that tier alive"). With no key, no CI job can run that tier. The
repository is public, and `main` has no branch protection (the protection endpoint returns 404) and no rulesets, so no check is required to merge today.

**A stale cassette and a failed grader produce the same exit code, and only one of them
writes a report.** P1-B listed this as a risk. It has now been checked by running both
cases. One `plan.callLlm` request hash in `memory-recall-001.trial-0.json` was changed,
which is what a prompt edit does, and replay was run again:

- `IO_RETRY` retried the `CassetteMissError` twice, at 400ms and 800ms. A miss does not
  consume an entry, so attempts two and three can only miss again. `retryOn` excludes only
  `ZodError` and a 4xx status (`graph/retry.ts:32`).
- The error escaped `harness.ts:131`, which has no `catch`, and then `main().catch`
  (`run-eval.ts:206-212`). The process exited 1. **The output directory was empty**: no
  JSON, no JUnit and no Markdown.
- A graded failure also exits 1 (`run-eval.ts:145`), but it writes all three reports.

The exit code cannot carry the difference, even after a change to the runner. A probe that
replaced the `eval` script with `node -e process.exit(2)` returned **1** under both
`yarn turbo run eval` and `yarn eval`, because Turbo reduces a failing task's exit code to 1.

**P1-A's `IO_RETRY` hand-off is true but incomplete, and the fix it implies would make
things worse.** P1-A says `isClientError` treats a 429 as terminal (`retry.ts:10-15`), and
that is correct. On the chat path, though, the 429 is retried before it reaches `IO_RETRY`.
`ChatGoogleGenerativeAI` sends `generateContent` through LangChain's `AsyncCaller`
(`@langchain/google-genai@0.2.18` `dist/chat_models.js:736-737`). The caller retries any
status outside `STATUS_NO_RETRY` (`@langchain/core@0.3.80` `dist/utils/async_caller.js:3-13`,
which does not list 429), up to a default `maxRetries` of 6 (`:78`). This was measured with
`fetch` stubbed to answer 429 every time, a fake key, and no network: **one `invoke` made 7
requests over 92 seconds** and then threw `GoogleGenerativeAIFetchError` with
`status: 429` and `errorDetails` intact. `IO_RETRY` then stopped it. The embed path has no
client retry: `gemini-embedder.ts:42-47` throws `EmbeddingRequestError` with status 429, and
`IO_RETRY` stops on the first attempt. The quota this repository actually runs into is the
20-request **daily** `generateContent` free tier (`.context/conventions.md:123-124`). No
retry at either layer can succeed against a daily limit. Adding 429 to `IO_RETRY`'s
retryable set would turn 7 chat requests into 21 and spend about four and a half minutes
per call on a quota that resets the next day.

**A job that lost its key or its mode goes green on the stub.** `detectAxes` falls back to
`model=stub` when `GOOGLE_API_KEY` is empty and `EVAL_CASSETTE_MODE` is not `replay`
(`axes.ts:156-165`). On the stub axis, `tool-use-001` is skipped and the suite reports
100% over one task with exit 0 (P1-G, "What shipped"). `run-eval.ts:74-80` logs a warning
and continues. So a live job whose secret is missing, or a replay job whose
`EVAL_CASSETTE_MODE` Turbo strips, passes after measuring the canned model set.
`test/integration-env.ts` was written to stop exactly this kind of green run.

## Why it matters

Tiered evaluation is the test pyramid applied to a stochastic system. A cheap,
deterministic tier runs on every change and catches regressions in the code. An expensive,
sampled tier runs on a schedule and catches the things the cheap tier cannot see: the
model, the client, the provider. Both halves of that design are already decided here. ADR
0005 is accepted and says a replayed suite "is not a substitute for [the live tier] and
must never be described as one". P1-B built the mechanism for the cheap tier and measured
it at zero model calls. Neither tier is wired into CI, and the workflow named after
evaluation is green every night without starting the agent. For a repository whose stated
thesis is evaluation in CI, this is the gap a reviewer finds first. It is also the input
every later Tier 1 PRD needs. P1-D cannot gate on a report that CI does not produce. P1-E
cannot compare a live run against a replay when neither runs on a schedule. P1-F cannot
assert a budget on transcripts that never leave a laptop.

## Scope

- `agent-eval.yml` rewritten as two jobs: a **replay** tier on pull requests, pushes to
  `main` and the schedule; and a **live** tier on the schedule and on dispatch only.
- `EVAL_EXPECT_AXES`: the runner refuses before the first trial when the detected axes
  differ from the axes the job declared. The variable is declared on `turbo.json`'s `eval`
  task.
- An **aborted** run writes `eval-abort.json` and an `eval-summary.md` that name the error.
  A run that completes writes the same three reports as today. The rule is: a report file
  exists only if the suite completed.
- Every job writes its Markdown summary to `$GITHUB_STEP_SUMMARY` and uploads its output
  directory as an artifact, with `if: always()` on both steps.
- `IO_RETRY` stops retrying a `CassetteMissError`.
- A 429 that reports an exhausted **daily** quota is classified as terminal on both model
  paths, stops the chat client's own retries, and appears as a named cause in the abort
  summary. No new retry is added for any 429.
- `memory-core`'s `test:eval` alias is retired: the script (`memory-core/package.json:15`),
  the root script (`package.json:18`) and the Turbo task (`turbo.json:35-39`).
  `REQUIRE_INTEGRATION_ENV: '1'` moves onto `e2e.yml:39`, so nothing it guaranteed is lost.
- `scripts/seed-eval-fixtures.mjs` and its workflow step are deleted. The comments that
  mention the script are updated.
- Documentation that the change makes false is corrected in the same pull request (see the
  last criterion).

### Non-goals

- **Deciding which failures block a merge.** That is **P1-D**. P1-D also owns making a
  check required, which needs branch protection that `main` does not have, and comparing a
  rate against a stored baseline. P1-C's jobs go red on any aborted run or failed trial,
  which is the exit contract `yarn eval` already has (`run-eval.ts:143-145`). A red job
  blocks nothing until P1-D makes it a required check.
- **Keeping reports past artifact retention.** Also **P1-D**, which needs a baseline to
  compare against. P1-C uploads artifacts with the default retention and does not choose a
  store.
- **Naming the chat model id in a live report, and pinned versus floating ids.**
  `CHAT_MODEL` is the alias `gemini-2.5-flash` (`runs.service.ts:63`), and no reporter
  prints it. **P1-E** owns both, and owns comparing the nightly live decisions against the
  committed cassettes. P1-C's nightly keeps those decisions as an artifact at no extra cost
  (see Design), and does not compare them.
- **Cost, latency and step budgets as assertions.** **P1-F**. The nightly live transcripts
  carry `tokenCounts`. A replayed `latencyMs` measures replay speed, as P1-B's non-goals
  already say.
- **Re-recording cassettes in CI.** Rejected, not deferred. It would put the key on a path
  that pull requests trigger, and a same-repository branch's pull-request workflow can read
  repository secrets. It would also cost about eight of the twenty daily `generateContent`
  calls on every push. Re-recording stays a deliberate local command
  (`.context/conventions.md:123-124`), and the abort summary prints it.
- **Rendering the JUnit XML as a check run.** Rejected. The third-party actions that do this
  need `checks: write`, which workflows triggered from forks do not get, and the Markdown
  summary already renders the same table. The XML is uploaded with the other reports.
- **A 5×2 live suite on the free tier.** It cannot fit in one day. `tool-use-001` alone
  costs five `generateContent` calls per trial (P1-B, "What shipped"), so five trials of it
  exceed the daily twenty. P1-C gives the live job a `trials` dispatch input. Whether to run
  it at five is open question 1. If the answer is no, the missing live pass rate goes to
  **P1-D**, whose baseline needs more than one live trial.
- **Retrying a transient 429 on the embed path.** No run in this repository has observed
  one. **No PRD owns it.** Adding it would mean designing against a guess, the same
  reasoning P1-G gives for tool descriptions.

## Design

### Two tiers, and what each can catch

| Tier   | Trigger                                | Model axis | Memory axis                    | Key                      | Model calls                                 |
| ------ | -------------------------------------- | ---------- | ------------------------------ | ------------------------ | ------------------------------------------- |
| replay | `pull_request`, `push: main`, schedule | `replay`   | `live`, two service containers | none                     | 0                                           |
| live   | schedule, `workflow_dispatch`          | `live`     | `live`, two service containers | `secrets.GOOGLE_API_KEY` | 8 `generateContent` per trial of both tasks |

The **replay** tier catches changes to the graph, to how the prompts affect branching, to
the memory writes, to the graders and to the retrieval path. It is deterministic: P1-B
showed two consecutive replays produce byte-identical reports once the run ids are masked.
So a failed trial here means something actually changed, not a noisy result. It cannot
catch the model getting worse or the client breaking (ADR 0005).

The **live** tier catches what replay cannot: defects between the wire and the value a seam
returns, such as `parseExtraction`, `l2Normalize` and the `embedContent` response check.
That is the class of defect that made P2-A ship broken twice. At one trial per task it
gives a sample, not a reliability rate. Eight calls a night fits inside the twenty-call
daily limit and leaves twelve for development.

The schedule runs replay as well as live, so the nightly summary shows the frozen sample
and the current model side by side. That comparison is P1-E's input. P1-C only puts the
two results in the same run.

The memory integration suite stays where it already runs on every pull request
(`e2e.yml:39`), and gains the one thing the nightly gave it: `REQUIRE_INTEGRATION_ENV`.

### Workflow shape

```yaml
name: Agent Eval

on:
  pull_request: { branches: [main] }
  push: { branches: [main] }
  schedule: [{ cron: '0 3 * * *' }]
  workflow_dispatch:
    inputs:
      trials:
        description: Live trials per task. About 8 generateContent calls per trial at HEAD.
        default: '1'

env: # workflow level: both jobs point at their own service containers
  DATABASE_URL: postgresql://postgres:postgres@localhost:5432/agentdb
  NEO4J_URI: bolt://localhost:7687
  NEO4J_USER: neo4j
  NEO4J_PASSWORD: password

jobs:
  replay:
    services: { postgres: …, neo4j: … } # as agent-eval.yml:11-26 today
    env:
      EVAL_CASSETTE_MODE: replay
      EVAL_EXPECT_AXES: model=replay memory=live
      EVAL_OUTPUT_DIR: ${{ runner.temp }}/eval-replay
    steps:
      - checkout, setup-node, yarn install --immutable
      - run: yarn eval
      - if: always()
        run: cat "$EVAL_OUTPUT_DIR/eval-summary.md" >> "$GITHUB_STEP_SUMMARY"
      - if: always()
        uses: actions/upload-artifact@v7 # the version e2e.yml:77 already pins
        with: { name: eval-replay, path: ${{ runner.temp }}/eval-replay }

  live:
    if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'
    concurrency: { group: eval-live, cancel-in-progress: false }
    services: { postgres: …, neo4j: … }
    env:
      GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
      EVAL_CASSETTE_MODE: record
      EVAL_EXPECT_AXES: model=live memory=live
      EVAL_TRIALS: ${{ inputs.trials || '1' }}
      EVAL_OUTPUT_DIR: ${{ runner.temp }}/eval-live
    steps: # as replay, plus the recorded cassettes in the artifact
```

Four details in that sketch come from something that was checked:

- **`EVAL_OUTPUT_DIR` is absolute.** `run-eval.ts:60` resolves it against the working
  directory, and under Turbo that is `apps/agent-service`.
- **The key never appears in the replay job.** The job does not reference the secret, so
  code from a pull request never has it in its environment. The existing watcher
  (`run-eval.ts:134-141`) still fails the run if a request reaches the model host.
- **The live job records.** `record` does not change the axis: it is a live run that keeps
  a copy (`axes.ts:150-154`). So the nightly's decisions become an artifact at no extra
  cost. That includes any recorded error, which is how a live failure gets diagnosed after
  the fact. The files overwrite the committed set only in the runner's checkout and are
  never committed.
- **One live run at a time.** Two overlapping runs on one daily quota make it impossible to
  tell which run exhausted it.

### `EVAL_EXPECT_AXES`

```ts
// run-eval.ts, before prepare() and before the Nest context
const expected = process.env['EVAL_EXPECT_AXES'];
if (expected !== undefined && expected !== describeAxes(axes)) {
  throw new AxisExpectationError(expected, describeAxes(axes));
}
```

The value is compared with `describeAxes`'s own output (`axes.ts:167-169`), so the check
reuses the existing format. It follows the precedent of `REQUIRE_INTEGRATION_ENV`: a
variable that turns a quiet fallback into a named failure. A live job with no secret then
fails before any trial with `expected model=live memory=live, detected model=stub
memory=live`. That is the message that shows up in CI when the secret is missing, and it
needs no step of its own in the workflow. The variable has to be declared in
`turbo.json`'s `eval` `env` list (`:43-52`). If it is not declared, strict mode strips it
and the guard never runs. `.context/conventions.md` warns about this failure for the other
eval variables.

### Aborted is not failed

The exit code cannot carry the difference, because Turbo reduces it to 1. The output
directory carries it instead:

| Outcome        | Exit | Files written                                 | Means                                                                 |
| -------------- | ---- | --------------------------------------------- | --------------------------------------------------------------------- |
| passed         | 0    | `eval-report.json`, `.xml`, `eval-summary.md` | —                                                                     |
| graded failure | 1    | `eval-report.json`, `.xml`, `eval-summary.md` | a trial failed a grader; on replay, a real change                     |
| aborted        | 1    | `eval-abort.json`, `eval-summary.md`          | stale cassette, axis refusal, model call during replay, quota, stores |

`main().catch` (`run-eval.ts:206-212`) writes both files before it exits. The summary
starts with `## Eval — aborted` and gives the error's name and message. For a
`CassetteMissError` the message already contains the recorded-versus-actual diff, and the
summary adds the re-record command. It also lists the trials that completed before the
abort. `run-eval.ts:97-106` already receives each one through `onTrial`, so they only need
to be kept in an array. On a live run with a limited quota, a run that dies on its last
call should not discard the trials that finished before it. `eval-report.json` is
**not** written on abort. Its presence is the signal that the run completed, and a reader
such as P1-D can depend on that without parsing anything.

`IO_RETRY.retryOn` also refuses a `CassetteMissError`. Whether it matches the class, the
`name`, or a `retryable: false` marker is an implementation choice, as long as the graph
code does not have to import the cassette package.

### The 429, classified rather than retried

```ts
export type RateLimit = 'daily-quota' | 'unclassified';

/** From google.rpc error details: a QuotaFailure violation whose quotaId names a per-day quota. */
export function classifyRateLimit(error: unknown): RateLimit | undefined;
```

- **Chat path.** The two `ChatGoogleGenerativeAI` constructions (`runs.service.ts:201-202`)
  get an `onFailedAttempt` that throws on a `daily-quota` 429 and otherwise behaves like
  the default handler. Constructor params reach `new AsyncCaller(params)`
  (`@langchain/core` `dist/language_models/base.js:186`). A daily quota then costs one
  request instead of seven, and a transient 429 keeps the six client retries it has today.
- **Embed path.** `EmbeddingRequestError` keeps the parsed error details it currently
  discards into its message string (`gemini-embedder.ts:43-46`), so the same classifier
  can read them.
- **`IO_RETRY` is not changed for 429.** It stays terminal. On the chat path that is
  already correct, and on the embed path no transient 429 has been observed (see Non-goals).
- **The abort summary names the cause.** "Daily `generateContent` quota exhausted after N
  completed trials" is something a reader can act on. The current fatal log line is not.

## Acceptance criteria

Each criterion says which axis verifies it. "Stubbed transport" means `fetch` is replaced
and no request leaves the process.

- [x] `agent-eval.yml` has a `replay` job that runs on `pull_request`, `push` to `main` and
      the schedule, with Postgres and Neo4j service containers,
      `EVAL_CASSETTE_MODE=replay`, and no reference to `secrets.GOOGLE_API_KEY`. **Model
      `replay` / memory `live`:** its run on the pull request that adds it runs one trial of
      each task, passes every grader, and shows the cassette set's `recordedAt` and `gitSha`
      in the job summary. Run 36264081160, job `eval-replay`: `eval.done` logged
      `"axes":"model=replay memory=live","passRate":1,"tasksRun":2,"tasksSkipped":[]`, and
      the uploaded `eval-summary.md` reads "Replayed from 2 cassette(s) recorded
      `2026-09-11T01:48:09.269Z` at `021c6f2…`".
- [x] That run reports no request to `generativelanguage.googleapis.com`. This is the
      existing runtime watcher, not a new assertion. **Model `replay` / memory `live`.**
      The job log has no `eval.replay.live-call` line, and a reached request now aborts the
      run before any report is written, so the uploaded `eval-report.json` is itself the
      evidence.
- [x] `EVAL_EXPECT_AXES` makes the runner refuse before the Nest context is built when the
      detected axes differ, with a message naming both sets of axes. It is declared on
      `turbo.json`'s `eval` task. Unit-tested for a match and a mismatch, and run locally
      as `GOOGLE_API_KEY= EVAL_EXPECT_AXES='model=live memory=live' yarn eval`, which must
      refuse without resetting a store. **Model `stub`, on purpose:** the refusal is what is
      being tested, and no model call is made. `axes.test.ts` › `assertExpectedAxes`; the
      local run exited 1 with the message
      `expected model=live memory=live, detected model=stub memory=live`, and logged no
      `memory.postgres.ready` and no `run.traced.start` line.
- [x] A replay against a stale cassette writes `eval-abort.json` and an `eval-summary.md`
      naming `CassetteMissError`, the diff and the re-record command. It writes no
      `eval-report.json` and exits non-zero. **Model `replay` / memory `live`**, using the
      hash-flip probe from the Problem section. Also run once in CI on a throwaway branch:
      the job goes red and its summary reads `aborted`. Locally, against empty containers:
      exit 1, the directory held `eval-abort.json` and `eval-summary.md` only. In CI, run
      36264380982 on a probe commit pushed to this branch and then dropped (the only branch
      this work was allowed to push): `eval-replay` failed, and its artifact held the same
      two files, the summary headed `## Eval — aborted`.
- [x] A graded failure still writes all three reports and exits 1. The existing behaviour is
      asserted by a runner test, and that test also asserts that `eval-abort.json` is absent.
      `run-suite.test.ts` › "writes all three reports for a graded failure". Also run:
      `retrievedContextMinLength` raised to 99 in the task file, replayed, exit 1, three
      reports, 50%, no abort file.
- [x] An aborted run's `eval-abort.json` lists the trials that completed before the abort.
      Unit-tested with a harness whose second `run` throws. `run-suite.test.ts` › "writes an
      abort, not a report, when the second run throws". The probe on `tool-use-001`, the
      second task, listed `memory-recall-001` trial 1 as passed.
- [x] `IO_RETRY` does not retry a `CassetteMissError`. Unit-tested, and the probe's log
      shows one attempt where it currently shows three. `graph.test.ts` › "does not retry a
      cassette miss", which fails with `expected 3 to be 1` against the old policy. Both the
      local probes and CI run 36264380982 logged no `Retrying task "plan"` line; the old
      policy logged two.
- [x] **Stubbed transport:** a chat `invoke` answered with a 429 whose details carry a
      per-day `QuotaFailure` makes **one** request. One answered with a 429 without those
      details still makes seven, which is unchanged. The embed path makes one request in
      both cases. Both paths surface `classifyRateLimit`'s answer in the abort summary.
      `rate-limit.test.ts`, with a fake key and `fetch` stubbed: 1, 7 (fake timers) and 1,
      1, and each case asserts the rendered abort summary's `Cause` line.
- [ ] **Model `live` / memory `live`:** the classifier matches a real free-tier 429. The
      criterion above uses a synthetic body. Verified by one dispatch of the live job at
      `trials=3` (twenty-four calls against twenty) on a day nobody needs the key. The run
      must end `aborted` with `daily-quota` as the cause, list the trials that completed,
      and include the real `errorDetails` in the abort artifact. If the body has a
      different shape, this criterion stays unchecked and the classifier is fixed against
      the captured body. If no repository secret exists when this ships, the dispatch may
      be replaced by the same run made locally with the developer key, stated as such.
      **Not run.** It spends a day's quota, so the owner schedules it; it stays with P1-C.
- [x] The `live` job runs only on `schedule` and `workflow_dispatch`, is in one concurrency
      group, reads the key from `secrets.GOOGLE_API_KEY`, and sets
      `EVAL_EXPECT_AXES=model=live memory=live`. **With no secret configured**, the job is
      skipped by a condition on a preceding job's output (the `secrets` context is not
      readable in a job-level `if`), so the run list shows it as skipped rather than
      passed, and the replay job's summary says the live tier did not run for want of the
      secret. Dispatch run 36264269743: `eval-live-gate` success, `eval-live` skipped,
      `eval-replay` success with `HAS_KEY: false` and `EVENT: workflow_dispatch` in its
      summary step, the branch that writes "Live tier: did not run. There is no
      `GOOGLE_API_KEY` repository secret".
- [ ] **With a secret configured but the run on any other axis**, the `live` job fails before
      any trial with the axis-expectation message, and never goes green on the stub axis.
      Split from the criterion above, because it needs a repository secret, and there is
      none. The refusal itself is verified locally (the third criterion). **Passes to
      P1-E**, which takes it by name.
- [ ] **Model `live` / memory `live`, in CI:** with the secret present, one nightly run
      runs both tasks, skips neither, and uploads the three reports and the recorded
      cassettes. This closes the criterion P1-G handed over (see below). It needs a
      repository secret, which only the owner can add (decision 1); if none exists when this
      ships, the criterion stays unchecked and passes to **P1-E**, whose canary needs the
      same secret. **No secret exists; passes to P1-E.**
- [x] `memory-core`'s `test:eval` is gone. `grep -rn 'test:eval'` over `.github/`, every
      `package.json` and `turbo.json` returns nothing. `e2e.yml:39` sets
      `REQUIRE_INTEGRATION_ENV: '1'`, and its run on this pull request still reports
      `Test Files 5 passed (5)` from `@repo/memory-core`. Run 36264081118, job `e2e`. The
      flag also had to be declared on `test:integration` in `turbo.json`; see below.
- [x] `scripts/seed-eval-fixtures.mjs` and `agent-eval.yml`'s seed step are deleted. The
      comments that mention the script are updated: `agent-harness.ts:101-103`,
      `eval-harness/README.md:50` and `:100`, `eval-harness/src/outcome.ts:9`,
      `eval-harness/src/graders/code.ts:42`, `eval-harness/src/dataset.ts:94`,
      `memory-core/src/migrate.ts:22` and `memory-core/src/inspect/run-inspector.ts:34`.
      Outside `docs/prd/`, no tracked file names the script.
- [x] Documentation this change makes false is corrected in the same pull request:
      `.context/conventions.md:37-38`, `:62-65`, `:104` and the `Eval` row;
      `packages/eval-harness/README.md:26-29` and `:160`, and `:129-132` in the same file,
      which still says `tool-use-001` has never run live (untrue since P1-G);
      `packages/memory-core/test/integration-env.ts:15`; the example in
      `.agents/prd-author.md:17`; and `docs/STATUS.md` rows 17 and 18. Those rows should
      name the tier that now runs each capability, and fix the `runs.service.ts:190`
      citation, which is `:264` at HEAD. It is `:286` after this change, which adds
      `createGeminiChat` above it. The root `README.md` said the same thing in two places
      and is corrected too.

**On P1-G's handed-over criterion.** P1-G left unchecked "On model `live` / memory
`live`, both tasks run and neither is skipped", and gave it to P1-C. As written, P1-B's
recording run on 2026-09-10 already satisfied it: one trial of each task on model `live` /
memory `live`, both of them run, and both passing (P1-B, the fourth criterion). P1-G's own
text makes clear that what it had in mind was the 5×2 live suite. No criterion anywhere
states that goal. A shipped PRD is not edited, so the discrepancy is recorded here. The
nightly criterion above closes the literal criterion in CI. The 5×2 live pass rate is open
question 1, and it is not claimed.

## What shipped, and where it diverged from the design

Measured 2026-09-26. Every run below made no model call.

| Run                                          | Where                    | Result                                         |
| -------------------------------------------- | ------------------------ | ---------------------------------------------- |
| replay, pull request                         | CI 36264081160           | green, 1 trial × 2 tasks, every grader passed  |
| replay + gate, dispatch, no secret           | CI 36264269743           | green; `eval-live` skipped, not passed         |
| replay, stale cassette (probe, then dropped) | CI 36264380982           | red; abort artifact, summary `aborted`         |
| replay, stale cassette on each task          | local, empty containers  | exit 1; abort lists 0 and 1 completed trials   |
| replay, grader threshold raised              | local                    | exit 1; three reports, 50%, no abort file      |
| `EVAL_EXPECT_AXES` mismatch                  | local, `GOOGLE_API_KEY=` | exit 1 before the Nest context; no store touch |

Where the build is not what the Design section describes:

- **`REQUIRE_INTEGRATION_ENV` had to be declared on `test:integration`.** The Scope said the
  flag "moves onto `e2e.yml:39`, so nothing it guaranteed is lost". Moved alone, it would
  have been lost: the alias set it inside the script's own command, where Turbo never
  looks, and a job-level variable is stripped by strict env mode unless the task declares
  it. Probed: with the declaration removed, the flag set and no stores exported,
  `yarn turbo test:integration` reported 5 files skipped and exited 0. With it, the run
  fails naming both variables. `.context/conventions.md` now says so under the Turbo rule.
- **`EVAL_OUTPUT_DIR` is set by a step, not in the job's `env`.** The `runner` context is
  not available in job-level `env`, so `${{ runner.temp }}` there does not evaluate. The
  first step of each job writes `$RUNNER_TEMP/eval-<tier>` to `$GITHUB_ENV`, which keeps
  the path absolute.
- **The key is on the `yarn eval` step, not the live job's `env`.** `yarn install` runs
  package build scripts, and none of them needs it.
- **Names follow the PRDs accepted after this one.** P1-D and P1-E were accepted while this
  was in flight and name P1-C's pieces: P1-D makes `eval-replay` a required check and
  forbids that job a condition that could skip it; P1-E's sketch reads `needs.gate.outputs.has_key`
  and downloads one `eval-live` artifact. The jobs are `gate` (`eval-live-gate`),
  `replay` (`eval-replay`) and `live` (`eval-live`), and the recorded cassettes travel
  inside `eval-live` rather than as a second artifact.
- **The replay job needs the gate, and carries `if: ${{ !cancelled() }}`.** Its summary
  has to say whether the live tier had a key, and it cannot read the secret itself. A
  plain `needs` would let a failed gate skip it, and a skipped job satisfies a required
  check, which is the failure P1-D's rule exists for. The condition is there to prevent
  that skip, not to add one.
- **The live job deletes the committed cassettes before it records.** A trial that throws
  writes no cassette, and a committed file left in its place would be indistinguishable in
  the artifact from a fresh recording. That also answers the risk this PRD left open: the
  recorder does not write a partial cassette for the trial that aborted
  (`agent-harness.ts`, `close(completed)`), and it does write every trial that completed
  before it.
- **The abort is written by `runAndReport` (`run-suite.ts`), not by `main().catch`.** The
  whole run is its body, so an error anywhere after the output directory is resolved — a
  mode typo, an axis refusal, a store that will not connect — is written down with
  whatever axes, provenance and trials were known. The directory is cleared of all four
  files first, so a report from an earlier local run can never sit beside an abort. The
  replay watcher's check moved ahead of report writing for the same rule; P1-D's criterion
  about "a report written before the watcher throws" describes a state this runner no
  longer produces. The abort's error is passed through `@repo/agent-cassette`'s
  `redactDeep` before it is written, because the file is an uploaded artifact.
- **The root `package.json` lost its two workspace dependencies.** `@repo/eval-harness`
  and `@repo/memory-core` were there only so the seed script could import them.
- **The Neo4j service containers gained a health check** (`cypher-shell … 'RETURN 1'`), so
  a job does not start against a store that is still booting.

The hash-flip probe's diff shows no `-` or `+` lines: the probe changes a recorded hash and
leaves the recorded request alone, so the two requests are identical. A prompt edit, the
case the summary is written for, shows the changed lines.

## Risks and open questions

**Decided at review, 2026-09-26.** The three questions the draft left open, and the answer
each got. The draft's reasoning is kept under each so the choice can be re-examined.

1. **Is a `GOOGLE_API_KEY` repository secret added, and from which Google Cloud project?**
   _Decided:_ that is the owner's call and not this PRD's, so the design does not wait on
   it. The live job is written and conditional on the secret; the two criteria that need
   it pass to P1-E if it is still absent at ship time. A separate project is recommended
   so that CI does not spend the developer's daily twenty.
   There is no secret today. Without one, the live tier cannot pass two of the criteria
   above, and the tier ADR 0005 assigns to this PRD exists only as a job that fails every
   night. If the key comes from the same project as the developer key in `.env`, the
   nightly's eight calls are taken from the same daily twenty. A separate project gives CI
   its own twenty. A billed key is the only way the 5×2 suite (about forty calls) runs
   within one day. If the answer is "free tier, separate project", the nightly runs one
   trial per task and the 5×2 rate goes to P1-D as stated in the Non-goals.
2. **With no key, should the nightly go red, or skip with a visible notice?** _Decided:_
   skip, but as a job GitHub marks _skipped_, never as a green job that did nothing, and
   with the notice in the replay job's summary. A key that is present and produces the
   wrong axes still goes red, which is the failure the precedent exists for. The design
   makes it go red, following the `REQUIRE_INTEGRATION_ENV` precedent: a scheduled job
   that is green without measuring anything is the failure that file was written to stop.
   The cost is a red nightly until question 1 is answered, and a red nightly that people
   learn to ignore is its own failure. The alternative is a job that ends green with a
   summary saying `live tier not run: no GOOGLE_API_KEY secret`. That is honest in the
   summary but misleading in the list of runs.
3. **Should the 429 work stay here?** _Decided:_ it stays. P1-A handed it here, and a
   split would create a PRD whose only verification is the same quota-exhausting run. The Problem section shows that the defect P1-A handed
   over mostly concerns the daily quota and the two retry layers, not `IO_RETRY`. It
   touches production code (`runs.service.ts`, `gemini-embedder.ts`), and the live half of
   its verification uses up one day's quota. Moving it to its own PRD would keep P1-C's
   changes to the workflow and the runner. Keeping it here means the first quota
   exhaustion in CI already produces a readable abort.

**Risks.**

- **Sizing.** `M` is the size of the known work. The workflow has never run: GitHub Actions
  only runs it once it is pushed, so its first execution happens on the pull request that
  adds it. The 429 classifier is built from Google's documented error model, not from a
  response observed in this repository. Following the rule P0-A learned the hard way, both
  of those should be treated as having an unknown number of defects behind them. If the
  captured 429 body does not match, the classifier work grows by one cycle. It does not
  grow the rest of this PRD.
- **Every prompt-change pull request goes red on the replay tier until its cassettes are
  re-recorded.** This is P1-B's design working as intended. A contributor without a key
  cannot re-record. That does not block a merge until P1-D makes the check required, and
  P1-D inherits the question when it does.
- **It is unknown whether a rejected 429 counts against the daily quota.** If it does, the
  chat client's seven attempts on an exhausted quota cost more than time. The classifier
  reduces that to one attempt either way.
- **The service images use floating tags** (`pgvector/pgvector:pg16`, `neo4j:5-community`).
  A store upgrade that changes the order of rows would change a prompt and therefore a
  cassette hash. Both readers break ties on the content hash (P1-B), which covers ties but
  not every possible change in order. A replay miss that appears on a pull request that
  does not touch prompts should be investigated as this.
- **It is not known whether the recorder writes partial cassettes when a run aborts.** If it
  does not, a live run that dies on a 429 uploads no decisions. The abort artifact still
  lists the trials that completed.
- **Deleting the seed script removes a local tool.** No document tells anyone to run it,
  and the only caller is the workflow step being removed. If someone depends on it, bring
  it back as a `memory-core` script rather than as a workflow step.

## References

- ADR 0005, `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md`: the
  replay/live split this pipeline puts into CI, and the live tier assigned to this PRD.
- `docs/prd/P1-B-agent-cassette.md`: the replay mode, the per-trial cost (three and five
  `generateContent` calls), and the stale-versus-regression risk this PRD closes.
- `docs/prd/P1-G-task-axis-requirements.md`: the criterion handed to this PRD.
- GitHub Actions job summaries (`$GITHUB_STEP_SUMMARY`):
  https://docs.github.com/en/actions/using-workflows/workflow-commands-for-github-actions#adding-a-job-summary
- Secrets and workflows triggered from forks:
  https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions
- Gemini API rate limits (requests per minute and per day, by tier):
  https://ai.google.dev/gemini-api/docs/rate-limits
- `google.rpc` error details (`RetryInfo`, `QuotaFailure`), which the classifier reads:
  https://cloud.google.com/apis/design/errors#error_details
