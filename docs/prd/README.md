# Product Requirement Docs

## Where things stand

_Last updated 2026-10-08. If this section is more than a few weeks stale, trust the code
over it and update it._

**Sixteen PRDs are shipped and the system they describe is running.** The service answers
`POST /runs` and `POST /runs/stream`; `memory-core` is constructed by the app rather than
sitting beside it; the graph compiles with a checkpointer and a retry policy on every node
that performs I/O; and `packages/eval-harness` measures the result. Verified against live
stores from an empty database: one run leaves episodic rows, `:Concept` and `:Fact` nodes,
`semantic_facts` rows and checkpoints under the runId its own response returned.

**`docs/STATUS.md` is the authority on any capability sentence, including the ones above.**
Thirty rows, each with a status and evidence cited by name — twenty-five `implemented`,
one `planned`, three `stubbed`, one `removed`, none `broken`. The rule that keeps it true is in
`.context/conventions.md`: a change that moves a row moves it there in the same pull
request. `yarn lint:docs` fails CI when a PRD's status disagrees with its row below.

**The agent is measured, but not yet gated.** `yarn eval` runs n trials per task and reports
`pass@k` and `pass^k`, and every number names the axes that produced it. Measured
2026-08-29 — model `stub` / memory `live`, 5 trials x 2 tasks: 50%, with `memory-recall-001`
at 5/5 and `tool-use-001` at 0/5. That 0/5 is the stub axis's ceiling and not the agent's
score: `runs.service.ts:286` returns `null` from `selectTool` for every input, so a task
graded on making a tool call cannot pass there. On model `live` / memory `live`, one trial of
`memory-recall-001` passed all eleven graders, and one trial of `tool-use-001` on 2026-09-10
passed on three `web-search` selections with well-formed queries. One trial is not a pass
rate, and a 5x2 live suite needs about forty `generateContent` calls against a 20-request
free-tier quota, which is why it has not been run. **[P1-G](P1-G-task-axis-requirements.md)
has shipped**, so `tool-use-001` declares the axes it is meaningful on and the stub axis
skips it rather than averaging the agent together with the fixture: the same command on the
same axis now reports 100% over 5 trials x 1 task, re-measured 2026-09-10. That is a
denominator change and not an improvement, which is why both numbers stay in
`docs/STATUS.md` row 17 and why the skipped task is printed beside the rate in all three
reports. It now runs in CI on every pull request, on the replay axis (P1-C, below). What
none of this is yet is a merge gate — see P1-D below for what blocks and what is missing.

**Memory and model are independent axes, and neither falls back.** `GOOGLE_API_KEY` selects
the model half; `DATABASE_URL` and `NEO4J_URI` select the memory half. Configured but
unreachable exits 1 in about a second naming the cause. Selecting no-op writers because a
configured database is missing was the defect P2-A existed to remove, and it is not a
reachable runtime path. A clone with no `.env` still serves both quickstart curls.

**[P1-B](P1-B-agent-cassette.md) has shipped**, tracked in [#45](https://github.com/maxmillienjr/agent-native-monorepo/issues/45).
It records the model's decisions at the `ModelDeps` seam and replays them, which is what makes
a pull-request evaluation tier affordable — without it P1-C has a live tier nobody leaves
switched on, or a stub tier that measures nothing. Its determinism prerequisite landed first:
both semantic retrievers break a tied score on the content hash, because an untied order
reaches `plan`'s prompt and a cassette is keyed on that prompt. The set was recorded after
that fix, on 2026-09-10 at `021c6f2` — one trial of each task, on model `live` / memory
`live`, for eight `generateContent` calls — and that recording run passed every grader on
both tasks. `EVAL_CASSETTE_MODE=replay yarn eval` reproduces all twenty-one grader results in
two seconds against the recording's eighty-three, makes no request to
`generativelanguage.googleapis.com`, and two consecutive replays produce an identical report.
Read the number for what it is: a replayed `pass^k` is a frozen sample of that recording, it
cannot catch the model getting worse (P1-E) or the client breaking (ADR 0005 names that
defect class), and a task runs at most as many trials as it has cassettes so that one
recording is never averaged with itself. It is now the pull-request tier P1-C runs.

**[P1-C](P1-C-tiered-eval-pipeline.md) has shipped**, tracked in
[#56](https://github.com/maxmillienjr/agent-native-monorepo/issues/56), with its pull
request merged. `agent-eval.yml` no longer runs the memory integration suite: its
`eval-replay` job runs the agent on every pull request, every push to `main` and nightly,
against the committed cassettes and two service containers, with no key. Its `eval-live`
job runs nightly and on dispatch only when a `GOOGLE_API_KEY` repository secret exists;
without one it shows as skipped, never passed, and the replay summary says why. The owner
added the secret on 2026-10-08. Each
job declares `EVAL_EXPECT_AXES`, so a job that lost its key or its mode refuses before a
trial. A run that cannot complete now writes `eval-abort.json` and a summary headed
`aborted`, with the trials that finished, and never `eval-report.json`. That is how a stale
cassette differs from a failed grader, since Turbo reduces both exit codes to 1. A
daily-quota 429 is terminal on both model paths, so the chat client makes one request
instead of seven, and the abort names it. The first dispatch with the secret proved that
against a real free-tier 429 (run 37812971653): one request, `daily-quota`, `aborted`, the
real `errorDetails` in the artifact. The two criteria that need a nightly run with the
secret present pass to P1-E, by name.

**[P1-D](P1-D-regression-gate.md) is in progress**, tracked in
[#76](https://github.com/maxmillienjr/agent-native-monorepo/issues/76). `eval-replay` now
exits on a verdict, not a pass rate: every one of the 21 replayed grader results is compared
exactly with a committed `baselines/replay.json`, and any difference blocks, an improvement
included, as does an abort. The probe that used to exit 0 at 100% (a task skipped, an
assertion deleted) now names 11 `missing` cells, and a known failure can be committed.
`EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval` accepts a change with no key. The
nightly pools live tallies on an orphan `eval-history` branch against a committed reference
at δ = 0.20, and will read `insufficient-evidence` for weeks. It has not run, because there
is no secret. A local live run on 2026-10-08 did exercise it: `EVAL_GATE=live` exited 0 on
verdict `incomparable` and wrote a tally that validates against `LiveTallySchema`.
**Nothing blocks a merge until the owner applies
`.github/rulesets/main.json`**, which requires `eval-replay`; `yarn lint:docs` keeps its
check names equal to real jobs.

**[P1-E](P1-E-model-drift-canary.md) is in progress**, tracked in
[#86](https://github.com/maxmillienjr/agent-native-monorepo/issues/86). `yarn canary` asks
the API what serves the pinned ids and the floating alias: `models.get` on all three, one
direct `generateContent` per chat id for the `modelVersion` the LangChain client drops, and
21 embeddings compared bit for bit with the committed cassettes' vectors. A pinned change
exits 1, and the way back to green is a committed baseline update. Measured locally on
2026-10-08, all 21 vectors were identical to the 2026-09-11 recording. The `eval-canary` and
`eval-compare` jobs run nightly under the `GOOGLE_API_KEY` secret, which was added on
2026-10-08. Every report now names its chat and embedding ids, and `EVAL_CHAT_MODEL` runs the
suite on the alias as a dispatch-only migration comparison. **It stays in progress until a
scheduled run proves the CI criteria.** That first run will be red on the pinned chat probe
until the owner commits the two `modelVersion` strings, because no `generateContent` call
was spent to fill that baseline.

**[P1-F](P1-F-cost-and-step-budgets.md) has shipped**, tracked in
[#85](https://github.com/maxmillienjr/agent-native-monorepo/issues/85). Each task file now
sets per-trial ceilings on input tokens, output tokens and model calls, checked against the
trial's spans beside the graders: a breach fails the run and leaves the pass rate alone.
`RunResponse.tokenCounts` is every chat call's usage, thinking included, where it was the
plan call's: 1730/6442 tokens against 58/1563 on one live `memory-recall-001` trial. Every
report prints usage and a list-price cost, and live latency, none of them asserted. That
needed cassette format 2, and both tasks were re-recorded on 2026-10-08 for eight calls, with
the replay baseline regenerated after ADR 0009 removed the third. Budgets are set on today's
`act` loop, repeats included; P4-C's fix tightens them. The one open criterion, a live report
showing every budget within, is the nightly's, which P1-E takes.

**[P2-B](P2-B-retrieval-ablation.md) has shipped**, tracked in
[#57](https://github.com/maxmillienjr/agent-native-monorepo/issues/57), and the answer to
ADR 0002 is no. `yarn eval:retrieval` scored vector, graph and hybrid on 200 queries labelled
before any vector existed. It replays recorded embeddings with no key, and two runs from
empty stores are byte-identical. On the deployed path `hybrid` equals `vector` at 0.940
Recall@10, because the seed linker produced no id the graph holds on any query. With perfect
seeds `hybrid` is 0.145 below `vector`, interval [−0.195, −0.095]: the graph ranks only by
hop distance, and RRF weighs that hash-ordered list as heavily as the vector list. The
pre-registered rule selects "neither does", and a blind model adjudication of the 3,029
pooled candidates added one label and selects the same row. ADR 0009 records what followed,
in the next paragraph.

**[ADR 0009](../adr/0009-the-second-store-after-the-retrieval-ablation.md) is accepted:
retrieval is vector-only.** The owner chose option B on 2026-10-08, and it supersedes
ADR 0002. `VectorRetrievalFacade` returns the session-scoped pgvector search and reads no
graph; `retrieve` derives no seed ids, and `hopDepth` left the request contract because nothing
reads it. `reflect` still writes concepts, relationships and `:Fact` nodes, and
`CypherNeo4jReader` stays in `memory-core`, unwired, for a role nobody has measured, so
`docs/STATUS.md` row 15 is `stubbed`. The seed linker and `rrfMerge` moved into the
ablation, so `yarn eval:retrieval` still reproduces the measurement that decided it, and a
re-run on 2026-10-08 matched every committed number but the latencies. `graph-recall-001`
was deleted with its cassette and its four baseline cells, rather than converted, because
conversion needed a live re-record; the other two cassettes replay unchanged and the gate
reads `match`. P4-B was amended: the graph half of its cross-session leak is closed on the
read side, its graph session filter (M1) moves to P2-D, and M2 and M3 stay. P2-D owns the
rest, in the next paragraph.

**[P2-D](P2-D-graph-explanation-or-removal.md) is in progress**, tracked in
[#100](https://github.com/maxmillienjr/agent-native-monorepo/issues/100), and stage 1 is
`good`. Gold concept paths for P2-B's 201 pairs were committed before any explainer code.
M1 now covers edges: every graph write carries its session, and both graph reads require
one. `yarn eval:explanation` runs with no key and no embeddings. On the relational stratum,
path recall@3 is 1.000 and precision@3 is 0.637 [0.553, 0.723], and two runs from empty
stores are identical. The pass is weak evidence, as the PRD said it would be. Recall is all
but guaranteed by how `reflect` links facts, the label linker equals the oracle, and the
extractor is the corpus. The PRD's predicted failure appeared in only 12 of 50 pairs.
[ADR 0012](../adr/0012-the-graphs-explanation-role-stage-one.md), proposed, records that
the rule selects no outcome yet and recommends stage 2 as pre-registered. Stage 2 is 76
`generateContent` calls on `plan`'s answers, and its code exists with none of them spent:
the prompts are pinned to `planNode`'s, the graders apply the rule, and the answer file is
recorded resumably and replayed with no key. A dry run on a fake model was killed mid-run,
resumed, and stopped by a per-day 429, and it ended with 76 answers, none asked twice once
recorded. What remains is the calls, eight a day for ten days, on the schedule in the PRD.
Neither command runs in CI, by decision: P2-E reproduces or archives both, depending on the
outcome.

**[P2-C](P2-C-otel-genai-semantics.md) has shipped**, tracked in
[#74](https://github.com/maxmillienjr/agent-native-monorepo/issues/74). A run is now one
trace under an `invoke_agent` root instead of seven single-span traces. Every model call,
embedding and tool execution has its own span in the OpenTelemetry GenAI vocabulary, named
from one pinned commit of a conventions repository that has no release. Usage is recorded on
all three chat seams, where it used to be recorded on one. On one live trial of
`memory-recall-001` the run's model calls cost 2586 input and 9664 output tokens, 4629 of
them thought tokens, against the 58 and 1197 `RunResponse.tokenCounts` reports. P1-F owns
deciding what the run total is. The replay axis opens the same spans from the cassette,
marked `agent_native.replayed`. Content capture is off, with no switch: an attribute
allowlist holds every span in a unit test and in every `yarn eval`, and four
model-extracted memory attributes came off. `EvalHarness` emits a `gen_ai.evaluation.result`
log record per grader result, parented to the run it judged, and `Transcript.spans` carries
each trial's trace into `eval-report.json`.

**[P4-A](P4-A-controls-as-code.md) has shipped**, tracked in
[#63](https://github.com/maxmillienjr/agent-native-monorepo/issues/63).
`governance/controls.yaml` catalogues eighteen controls against NIST AI RMF 1.0, NIST AI
600-1, ISO/IEC 42001 Annex A, the two OWASP lists and 45 CFR §164.312: nine
`implemented`, one `procedural`, eight `planned`, none excluded. `yarn lint:docs` resolves
every piece of evidence by name, checks each `planned` row against the PRD that owns it, and
fails when the generated `governance/CONTROLS.md` is stale. `docs/STATUS.md` moved onto the
same resolver. It now has nineteen rows — fifteen `implemented`, two `stubbed`, one
`planned`, one `removed` — each cited as `path#name` rather than by line, and a `path:NN`
citation fails the lint. Rows 3 and 11 were still citing lines that no longer held what
they named when they migrated. A green check
means the evidence exists, not that it is sufficient, and the matrix says so in its header.

**[P5-C](P5-C-langgraph-1x.md) has shipped**, tracked in [#61](https://github.com/maxmillienjr/agent-native-monorepo/issues/61).
The service now runs on `@langchain/langgraph@1.4.18` and `@langchain/core@1.2.12`. Every
offline gate passes, the replay is identical to the one at 0.x, and checkpoints resume across
the upgrade in both directions. The upgrade changed one behaviour. At `core` 1.x, LangChain's
default retry handler stops on any 429 whose message mentions quota or billing, and every
Gemini 429 does. P1-C's `stopOnDailyQuota` handed non-daily 429s to that default, so they
became terminal. It now retries them itself, and the client waits out a per-minute 429
again, as it did at 0.x. A live run at the 1.x head on 2026-10-08 passed all 21 graders on
both tasks, with a non-empty plan in each transcript, for 8 `generateContent` calls.

**[P3-A](P3-A-clinician-gate.md) has shipped**, tracked in
[#75](https://github.com/maxmillienjr/agent-native-monorepo/issues/75). ADR 0003's rule
that the agent must not make an adverse determination now has a mechanism.
`@repo/determination` types the agent's output as an approval or a referral, and the one
constructor for a denial needs a clinician's attestation. That constructor sits behind a
`./clinician` subpath, which a lint rule bars from the graph. Type tests fail
`yarn turbo typecheck` if an unattested denial compiles, and every run response is now
parsed strictly on the way out. On review, the chat graph's `disposition` channel moved to
P3-D, whose prior-authorization graph is now the producer, so `docs/STATUS.md` row 20 is
`implemented`.
LangGraph still does not check what a node returns, at 0.4.10 or at 1.4.18. Implementing
this found that the `Node` alias misses an undeclared key returned beside a declared one;
an explicit return type catches it. CTL-HUM-01 is `implemented`, with its title narrowed to
what is enforced.

**[P3-D](P3-D-payer-dataset-fhir-prior-auth.md) is in progress**, tracked in
[#84](https://github.com/maxmillienjr/agent-native-monorepo/issues/84), with one step left:
the live recording. The service answers `POST /fhir/Claim/$submit` and `GET /fhir/metadata`.
It runs a second graph (intake, lookup, assess, dispose) inline and returns a
`ClaimResponse`: `complete` for an automated approval, `queued` for a referral. The surface is
shaped after PAS 2.2.1 and does not conform to it, because ADR 0008 keeps X12 code values out
of the repository. The model reports a finding per criterion. Code decides, and approves only
when every criterion is met with a citation into the member's own bundle. The deadline counts
from the server's receipt. The dataset is one fictional payer, four DME policies coded in
HCPCS Level II, and 24 labelled requests in six strata. The licence research that had to come
first found ICD-10-CM public domain on CDC's conditions, and found HCPCS Level II's D range to
be the ADA's CDT. ADR 0008 records both and narrows ADR 0003 without superseding it.
`yarn lint:docs` now runs a CPT and synthetic-data detector, so CTL-DATA-01 is `implemented`
and its unprovable half is a procedural CTL-DATA-02. The HL7 validator found two problems in
the design. US Core rejects an NPI that fails its check digit, so the data holds no NPI at
all. And an unversioned profile resolved to US Core 7.0.0, so each profile names 6.1.0. After
those fixes, every bundle and every captured response validates against US Core 6.1.0, and the
only distance from PAS left is X12. The recording needs 20 `generateContent` calls, a full
free-tier day, so it is planned as two batches on two days. Until it is made, the agent's
accuracy on the labelled set is unmeasured, and STATUS row 26 says so.

**[P3-B](P3-B-audit-replay.md) has shipped**, tracked in
[#97](https://github.com/maxmillienjr/agent-native-monorepo/issues/97). A checkpoint history
turned out to be a run's trace, not its inputs: no request, no retried attempt, no commit,
no retrieval query. So every run on the configured memory axis, on both graphs, now leaves
a run record beside its checkpoints, with every decision at the cassette seam plus
`memory.retrieve`, appended as it resolves. `yarn audit:replay <runId>` re-executes the run
at its recorded commit from the record alone and compares every checkpoint. All nine match
on a stub run and on a trial served from the committed cassettes. An edited decision, a
deleted one, an added one or an edited checkpoint each exit 1, another commit exits 2, and
a replay writes nothing. The prior-authorization path fails closed with a 503 when its
record cannot be written. ADR 0007 records the design. A match proves the record complete,
not unaltered. P3-C has since added tamper evidence, and "Before real data" lists what a
real deployment owes.

**[P3-E](P3-E-clinician-review-queue.md) has shipped**, tracked in
[#98](https://github.com/maxmillienjr/agent-native-monorepo/issues/98). A pended request now
has somewhere to go. ADR 0010 keeps the case in a `prior_auth_cases` table above the graph
rather than in a thread paused by `interrupt()`, whose silent resume behaviours a re-run probe
found unchanged at LangGraph 1.4.18. `$submit` enqueues once P3-B's run record has closed, before it answers,
and answers 503 when it cannot. A clinician sees the queue in clock order and nothing else, and reads the model's
rationale on one case. The service accepts a determination only over an Ed25519 signature
that it verifies against `REVIEWER_REGISTRY` and cannot produce, from a credential the policy
lists, and only once per case. `POST /fhir/Claim/$inquire` returns each case's current
response, and an overdue sweep flags cases and never decides them. STATUS row 28 says that on
time means decided, not notified. P3-C has since added the ledger appends. P5-A still has to
add the authentication of `/review/*`. Appeals belong to P3-F.

**[P3-C](P3-C-decision-ledger.md) has shipped**, tracked in
[#108](https://github.com/maxmillienjr/agent-native-monorepo/issues/108). What the service
records can now be shown unchanged, up to the last anchor. `packages/decision-ledger` keeps a
hash chain of salted commitments. It holds every run on either graph, every recommendation
`$submit` returns and every clinician's signed determination. It is written as
`ledger_writer`, a role that can only select and insert, and ADR 0013 records why that made
it a package of its own. `ledger:verify` re-derives each run's digest from today's record and
checkpoints, so an edit to a checkpoint blob or a decision exits 1 naming the run. It also
checks every signature against reviewer keys that are themselves entries. A superuser in
replica mode can still rewrite the database, so `ledger:anchor` time-stamps the head with an
RFC 3161 authority through `openssl`. CI uses a local test authority. One real anchor against
FreeTSA verified, and a consistent rewrite under it failed on `message imprint mismatch`. A
rewrite after the last anchor goes unseen, which is the stated limit. The chat path fails
open and lists the run as uncommitted. `$submit` and the determination route fail closed,
which closes P3-E's ledger criterion. Anchoring on a schedule, a second authority and key
custody are a deployment's, and are listed in "Before real data". CTL-AUD-01 is
`implemented`, and STATUS rows 29 and 30 are new.

**Where the detail lives.** Each PRD carries its own risks, its divergences from the design
that was reviewed, and — where a shipped record turned out to be wrong — the correction that
followed. P2-A is the one to read first: it shipped, was reopened the same day when two of
its criteria proved to have been verified against a stub, and shipped again carrying a
post-ship correction section that explains both wrong ticks.

## How this works

- **This index is the source of truth for the backlog.** Every planned change lives here,
  whether or not it has a GitHub issue.
- **GitHub issues are the tracking layer, not the content layer.** An issue is opened only
  when work on a PRD actually starts; its body is a link plus acceptance criteria. This
  keeps the tracker a picture of momentum rather than a pile of stale intentions.
- **Tiers map to milestones.** They are thematic, not time-boxed.
- **Sub-issues decompose a PRD into tasks** — never a tier into PRDs. Tier→PRD is a
  taxonomy and lives here; PRD→task is a work breakdown and lives in GitHub.
- **Changes arrive as pull requests.** `git log -p docs/prd/<file>` is the record of how the
  thinking changed, which is the whole reason these are files and not issue bodies.

Status values: `draft` → `accepted` → `in-progress` → `shipped` → `superseded`.
Sizes: `S` ≈ 1–2 days, `M` ≈ 3–5 days, `L` ≈ 1–2 weeks.

## Tier 0 — Truth alignment

The repository documented capabilities it did not have, and did not run. Both are closed:
the service runs and CI proves it, and `docs/STATUS.md` records what every documented
capability is actually backed by. This tier is done — keeping the matrix true is now a
standing rule in `.context/conventions.md`, not a piece of work.

| ID                               | Title                                                 | Size | Status  |
| -------------------------------- | ----------------------------------------------------- | ---- | ------- |
| [P0-A](P0-A-make-it-run.md)      | Make the service run, and make CI unable to hide it   | S    | shipped |
| [P0-B](P0-B-reconcile-claims.md) | Reconcile documented claims with implemented behavior | M    | shipped |

## Tier 1 — Evaluation in CI

The repository's stated thesis. P1-A is shipped: `yarn eval` runs trials against the real
application context and reports `pass@k` and `pass^k` per axis. P1-C, in progress, runs it
from `.github/workflows/agent-eval.yml`: on replayed model decisions on every pull request,
and on the live model nightly once a repository secret exists. P1-D, in progress, gates
both on committed baselines. Nothing blocks a merge until the owner applies its ruleset.
P1-E, in progress, watches whether the model behind the pinned ids has changed. P1-F,
shipped, checks each task's tokens and model calls beside the pass rate.

| ID                                     | Title                                                         | Size | Status      |
| -------------------------------------- | ------------------------------------------------------------- | ---- | ----------- |
| [P1-A](P1-A-eval-harness.md)           | `packages/eval-harness` — evaluation as a first-class package | L    | shipped     |
| [P1-B](P1-B-agent-cassette.md)         | `packages/agent-cassette` — decision-level record and replay  | L    | shipped     |
| [P1-C](P1-C-tiered-eval-pipeline.md)   | Tiered evaluation pipeline replacing the nightly stub         | M    | shipped     |
| [P1-D](P1-D-regression-gate.md)        | Statistical regression gate against committed baselines       | L    | in-progress |
| [P1-E](P1-E-model-drift-canary.md)     | Model-drift canary against pinned and floating model ids      | M    | in-progress |
| [P1-F](P1-F-cost-and-step-budgets.md)  | Cost, latency, and step budgets as CI assertions              | M    | shipped     |
| [P1-G](P1-G-task-axis-requirements.md) | Task-level axis requirements for the evaluation suite         | S    | shipped     |

## Tier 2 — Make the architecture real

The three-tier memory model is instantiated and the graph is checkpointed. The hybrid
premise was measured by P2-B and did not hold, and ADR 0009 made retrieval vector-only. What
remains is the knowledge graph that `reflect` still writes: P2-D measures what it is for, or
removes it. The standard vocabulary for reporting either is in place: P2-C emits the
OpenTelemetry GenAI conventions.

| ID                                           | Title                                                                    | Size | Status      |
| -------------------------------------------- | ------------------------------------------------------------------------ | ---- | ----------- |
| [P2-A](P2-A-wire-memory-core.md)             | Wire memory-core into the service; add checkpointing and retry           | L    | shipped     |
| [P2-B](P2-B-retrieval-ablation.md)           | Hybrid retrieval evaluation and the graph/vector/hybrid ablation         | L    | shipped     |
| [P2-C](P2-C-otel-genai-semantics.md)         | OpenTelemetry GenAI semantics, including evaluation events               | L    | shipped     |
| [P2-D](P2-D-graph-explanation-or-removal.md) | Measure the graph's explanation role, or remove it (ADR 0009's fallback) | M    | in-progress |
| P2-E                                         | Act on P2-D's outcome: remove the graph, or wire its explanation         | M    | draft       |

## Tier 3 — Regulated-domain credibility

Optional vertical. Demonstrates that the chassis holds up under the constraints a payer or
provider actually operates under. Uses synthetic data only.

| ID                                            | Title                                                         | Size | Status      |
| --------------------------------------------- | ------------------------------------------------------------- | ---- | ----------- |
| [P3-A](P3-A-clinician-gate.md)                | Clinician-gate invariant enforced in the type system          | S    | shipped     |
| [P3-B](P3-B-audit-replay.md)                  | Deterministic replay for audit reconstruction                 | L    | shipped     |
| [P3-C](P3-C-decision-ledger.md)               | Hash-chained, tamper-evident decision ledger                  | L    | shipped     |
| [P3-D](P3-D-payer-dataset-fhir-prior-auth.md) | Synthetic payer dataset and FHIR prior-authorization surface  | L    | in-progress |
| [P3-E](P3-E-clinician-review-queue.md)        | Clinician review queue, `$inquire` and the decision clock     | M    | shipped     |
| [P3-F](P3-F-appeals-reconsideration.md)       | Appeals: reconsideration lifecycle for adverse determinations | M    | accepted    |

## Tier 4 — Governance and agent security as code

| ID                                        | Title                                                           | Size | Status   |
| ----------------------------------------- | --------------------------------------------------------------- | ---- | -------- |
| [P4-A](P4-A-controls-as-code.md)          | `governance/controls.yaml` and a CI check for unmapped controls | M    | shipped  |
| [P4-B](P4-B-memory-poisoning-red-team.md) | Memory-poisoning red team mapped to OWASP Agentic Top 10        | M    | accepted |
| [P4-C](P4-C-reversible-tool-registry.md)  | Reversibility-tiered tool registry with saga compensation       | M    | accepted |

## Tier 5 — Interoperability

| ID                              | Title                                            | Size | Status      |
| ------------------------------- | ------------------------------------------------ | ---- | ----------- |
| [P5-A](P5-A-a2a-server.md)      | Agent2Agent v1.0 server with a signed Agent Card | L    | in-progress |
| [P5-B](P5-B-adk-portability.md) | Agent Development Kit portability appendix       | S    | accepted    |
| [P5-C](P5-C-langgraph-1x.md)    | Upgrade to LangGraph 1.x                         | S    | shipped     |

## Sequencing

The dependency spine, not a schedule:

```
P0-A ──▶ P2-A ──▶ P1-A ──┬──▶ P1-B ──┬──▶ P1-C ──┬──▶ P1-D
                         │           │           ├──▶ P1-E
                         │           │           └──▶ P1-F
                         │           ├──▶ P2-B ──┬──▶ P4-B
                         │           │           └──▶ P2-D ──▶ P2-E
                         │           ├──▶ P2-C ──────▶ P1-F
                         │           ├──▶ P3-B ──────▶ P3-C
                         │           └──▶ P4-C
                         └──▶ P1-G

P3-A ──┬──▶ P3-C
       └──▶ P3-D ──▶ P3-E ──▶ P3-F

P5-A ──▶ P5-B
```

P2-A, P1-A and P1-B are all shipped, so everything hanging off them is unblocked —
including P2-B, whose ablation needs a working retrieval path, a harness to measure it
with, and P1-B's deterministic tie-breaking and float32 vector codec to make the
measurement reproducible from committed embeddings. It is drawn under P1-B because that is
the last of its three predecessors; it also depends on P2-A and P1-A directly.

P1-F appears twice because it needs two things: the pipeline P1-C builds, and the per-call
token usage P2-C puts on inference spans. It also depends on P1-A and P1-B directly — it
extends the harness's report and bumps the cassette format — and, like P2-B, is not drawn
a third time for them. P2-C hangs off P1-B rather than P1-A alone
because its replay-axis design reads the cassette's recorded usage. All three are shipped.

P1-E is drawn under P1-C, whose nightly live job it reads, but it also depends on P1-B
directly: its embedding baseline is the committed cassettes' vectors, and its decision
comparison reads the cassette format.

P2-D is drawn under P2-B, whose corpus, recorded embeddings, seeding and bootstrap its
measurement reuses. It also depends on P1-A directly, for the harness, and on P1-B, whose
`ModelDeps` seam and recording pattern its conditional answer-level stage uses. Its graph
session filter is the M1 that P4-B handed over, extended to edges. P2-E, a draft with no
file yet, executes whichever outcome P2-D's ADR selects, removal or wiring, from the
specification P2-D writes for both.

P4-B is drawn under P2-B, whose `graphFacts` seed format its cross-session case needs (the
graph-path task it also used was deleted with ADR 0009); it also depends on P1-A and P1-B directly, for the harness and
the cassettes. P4-C used to hang off P2-A alone. It is now drawn under P1-B, because it
changes the `act.selectTool` request and so re-records every cassette, and it adds an
evaluation task; it still depends on P2-A (ADR 0001's second obligation) and on P1-A.
Neither PRD depends on the other. Whichever of them lands second re-records the other's
cassettes, and both say what that costs.

`P0-B`, `P3-A`, `P4-A`, `P5-A`, and `P5-C` have no hard
predecessors and can be picked up whenever they are the most valuable next thing. P5-C
was previously drawn as a predecessor of P2-A; it is not one. `retryPolicy`,
`compile({ checkpointer })` and a peer-compatible saver were all available at
`@langchain/langgraph@0.4.10`, where P2-A shipped. P5-C has since moved the pins to
`@langchain/langgraph@1.4.18` and `@langchain/langgraph-checkpoint-postgres@1.0.5`.

P5-B waits on P5-A. The appendix recommends integrating with an ADK estate over A2A
rather than porting, and the one trial step that checks that recommendation needs P5-A's
server — its authentication and its v0.3 compatibility, which is what ADK for TypeScript
2.1.0 speaks.

P3-C and P3-D wait on P3-A. The ledger records the attestation an adverse determination
carries, and the prior-authorization surface emits its results through the determination
types, so both should be drafted against those types rather than invent their own. P3-D
also depends on P1-A and P1-B directly, because it adds a suite to the harness and a seam to
the cassette. Both are shipped, so it is not drawn under them.

P3-E is drawn under P3-D, whose case and pended response it picks up. It also depends on
P3-A directly, because its clinician route is the one caller of the `./clinician` entry
point, and that is not drawn a second time.

P3-F is drawn under P3-E, whose decided case, reviewer registry, signed payload and sweep it
extends. It also depends on P3-A directly, because it adds a second branded constructor,
`attestReconsideration`, to `@repo/determination/clinician`. Like P3-E, it can be built
before P3-C's ledger, so the ledger is not drawn as an edge.

P3-B is drawn under P1-B, its last predecessor, because the run record reuses the
cassette's decision format and moves its seam wrappers into production; it also depends on
P2-A directly, for the checkpointer it reads. P3-C appears twice because it needs two
things: P3-A's determination types, and P3-B's run record, which is what its
`run.recorded` entries commit to and the only producer the ledger has until P3-D. P3-E's
reviewer surface, split out of P3-D, will be the first caller of the ledger's attestation
append, but it can be built before the ledger exists, so that is not drawn as an edge.
