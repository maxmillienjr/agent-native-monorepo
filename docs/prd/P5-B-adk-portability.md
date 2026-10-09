---
id: P5-B
title: Agent Development Kit portability appendix
tier: 5
status: shipped
size: S
depends_on: [P5-A]
blocks: []
issue: 117
superseded_by: null
---

# P5-B · Agent Development Kit portability appendix

## Problem

Nothing in the repository says how its architecture relates to Google's Agent Development
Kit, although that is the first question a reader from a Google agent estate asks. On
2026-09-26 at `f0d55bd`, a case-insensitive `git grep` for `Agent Development Kit`, `ADK`,
`Agentspace` and `Gemini Enterprise` matches one line, the P5-B row in
`docs/prd/README.md`.

ADR 0001 is the record a reader would look in, and it answers a different question. Its
candidates were "LangGraph's own checkpointer, and a dedicated durable execution engine —
Temporal, Restate, or DBOS" (`docs/adr/0001-langgraph-over-a-durable-execution-engine.md:12-13`).
It does not compare agent frameworks, so "why LangGraph and not ADK" has no written answer.

The comparison has also moved, which is why this cannot be written from memory. These are
facts as of 2026-09-26, read from the release pages and the source:

| Fact                                            | Evidence                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADK ships in four languages                     | `google/adk-python` v2.10.0 (2026-09-25), `google/adk-java` v1.10.1 (2026-09-18), `google/adk-go` v2.4.0 (2026-09-11), `google/adk-js` `adk-v2.1.0` (2026-09-15; npm `@google/adk@2.1.0`)                                                                                                               |
| ADK for TypeScript exists and is at 2.x         | `@google/adk` 1.0.0 on 2026-04-21, 2.0.0 on 2026-08-21. It needs Node.js 20.19 or newer and accepts Zod v3 and v4 tool schemas (`adk-js` `README.md`)                                                                                                                                                   |
| ADK 2.x has graph workflows                     | `Workflow`, `FunctionNode`, edges and routes, per-node `RetryConfig` (`core/src/workflow/workflow.ts:137`, `nodes/function_node.ts:70`, `retry_config.ts`). The docs mark graphs "Python v2.0.0, TypeScript v2.0.0, Go v2.0.0" (<https://adk.dev/graphs/>)                                              |
| Resumption is rebuilt from the session's events | `ResumabilityConfig` lets an invocation resume "from the last event, if it's paused or failed midway" (`core/src/apps/resumability_config.ts`). `rehydration_utils.ts` rebuilds node state "from prior session events", and says it is a "static-graph subset" port                                     |
| Evaluation is Python-only                       | `adk.dev/evaluate` marks evaluation "Supported in ADK Python". `adk-js` at `adk-v2.1.0` has no evaluation module. Python's `AgentEvaluator` runs `num_runs` (default 2, `evaluation/agent_evaluator.py:73`) and compares a mean score with a threshold (`:870-901`), which is neither pass@k nor pass^k |
| Memory is an interface of two methods           | `BaseMemoryService.addSessionToMemory(session)` and `searchMemory(request)` (`core/src/memory/base_memory_service.ts:51,60`), with in-memory, Vertex AI Memory Bank and Vertex AI RAG implementations                                                                                                   |
| The TypeScript ADK speaks A2A 0.3               | `@google/adk@2.1.0` depends on `@a2a-js/sdk ^0.3.10` (`core/package.json:85`); `RemoteA2AAgent` is at `core/src/a2a/a2a_remote_agent.ts:123`                                                                                                                                                            |
| The managed runtime was renamed                 | The Agent Engine documentation now sits under "Gemini Enterprise Agent Platform", which Google announced on 2026-04-22 as "the evolution of Vertex AI". It lists ADK, LangGraph, LangChain, AG2 and LlamaIndex, and describes deployment in Python only                                                 |

The "Agentspace" in the role descriptions is now sold as part of Gemini Enterprise,
launched 2025-10-09. I did not find one primary Google page that states the rename in a
sentence, and the appendix says so rather than asserting it.

## Why it matters

The repository owner's target roles run on ADK and Gemini Enterprise. A code-reading
reviewer from one of those teams will ask two things: could this agent run on our stack,
and why was it not built on it. An answer that is wrong about ADK is worse than none,
because the reviewer knows ADK better than the author. ADK has also moved toward this
repository's shape since 2.0 — graph workflows, per-node retry, resumption — so the old
answer, "ADK is agent-centric and LangGraph is graph-centric", is no longer true. The
honest answer has to be concept by concept, pinned to versions, and run where running is
cheap.

## Scope

- `docs/appendix/adk-portability.md`, holding:
  1. the version pins above, dated;
  2. the concept map below, one row per concept, each with a fit value and evidence on
     both sides;
  3. **integrate, don't port**: an ADK agent calling this one through P5-A's A2A server;
  4. why the repository stays on LangGraph, tied to ADR 0001;
  5. what would change the answer.
- An out-of-tree trial that runs the load-bearing rows, recorded in the appendix with date,
  commit, versions, commands and results. This follows the trial P5-C recorded
  (`docs/prd/P5-C-langgraph-1x.md`, "What a trial bump did").
- An ADR, "LangGraph rather than ADK, with A2A as the integration seam". It holds the
  decision in the ADR format, and the appendix holds the evidence behind it.
- A link to the appendix from `README.md` and from `.context/architecture.md`.

### Non-goals

- **A committed ADK port, or a committed spike.** See "Doc plus trial, not a committed
  spike" below. **No PRD owns this**, and none should until one of ADR 0001's revisit
  conditions holds.
- **Deploying to Gemini Enterprise Agent Platform.** Its documentation describes Python
  deployment, and this service is TypeScript. **No PRD owns this.**
- **The A2A server itself.** **P5-A.**
- **An evaluation bridge to ADK's evalset format.** The harness's `TracedRun`
  (`apps/agent-service/src/runs/runs.service.ts:48-53`) is what one would target, and the
  appendix names it. **No PRD owns this.**
- **The Java and Go ADKs.** The appendix pins their versions and maps against TypeScript,
  the language of this repository, with Python where evaluation forces it.

## Design

### Doc plus trial, not a committed spike

Four reasons, each checkable.

1. **The convention would make a spike a capability to maintain.** A capability claim in
   `README.md`, `.context/` or `.agents/` must be true of the code at HEAD
   (`.context/conventions.md`, Documentation). Committed ADK code would be a second agent
   runtime in the tree. It would need a `docs/STATUS.md` row and a CI job to keep that row
   true. A dated trial record makes no claim about HEAD, only about what ran on that date
   against those versions, and it stays true.
2. **It would fail CI today.** `@google/adk@2.1.0` resolves `adm-zip@0.5.18` (measured
   2026-09-26: 304 packages, 129 MB in a scratch install). `npm audit` reports it under
   GHSA-xcpc-8h2w-3j85, GHSA-vwc7-r8mq-g2x9 and GHSA-7q85-xj36-vmfc, and rates the package
   `high`. `security.yml:66` runs `yarn npm audit --all --recursive --severity high` on
   every pull request, which is CTL-SUP-01. Clearing it would mean forcing `adm-zip@0.6.1`,
   outside the `^0.5.17` that ADK declares, with nothing upstream testing that combination.
3. **ADR 0001 decided the runtime.** A half-port in the tree reads as a hedge on that
   decision. A document with evidence reads as the decision being checked.
4. **The rows that could be wrong are the ones a trial can run.** Topology, retry,
   resumption, the model seam and A2A interop are behaviours, and a short script shows
   them. The rest — memory interfaces, evaluation, deployment targets — are facts about
   APIs, and reading the source at a pinned tag is the right evidence for those.

### The trial

Run in a scratch directory outside the workspace, against a worktree of this repository at
a recorded commit. It imports the compiled node functions from `apps/agent-service/dist`,
uses the stub `ModelDeps`, and makes no call to `generativelanguage.googleapis.com`.
`globalThis.fetch` is wrapped to count and refuse any request to that host, and the count
is printed.

| Step | What it runs                                                                                                                                                                                                  | Row it settles               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| T1   | The seven nodes as an ADK `Workflow` of `FunctionNode`s, with `act`'s self-loop as a route, on stub deps and stub memory. Compare the node sequence with `executeTraced`'s for the same input.                | Topology, state              |
| T2   | `reflect` throws twice and then succeeds, under `RetryConfig { maxAttempts: 3 }`. Then `reflect` throws a `ZodError`. Does ADK retry it? `IO_RETRY` does not (`agent/graph/retry.ts:27-33`).                  | Retry                        |
| T3   | `reflect` fails on every attempt, with `isResumable` and `DatabaseSessionService` on the compose Postgres. Resume, and count `distill` calls. The LangGraph answer is zero (`agent/graph/resume.test.ts:59`). | Checkpoint and resume        |
| T4   | An `LlmAgent` whose `beforeModelCallback` returns a recorded `LlmResponse` — ADK skips the model when it does (`core/src/agents/llm_agent.ts:176-187`). Count model requests.                                 | The cassette seam (ADR 0005) |
| T5   | An ADK TypeScript `RemoteA2AAgent`, run in an `InMemoryRunner`, sends one message to P5-A's server on the compose stack with a bearer token. Does the task complete?                                          | Integrate, don't port        |

T5 is why this PRD depends on P5-A. The appendix's central recommendation is only as good as
the one run that exercises it, and that run needs the server, its v0.3 compatibility, and
its authentication. The trial is time-boxed to one day. A step that does not run in that
time is recorded as not run, and its row is marked `read`.

### The concept map

The appendix's table has these rows at least. The fit column uses a fixed vocabulary:
**clean** means it maps one to one, **partial** means it maps with a named loss, **none**
means there is no counterpart, and **redundant** means ADK already provides it and a port
would delete ours. Each row also says whether it was `run` in the trial or `read` from the
source.

| Concept                  | Here                                                                                                             | ADK (TypeScript `adk-v2.1.0` unless noted)                                                                                    | Expected fit (to be settled) |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Graph topology           | `StateGraph`, seven nodes, conditional self-loop (`agent/graph/graph.ts:53-105`, `edges.ts:8`)                   | `Workflow` with `edges` and routes (`workflow/workflow.ts:137`)                                                               | clean — T1                   |
| State between nodes      | last-value channels on one annotation (`graph.ts:22-41`)                                                         | a node's output is the next node's input; `session.state` with `app:`/`user:`/`temp:` scopes (`sessions/state.ts:29-31`)      | partial — T1                 |
| Per-node retry           | `IO_RETRY` with a `retryOn` predicate (`retry.ts:27-33`)                                                         | `RetryConfig` with `exceptions` as error classes (`workflow/retry_config.ts`)                                                 | partial — T2                 |
| Checkpoint and resume    | `PostgresSaver` after every node, `thread_id = runId` (`memory/memory.module.ts:110-120`, `runs.service.ts:292`) | resume from session events and rehydrated node outputs (`apps/resumability_config.ts`, `workflow/utils/rehydration_utils.ts`) | partial — T3                 |
| Working memory           | `AgentState`, per run                                                                                            | `temp:` session state, per invocation                                                                                         | clean — read                 |
| Episodic memory          | `episodes`, `(session_id, turn_index)`, written by `reflect` (`reflect.node.ts:40-49`)                           | the session's event log (`sessions/base_session_service.ts:106-169`)                                                          | redundant — read             |
| Semantic memory          | Neo4j + pgvector, RRF over one candidate universe (ADR 0002, ADR 0004)                                           | `BaseMemoryService`; a custom implementation over `memory-core`. `searchMemory` takes a query with no `topK` or `hopDepth`    | partial — read               |
| Single writer            | `reflect` only (`CLAUDE.md`, Key Rules)                                                                          | `addSessionToMemory` from any callback; nothing enforces one writer                                                           | partial — read               |
| Model seam and cassettes | `ModelDeps` (`runs.service.ts:66-71`), ADR 0005                                                                  | `beforeModelCallback` / `beforeToolCallback` short-circuit; embeddings sit inside the memory service, not at a seam           | partial — T4                 |
| Tool selection           | a JSON prompt that picks a tool (`runs.service.ts:227-238`)                                                      | native function calling in `LlmAgent`                                                                                         | partial — read               |
| Evaluation               | `pass@k`, `pass^k`, graders, axes (`packages/eval-harness/src/harness.ts:80-96`)                                 | none in TypeScript; Python averages `num_runs` against a threshold                                                            | none — read                  |
| Telemetry                | `agent.node.*` spans (`agent/nodes/*.node.ts`)                                                                   | `invoke_agent`, `execute_tool` and model spans with `gen_ai.*` attributes (`telemetry/tracing.ts:29-36,92,172,281`)           | partial — read               |
| HTTP and A2A surface     | NestJS `/runs`; A2A server (P5-A)                                                                                | `toA2a` (`a2a/agent_to_a2a.ts:167`); `RemoteA2AAgent` as a client                                                             | clean — T5                   |
| Human in the loop        | `interrupt()` is available and unused (ADR 0001, Consequences)                                                   | request-input nodes and long-running tools                                                                                    | clean — read                 |
| Deployment target        | Docker Compose                                                                                                   | Cloud Run (`adk deploy cloud_run`); the Agent Platform documents Python                                                       | partial — read               |

The expected-fit column is the draft's reading. The appendix records what the trial found,
and where the two differ, **the trial wins and the appendix says the reading was wrong**.

### Why the repository stays on LangGraph

This section must follow from ADR 0001 and not add a capability argument that the trial
does not support. ADR 0001 chose LangGraph's checkpointer as the persistence layer
because it reuses the Postgres already provisioned. It named that checkpointer as "the
substrate P3-B's audit replay is built on" (`0001:29-30`), and it names two revisit
conditions: "a single run starts spanning minutes with external callbacks", or "fan-out
across agents with independent failure domains" (`0001:66-67`). The appendix states, for
each condition, whether it holds at HEAD, with evidence. It then makes the argument that
does not depend on ADK being weaker: an ADK or Gemini Enterprise estate can call this
agent over A2A today (T5), so porting would buy interoperability that is already there.
Porting would cost the checkpoint model that P3-B builds on (T3 says how much), and the
evaluation harness, which has no TypeScript counterpart. If T1 to T3 show that ADK 2.x
maps the graph, retry and resume cleanly, the appendix says so. The case then rests on
cost and on ADR 0001, and it says that too.

### What would change the answer

Written as observable conditions, not intentions:

- ADR 0001's revisit conditions become true.
- The Agent Platform documents a TypeScript deployment path.
- ADK for TypeScript gains an evaluation module that reports pass^k.
- A requirement appears for a Google-managed memory (Memory Bank). Those rows would then
  change from partial to redundant, which would reopen ADR 0002.

## Acceptance criteria

- [x] `docs/appendix/adk-portability.md` exists, and `README.md` and
      `.context/architecture.md` each link to it.
- [x] Its header states the date and pins every version it cites: ADK Python, Java, Go and
      TypeScript releases, `@a2a-js/sdk`, and this repository's commit.
- [x] Every row of the concept map has a fit from {clean, partial, none, redundant} and is
      marked `run` or `read`. On this repository's side it cites a path and a symbol that
      exist at HEAD. On ADK's side it cites a path at the pinned tag.
- [x] The map has at least the fifteen rows in the Design table.
- [x] Every `run` row names the trial step that ran it. Steps T1 to T5 are each recorded
      with date, commit, versions, command and result, or recorded as not run with the
      reason.
- [x] The trial output shows zero requests to `generativelanguage.googleapis.com`.
- [x] T5's record states whether an ADK TypeScript `RemoteA2AAgent` completed a task
      against P5-A's server with authentication enforced, and which A2A version it spoke.
- [x] The LangGraph section quotes ADR 0001's two revisit conditions and states, for each,
      whether it holds at HEAD, with evidence.
- [x] Wherever the trial contradicted the Design table's expected fit, the appendix says so
      in that row.
- [x] The ADR exists, is listed in `docs/adr/README.md`, and does not contradict ADR 0001.
- [x] `git grep -n '@google/adk' -- '*package.json' yarn.lock` returns nothing.
- [x] `yarn turbo typecheck`, `yarn turbo lint`, `yarn lint:docs` and `yarn format:check`
      pass.

## What the implementation found

_Recorded 2026-10-08, on the branch for #117._ The appendix is
`docs/appendix/adk-portability.md` and the decision is ADR 0016. The trial ran out of tree
on the stub model axis, with a `fetch` guard that counted zero requests to
`generativelanguage.googleapis.com` in every step. T3 and T5 used throwaway Postgres and
Neo4j containers on host ports 42432 and 42687, removed after, and T5 ran the service from
`dist` with `SERVICE_CREDENTIALS` set. The trial's output is in the appendix and in the pull
request.

**Every criterion is met, each with its evidence.** T1 to T5 all ran; none became a `read`
row. T5 ran on ADK for TypeScript, so the Python fallback was not needed.

**Where it diverged from the design, and why.**

- **Pinned newer than drafted.** Every ADK line released after 2026-09-26: TypeScript
  `adk-v2.2.1` (2026-10-06), Python `v2.11.0` and Java `v1.11.0` (2026-10-02), Go `v2.5.0`
  (2026-09-30). The appendix gives both columns. The client's `@a2a-js/sdk` resolved to
  0.3.14 under the same `^0.3.10`, so T5's dependency on the v0.3 path is unchanged.
- **The second reason for "doc plus trial, not a committed spike" no longer holds.** ADK
  2.2.0 raised `adm-zip` to `^0.6.1` (adk-js #923). `npm audit` of 2.2.1 reports two
  `moderate` advisories and no `high`; the same audit of 2.1.0 reports eight `adm-zip`
  advisories rated `high`. Reasons 1, 3 and 4 stand, and ADR 0016 says the spike is rejected
  on them alone.
- **Checkpoint and resume is `none`, not `partial`.** The design expected a different resume
  mechanism with the same count. The count differed: `distill` ran again. ADK for
  TypeScript 2.2.1's `Runner.runAsync` takes no invocation id, and `eventsForCurrentRun`
  keeps a prior invocation's node outputs only when it paused for human input, so a failed
  run's outputs, which were in Postgres, were dropped. `ResumabilityConfig`'s own comment
  says a run that "failed midway" can resume. Python's `run_async` takes an `invocation_id`;
  that was read, not run.
- **Two rows the design did not have.** The clinician gate (`none`, and untouched by a port)
  and the run record with audit replay (`partial`). The map has seventeen rows.
- **The design's "here" column had moved.** Semantic memory is no longer RRF over two
  stores, and `hopDepth` no longer exists (ADR 0009). What `searchMemory` lacks is a `topK`
  and a session scope.
- **Telemetry is partial for a reason the design did not name.** ADK puts model and tool
  content on spans unless `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` is turned off; this
  repository has no switch and an allowlist that fails the run.
- **Deployment.** The design said the platform documents Python only. adk.dev now marks
  Python and Go on its Agent Runtime page and all four languages on Cloud Run, and `adk-js`
  ships an undocumented `adk deploy agent_engine`. The managed runtime is now called Agent
  Runtime.
- **The cassette seam has three losses the design did not list.** The Gemini client refuses
  to construct without a key even when every call is short-circuited;
  `afterModelCallback` is not given the request; and a miss arrives as an `UNKNOWN_ERROR`
  event rather than the thrown class this repository's abort classification reads.
- **T5 found a wiring trap.** `RemoteA2AAgentConfig.agentCard` is documented as the URL of
  the card, and the 0.3 resolver appends `.well-known/agent-card.json` to it. The base URL
  works. The doubled path answered 401, because the server denies every route it does not
  exempt.
- **No `docs/STATUS.md` row.** The design makes no capability claim about HEAD, so there is
  nothing for a row to hold true. README and the architecture name ADK for TypeScript without
  a version now, because 2.1.0 and 2.2.1 both speak v0.3.

**What the scaffolding did not say.** `docs/appendix/` is new, and the Documentation
conventions named `docs/prd/`, `docs/adr/` and `docs/STATUS.md` but not a third kind of
document: one that holds evidence, is dated and pinned like a PRD's trial record, and makes
no claim about HEAD that a later commit could falsify. Without that rule the appendix reads as
either a capability claim, which the convention would hold to HEAD, or a PRD, which it is
not. `.context/conventions.md` now says what an appendix is and how one is refreshed.

## Risks and open questions

- **ADK moves faster than the appendix.** `@google/adk` went from 1.0.0 to 2.1.0 in five
  months, and adk-python released four versions in the fortnight before this draft. The
  appendix is pinned and dated, so it stays true as a record. It stops being current. The
  header says how to refresh it: re-run the trial against new tags. A stale "current"
  claim is the failure this design exists to avoid.
- **The premise may be weaker than it looks.** If T1 to T3 come back clean, the only
  capability gaps left are evaluation (Python-only) and the checkpoint model. The honest
  answer is then "we stay for cost and for ADR 0001, not because ADK cannot". The appendix
  has to be willing to say that. A reviewer from an ADK team would find a manufactured gap.
- **T3 compares different resume models.** LangGraph restores channel values from a
  snapshot; ADK replays events and fast-forwards completed nodes. "`distill` was not
  re-run" can be true of both for different reasons. The record describes the mechanism,
  not only the count.
- **T5 depends on P5-A's v0.3 path.** If P5-A drops v0.3 compatibility, T5 needs ADK for
  Python, whose `a2a-sdk>=0.3.4,<2` range (`pyproject.toml` at v2.10.0) admits 1.x. That
  would bring Python into the trial. **Open question for review:** is a Python ADK client
  acceptable for T5, or is TypeScript required? **Decided at review, 2026-09-26:** P5-A
  keeps its v0.3 path, so T5 uses ADK for TypeScript. A Python client is acceptable only
  as a fallback if that path fails, and the appendix says which one ran.
- **Product names are in flux.** Agentspace, Agent Engine and Vertex AI have each been
  renamed or folded in within a year. The appendix uses the names on Google's pages as of
  its date and gives the former names once.
- **Size.** `S` holds only if the trial stays inside its day. The trial is out of tree and
  ungated, so an overrun costs time, not correctness. Steps that do not run become `read`
  rows, stated as such.

## References

- ADK documentation — <https://adk.dev/>, <https://adk.dev/graphs/>, <https://adk.dev/evaluate/>.
- `google/adk-js` at `adk-v2.1.0` — <https://github.com/google/adk-js>; `google/adk-python`
  at v2.10.0 — <https://github.com/google/adk-python>; `google/adk-java` v1.10.1;
  `google/adk-go` v2.4.0.
- Google Cloud, _Introducing Gemini Enterprise_, 2025-10-09 —
  <https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise>.
- Google Cloud, _Introducing Gemini Enterprise Agent Platform_, 2026-04-22 —
  <https://cloud.google.com/blog/products/ai-machine-learning/introducing-gemini-enterprise-agent-platform>.
- Agent Engine overview — <https://docs.cloud.google.com/vertex-ai/generative-ai/docs/agent-engine/overview>.
- GitHub advisories GHSA-xcpc-8h2w-3j85, GHSA-vwc7-r8mq-g2x9, GHSA-7q85-xj36-vmfc (`adm-zip`).
- ADR 0001, ADR 0002, ADR 0005; `docs/prd/P5-A-a2a-server.md`; `docs/prd/P5-C-langgraph-1x.md`
  (the trial-record precedent).
