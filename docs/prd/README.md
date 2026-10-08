# Product Requirement Docs

## Where things stand

_Last updated 2026-10-08. If this section is more than a few weeks stale, trust the code
over it and update it._

**Ten PRDs are shipped and the system they describe is running.** The service answers
`POST /runs` and `POST /runs/stream`; `memory-core` is constructed by the app rather than
sitting beside it; the graph compiles with a checkpointer and a retry policy on every node
that performs I/O; and `packages/eval-harness` measures the result. Verified against live
stores from an empty database: one run leaves episodic rows, `:Concept` and `:Fact` nodes,
`semantic_facts` rows and checkpoints under the runId its own response returned.

**`docs/STATUS.md` is the authority on any capability sentence, including the ones above.**
Twenty-three rows, each with a status and evidence cited by name — eighteen `implemented`, one
`planned`, three `stubbed`, one `removed`, none `broken`. The rule that keeps it true is in
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

**[P1-C](P1-C-tiered-eval-pipeline.md) is in progress**, tracked in
[#56](https://github.com/maxmillienjr/agent-native-monorepo/issues/56), with its pull
request open and green. `agent-eval.yml` no longer runs the memory integration suite: its
`eval-replay` job runs the agent on every pull request, every push to `main` and nightly,
against the committed cassettes and two service containers, with no key. Its `eval-live`
job runs nightly and on dispatch only when a `GOOGLE_API_KEY` repository secret exists.
There is none, so it shows as skipped, never passed, and the replay summary says why. Each
job declares `EVAL_EXPECT_AXES`, so a job that lost its key or its mode refuses before a
trial. A run that cannot complete now writes `eval-abort.json` and a summary headed
`aborted`, with the trials that finished, and never `eval-report.json`. That is how a stale
cassette differs from a failed grader, since Turbo reduces both exit codes to 1. A
daily-quota 429 is terminal on both model paths, so the chat client makes one request
instead of seven, and the abort names it. **Three criteria are open.** Two need a
repository secret and pass to P1-E. The third, the classifier against a real free-tier
429, spends a day's quota and waits for the owner to schedule it. Moving
`REQUIRE_INTEGRATION_ENV` onto `e2e.yml` needed a `turbo.json` declaration the PRD did not
foresee. Without it, strict env mode strips the flag, and the suite skips again.

**[P1-D](P1-D-regression-gate.md) is in progress**, tracked in
[#76](https://github.com/maxmillienjr/agent-native-monorepo/issues/76). `eval-replay` now
exits on a verdict, not a pass rate: every one of the 21 replayed grader results is compared
exactly with a committed `baselines/replay.json`, and any difference blocks, an improvement
included, as does an abort. The probe that used to exit 0 at 100% (a task skipped, an
assertion deleted) now names 11 `missing` cells, and a known failure can be committed.
`EVAL_CASSETTE_MODE=replay EVAL_GATE=update yarn eval` accepts a change with no key. The
nightly pools live tallies on an orphan `eval-history` branch against a committed reference
at δ = 0.20, and will read `insufficient-evidence` for weeks. It has not run, because there
is no secret. **Nothing blocks a merge until the owner applies
`.github/rulesets/main.json`**, which requires `eval-replay`; `yarn lint:docs` keeps its
check names equal to real jobs.

**[P2-B](P2-B-retrieval-ablation.md) has shipped**, tracked in
[#57](https://github.com/maxmillienjr/agent-native-monorepo/issues/57), and the answer to
ADR 0002 is no. `yarn eval:retrieval` scored vector, graph and hybrid on 200 queries labelled
before any vector existed. It replays recorded embeddings with no key, and two runs from
empty stores are byte-identical. On the deployed path `hybrid` equals `vector` at 0.940
Recall@10, because the seed linker produced no id the graph holds on any query. With perfect
seeds `hybrid` is 0.145 below `vector`, interval [−0.195, −0.095]: the graph ranks only by
hop distance, and RRF weighs that hash-ordered list as heavily as the vector list. The
pre-registered rule selects "neither does", and a blind model adjudication of the 3,029
pooled candidates added one label and selects the same row. [ADR
0009](../adr/0009-the-second-store-after-the-retrieval-ablation.md) is **proposed**, not
accepted. It supersedes 0002 on acceptance and recommends taking the graph out of the fused
list, with removing the graph path as the fallback. Nothing in code changes until it is
accepted. Any linker fix must wait for P4-B's session filter on the graph. The ablation runs
in no pipeline, and nothing owns wiring it in.

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

**[P5-C](P5-C-langgraph-1x.md) is in progress**, tracked in [#61](https://github.com/maxmillienjr/agent-native-monorepo/issues/61).
The service now runs on `@langchain/langgraph@1.4.18` and `@langchain/core@1.2.12`. Every
offline gate passes, the replay is identical to the one at 0.x, and checkpoints resume across
the upgrade in both directions. The upgrade changed one behaviour. At `core` 1.x, LangChain's
default retry handler stops on any 429 whose message mentions quota or billing, and every
Gemini 429 does. P1-C's `stopOnDailyQuota` handed non-daily 429s to that default, so they
became terminal. It now retries them itself, and the client waits out a per-minute 429
again, as it did at 0.x. One live `tool-use-001` trial is still open: the only live run
predates that fix, and it stopped on a per-minute 429.

**[P3-A](P3-A-clinician-gate.md) has shipped**, tracked in
[#75](https://github.com/maxmillienjr/agent-native-monorepo/issues/75). ADR 0003's rule
that the agent must not make an adverse determination now has a mechanism.
`@repo/determination` types the agent's output as an approval or a referral, and the one
constructor for a denial needs a clinician's attestation. That constructor sits behind a
`./clinician` subpath, which a lint rule bars from the graph. Type tests fail
`yarn turbo typecheck` if an unattested denial compiles, and every run response is now
parsed strictly on the way out. On review, the chat graph's `disposition` channel moved to
P3-D, so nothing produces a disposition yet, and `docs/STATUS.md` row 20 says `stubbed`.
LangGraph still does not check what a node returns, at 0.4.10 or at 1.4.18. Implementing
this found that the `Node` alias misses an undeclared key returned beside a declared one;
an explicit return type catches it. CTL-HUM-01 is `implemented`, with its title narrowed to
what is enforced.

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

| ID                                     | Title                                                         | Size | Status      |
| -------------------------------------- | ------------------------------------------------------------- | ---- | ----------- |
| [P1-A](P1-A-eval-harness.md)           | `packages/eval-harness` — evaluation as a first-class package | L    | shipped     |
| [P1-B](P1-B-agent-cassette.md)         | `packages/agent-cassette` — decision-level record and replay  | L    | shipped     |
| [P1-C](P1-C-tiered-eval-pipeline.md)   | Tiered evaluation pipeline replacing the nightly stub         | M    | in-progress |
| [P1-D](P1-D-regression-gate.md)        | Statistical regression gate against committed baselines       | L    | in-progress |
| [P1-E](P1-E-model-drift-canary.md)     | Model-drift canary against pinned and floating model ids      | M    | accepted    |
| [P1-F](P1-F-cost-and-step-budgets.md)  | Cost, latency, and step budgets as CI assertions              | M    | accepted    |
| [P1-G](P1-G-task-axis-requirements.md) | Task-level axis requirements for the evaluation suite         | S    | shipped     |

## Tier 2 — Make the architecture real

The three-tier memory model is instantiated and the graph is checkpointed. What remains is
measuring whether the hybrid premise holds. The standard vocabulary for saying so is in
place: P2-C emits the OpenTelemetry GenAI conventions.

| ID                                   | Title                                                            | Size | Status  |
| ------------------------------------ | ---------------------------------------------------------------- | ---- | ------- |
| [P2-A](P2-A-wire-memory-core.md)     | Wire memory-core into the service; add checkpointing and retry   | L    | shipped |
| [P2-B](P2-B-retrieval-ablation.md)   | Hybrid retrieval evaluation and the graph/vector/hybrid ablation | L    | shipped |
| [P2-C](P2-C-otel-genai-semantics.md) | OpenTelemetry GenAI semantics, including evaluation events       | L    | shipped |

## Tier 3 — Regulated-domain credibility

Optional vertical. Demonstrates that the chassis holds up under the constraints a payer or
provider actually operates under. Uses synthetic data only.

| ID                                            | Title                                                         | Size | Status   |
| --------------------------------------------- | ------------------------------------------------------------- | ---- | -------- |
| [P3-A](P3-A-clinician-gate.md)                | Clinician-gate invariant enforced in the type system          | S    | shipped  |
| [P3-B](P3-B-audit-replay.md)                  | Deterministic replay for audit reconstruction                 | L    | accepted |
| [P3-C](P3-C-decision-ledger.md)               | Hash-chained, tamper-evident decision ledger                  | L    | accepted |
| [P3-D](P3-D-payer-dataset-fhir-prior-auth.md) | Synthetic payer dataset and FHIR prior-authorization surface  | L    | accepted |
| [P3-E](P3-E-clinician-review-queue.md)        | Clinician review queue, `$inquire` and the decision clock     | M    | accepted |
| P3-F                                          | Appeals: reconsideration lifecycle for adverse determinations | M    | draft    |

## Tier 4 — Governance and agent security as code

| ID                                        | Title                                                           | Size | Status   |
| ----------------------------------------- | --------------------------------------------------------------- | ---- | -------- |
| [P4-A](P4-A-controls-as-code.md)          | `governance/controls.yaml` and a CI check for unmapped controls | M    | shipped  |
| [P4-B](P4-B-memory-poisoning-red-team.md) | Memory-poisoning red team mapped to OWASP Agentic Top 10        | M    | accepted |
| [P4-C](P4-C-reversible-tool-registry.md)  | Reversibility-tiered tool registry with saga compensation       | M    | accepted |

## Tier 5 — Interoperability

| ID                              | Title                                            | Size | Status      |
| ------------------------------- | ------------------------------------------------ | ---- | ----------- |
| [P5-A](P5-A-a2a-server.md)      | Agent2Agent v1.0 server with a signed Agent Card | L    | accepted    |
| [P5-B](P5-B-adk-portability.md) | Agent Development Kit portability appendix       | S    | accepted    |
| [P5-C](P5-C-langgraph-1x.md)    | Upgrade to LangGraph 1.x                         | S    | in-progress |

## Sequencing

The dependency spine, not a schedule:

```
P0-A ──▶ P2-A ──▶ P1-A ──┬──▶ P1-B ──┬──▶ P1-C ──┬──▶ P1-D
                         │           │           ├──▶ P1-E
                         │           │           └──▶ P1-F
                         │           ├──▶ P2-B ──────▶ P4-B
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

P4-B is drawn under P2-B, whose `graphFacts` seed format and graph-path task its
cross-session case needs; it also depends on P1-A and P1-B directly, for the harness and
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

P3-B is drawn under P1-B, its last predecessor, because the run record reuses the
cassette's decision format and moves its seam wrappers into production; it also depends on
P2-A directly, for the checkpointer it reads. P3-C appears twice because it needs two
things: P3-A's determination types, and P3-B's run record, which is what its
`run.recorded` entries commit to and the only producer the ledger has until P3-D. P3-E's
reviewer surface, split out of P3-D, will be the first caller of the ledger's attestation
append, but it can be built before the ledger exists, so that is not drawn as an edge.
