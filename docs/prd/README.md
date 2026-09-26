# Product Requirement Docs

## Where things stand

_Last updated 2026-09-26. If this section is more than a few weeks stale, trust the code
over it and update it._

**Six PRDs are shipped and the system they describe is running.** The service answers
`POST /runs` and `POST /runs/stream`; `memory-core` is constructed by the app rather than
sitting beside it; the graph compiles with a checkpointer and a retry policy on every node
that performs I/O; and `packages/eval-harness` measures the result. Verified against live
stores from an empty database: one run leaves episodic rows, `:Concept` and `:Fact` nodes,
`semantic_facts` rows and checkpoints under the runId its own response returned.

**`docs/STATUS.md` is the authority on any capability sentence, including the ones above.**
Eighteen rows, each with a status, a file and a line — fifteen `implemented`, one
`planned`, one `stubbed`, one `removed`, none `broken`. The rule that keeps it true is in
`.context/conventions.md`: a change that moves a row moves it there in the same pull
request. `yarn lint:docs` fails CI when a PRD's status disagrees with its row below.

**The agent is measured, but not yet gated.** `yarn eval` runs n trials per task and reports
`pass@k` and `pass^k`, and every number names the axes that produced it. Measured
2026-08-29 — model `stub` / memory `live`, 5 trials x 2 tasks: 50%, with `memory-recall-001`
at 5/5 and `tool-use-001` at 0/5. That 0/5 is the stub axis's ceiling and not the agent's
score: `runs.service.ts:264` returns `null` from `selectTool` for every input, so a task
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
reports. What none of this is yet is a merge gate — P1-C wires evaluation into a pipeline,
P1-D decides which failures should block.

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
recording is never averaged with itself. What this is not yet is a CI tier — P1-C owns
that.

**[P1-C](P1-C-tiered-eval-pipeline.md) is accepted.** It replaces the nightly
job, which runs the same 27 `memory-core` integration tests that `e2e.yml` already runs on
every pull request, with two tiers. A replay tier runs on every pull request with no key
and needs only the two service containers: measured 2026-09-26 on fresh containers with no
seed step, it takes 17s and passes every grader. A live tier runs nightly at about eight
`generateContent` calls. Three things the draft found by running, not by reading. The
repository has **no Actions secrets**, so the live tier has no key. A cassette miss and a
failed grader **both exit 1**, the miss writes no report, and Turbo reduces any failing
exit code to 1. The chat client **already retries a 429 six times** before `IO_RETRY` sees
it, so the fix P1-A handed over (retry 429 in `IO_RETRY`) would make things worse. The live
tier is written conditional on a repository secret, and shows as skipped, never as passed,
until one exists.

**[P2-B](P2-B-retrieval-ablation.md) is accepted** — the ablation ADR
0002 has been waiting for. Drafting it found that the deployed graph path is close to
unreachable: the seed linker deletes `_`, and 34 of the 41 entity ids in the two live
extractions contain one. The draft therefore measures the store with the linker taken out
as well as the deployed path, and pre-registers what happens to ADR 0002 under each
outcome. It also found that the tie-break P1-B added stops the vector query from using its
HNSW index, a trade ADR 0006 now records.

**[P2-C](P2-C-otel-genai-semantics.md) is accepted.** It found that a
run is seven single-span traces rather than one — no span encloses the graph, and no
instrumentation supplies a parent — that two of the three `generateContent` calls drop
their token usage before anything records it, and that the GenAI conventions it adopts
have moved to a repository with no release, so it pins a commit. The replay axis emits
inference spans carrying the cassette's recorded usage, marked as replayed, so that the
pull-request tier can see the budgets P1-F will assert.

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

The repository's stated thesis. P1-A is shipped: `yarn eval` runs live trials against the
real application context and reports `pass@k` and `pass^k` per axis. What is still true is
that `.github/workflows/agent-eval.yml` runs `yarn turbo test:eval`, which resolves to a
single integration suite in `packages/memory-core` that never invokes the agent — P1-C owns
replacing it.

| ID                                     | Title                                                         | Size | Status   |
| -------------------------------------- | ------------------------------------------------------------- | ---- | -------- |
| [P1-A](P1-A-eval-harness.md)           | `packages/eval-harness` — evaluation as a first-class package | L    | shipped  |
| [P1-B](P1-B-agent-cassette.md)         | `packages/agent-cassette` — decision-level record and replay  | L    | shipped  |
| [P1-C](P1-C-tiered-eval-pipeline.md)   | Tiered evaluation pipeline replacing the nightly stub         | M    | accepted |
| [P1-D](P1-D-regression-gate.md)        | Statistical regression gate against committed baselines       | L    | accepted |
| [P1-E](P1-E-model-drift-canary.md)     | Model-drift canary against pinned and floating model ids      | M    | accepted |
| [P1-F](P1-F-cost-and-step-budgets.md)  | Cost, latency, and step budgets as CI assertions              | M    | accepted |
| [P1-G](P1-G-task-axis-requirements.md) | Task-level axis requirements for the evaluation suite         | S    | shipped  |

## Tier 2 — Make the architecture real

The three-tier memory model is instantiated and the graph is checkpointed. What remains is
measuring whether the hybrid premise holds, and saying so in the standard vocabulary.

| ID                                   | Title                                                            | Size | Status   |
| ------------------------------------ | ---------------------------------------------------------------- | ---- | -------- |
| [P2-A](P2-A-wire-memory-core.md)     | Wire memory-core into the service; add checkpointing and retry   | L    | shipped  |
| [P2-B](P2-B-retrieval-ablation.md)   | Hybrid retrieval evaluation and the graph/vector/hybrid ablation | L    | accepted |
| [P2-C](P2-C-otel-genai-semantics.md) | OpenTelemetry GenAI semantics, including evaluation events       | L    | accepted |

## Tier 3 — Regulated-domain credibility

Optional vertical. Demonstrates that the chassis holds up under the constraints a payer or
provider actually operates under. Uses synthetic data only.

| ID                              | Title                                                        | Size | Status   |
| ------------------------------- | ------------------------------------------------------------ | ---- | -------- |
| [P3-A](P3-A-clinician-gate.md)  | Clinician-gate invariant enforced in the type system         | S    | accepted |
| [P3-B](P3-B-audit-replay.md)    | Deterministic replay for audit reconstruction                | L    | accepted |
| [P3-C](P3-C-decision-ledger.md) | Hash-chained, tamper-evident decision ledger                 | L    | accepted |
| P3-D                            | Synthetic payer dataset and FHIR prior-authorization surface | L    | draft    |

## Tier 4 — Governance and agent security as code

| ID                               | Title                                                           | Size | Status   |
| -------------------------------- | --------------------------------------------------------------- | ---- | -------- |
| [P4-A](P4-A-controls-as-code.md) | `governance/controls.yaml` and a CI check for unmapped controls | M    | accepted |
| P4-B                             | Memory-poisoning red team mapped to OWASP Agentic Top 10        | M    | draft    |
| P4-C                             | Reversibility-tiered tool registry with saga compensation       | M    | draft    |

## Tier 5 — Interoperability

| ID                           | Title                                            | Size | Status   |
| ---------------------------- | ------------------------------------------------ | ---- | -------- |
| P5-A                         | Agent2Agent v1.0 server with a signed Agent Card | M    | draft    |
| P5-B                         | Agent Development Kit portability appendix       | S    | draft    |
| [P5-C](P5-C-langgraph-1x.md) | Upgrade to LangGraph 1.x                         | S    | accepted |

## Sequencing

The dependency spine, not a schedule:

```
P0-A ──▶ P2-A ──┬──▶ P1-A ──┬──▶ P1-B ──┬──▶ P1-C ──┬──▶ P1-D
                │           │           │           ├──▶ P1-E
                │           │           │           └──▶ P1-F
                │           │           ├──▶ P2-B
                │           │           ├──▶ P2-C ──────▶ P1-F
                │           │           └──▶ P3-B ──────▶ P3-C
                │           └──▶ P1-G
                └──▶ P4-C

P3-A ──┬──▶ P3-C
       └──▶ P3-D
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
because its replay-axis design reads the cassette's recorded usage; both are shipped, so
P2-C is unblocked.

P1-E is drawn under P1-C, whose nightly live job it reads, but it also depends on P1-B
directly: its embedding baseline is the committed cassettes' vectors, and its decision
comparison reads the cassette format.

`P0-B`, `P3-A`, `P4-A`, `P4-B`, `P5-A`, `P5-B`, and `P5-C` have no hard
predecessors and can be picked up whenever they are the most valuable next thing. P5-C
was previously drawn as a predecessor of P2-A; it is not one. `retryPolicy`,
`compile({ checkpointer })`, and a peer-compatible
`@langchain/langgraph-checkpoint-postgres@0.1.3` are all available at the pinned
`@langchain/langgraph@0.4.10`.

P3-C and P3-D wait on P3-A. The ledger records the attestation an adverse determination
carries, and the prior-authorization surface emits its results through the determination
types, so both should be drafted against those types rather than invent their own.

P3-B is drawn under P1-B, its last predecessor, because the run record reuses the
cassette's decision format and moves its seam wrappers into production; it also depends on
P2-A directly, for the checkpointer it reads. P3-C appears twice because it needs two
things: P3-A's determination types, and P3-B's run record, which is what its
`run.recorded` entries commit to and the only producer the ledger has until P3-D. P3-D's
reviewer surface will be the first caller of the ledger's attestation append, but it can be
built before the ledger exists, so that is not drawn as an edge.
