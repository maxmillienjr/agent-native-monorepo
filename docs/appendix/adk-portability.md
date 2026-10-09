# Appendix · Agent Development Kit portability

_Recorded 2026-10-08 (P5-B). This is a dated record, not a description of HEAD: every ADK
claim below is about the pinned tags, and every claim about this repository is about the
commit named here. To refresh it, check out new tags, re-run the five trial steps against a
new commit, and replace the record; do not edit a row in place._

**The short answer.** ADK 2.x can express this agent's graph: the seven nodes ran as an ADK
`Workflow` and produced the same node sequence and final state as the LangGraph build (T1).
Retry maps with a named loss (T2). Resuming a failed run does not map in ADK for TypeScript
2.2.1, which re-ran the extraction node that the LangGraph checkpointer skips (T3).
Evaluation has no TypeScript counterpart. An ADK agent already calls this one over A2A, with
authentication enforced, and the task completed (T5). So the repository stays on LangGraph
for ADR 0001's reasons and for what a port would cost, not because ADK cannot express the
graph, and an ADK estate integrates with it over A2A rather than porting it.
[ADR 0016](../adr/0016-langgraph-rather-than-adk-with-a2a-as-the-seam.md) records the
decision; this page holds the evidence.

## Versions

Each was the latest release on 2026-10-08. The PRD was drafted on 2026-09-26 against the
releases in the second column, and every ADK release since then was taken.

| What                   | Pinned here                                       | Drafted against | Released   |
| ---------------------- | ------------------------------------------------- | --------------- | ---------- |
| ADK for TypeScript     | `@google/adk@2.2.1`, tag `adk-v2.2.1` of `adk-js` | 2.1.0           | 2026-10-06 |
| ADK for Python         | `google/adk-python` `v2.11.0`                     | v2.10.0         | 2026-10-02 |
| ADK for Java           | `google/adk-java` `v1.11.0`                       | v1.10.1         | 2026-10-02 |
| ADK for Go             | `google/adk-go` `v2.5.0`                          | v2.4.0          | 2026-09-30 |
| A2A client (under ADK) | `@a2a-js/sdk@0.3.14`, from ADK's `^0.3.10`        | `^0.3.10`       | 2026-09-29 |
| A2A server (this repo) | `@a2a-js/sdk@1.2.1` (`~1.2.1`, P5-A)              | —               | —          |
| LangGraph (this repo)  | `@langchain/langgraph@1.4.19`                     | —               | —          |
| This repository        | `7c8b900` (`origin/main`)                         | `f0d55bd`       | —          |

The trial ran at `27e7e2c`, which is `7c8b900` plus one commit that changes only the PRD's
frontmatter, on Node `v24.11.1`. Java and Go are pinned and not mapped: the map is against
TypeScript, the language of this repository, with Python where evaluation forces it.

**What moved since the draft.** `@google/adk` 2.2.0 raised `adm-zip` to `^0.6.1` (adk-js
#923). A scratch install of 2.2.1 resolves `adm-zip@0.6.1`, and `npm audit` reports two
`moderate` advisories (`uuid` under `gaxios`) and nothing `high`. The same audit of 2.1.0
reports `adm-zip` `high`, under GHSA-xcpc-8h2w-3j85 and seven more. So the PRD's second reason
for not committing a spike, that it would fail `security.yml`'s audit, held at 2.1.0 and no
longer holds at 2.2.1. The other three reasons stand on their own.

**Product names, as Google's pages give them on this date.** The managed runtime once called
Vertex AI Agent Engine is now **Agent Runtime** (also "Agent Platform Runtime"), and its
documentation sits under **Gemini Enterprise Agent Platform**, which Google announced on
2026-04-22 as "the evolution of Vertex AI". That page lists ADK, Agent2Agent, LangChain,
LangGraph, AG2 and LlamaIndex. The Agentspace of earlier role descriptions is sold as part of
Gemini Enterprise, launched 2025-10-09; no primary Google page states that rename in a
sentence, so this page does not quote one.

## The concept map

**Fit** is one of: **clean**, maps one to one; **partial**, maps with the loss named;
**none**, no counterpart; **redundant**, ADK already provides it and a port would delete
this repository's. **How** is `run` with the trial step that settled it, or `read` from the
source at the pinned tag. Paths on this side are under `apps/agent-service/src/` unless they
start with `packages/` or `docs/`; paths on ADK's side are under `core/src/` in `adk-js` at
`adk-v2.2.1` unless they say otherwise.

| #   | Concept                     | Here                                                                                                                                                                                                                 | ADK                                                                                                                                                                                                                        | Fit       | How    |
| --- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------ |
| 1   | Graph topology              | `StateGraph`, seven nodes, a conditional self-loop on `act` (`agent/graph/graph.ts#buildAgentGraph`, `agent/graph/edges.ts#shouldContinueActing`)                                                                    | `Workflow` with `edges` and a routing map, a node emitting `route` (`workflow/workflow.ts#Workflow`, `workflow/nodes/function_node.ts#FunctionNode`)                                                                       | clean     | run T1 |
| 2   | State between nodes         | last-value channels on one annotation (`agent/graph/graph.ts#AgentStateAnnotation`)                                                                                                                                  | a node's output is the next node's input; `session.state` with `app:`/`user:`/`temp:` scopes (`sessions/state.ts#State`)                                                                                                   | partial   | run T1 |
| 3   | Per-node retry              | `IO_RETRY`, a `retryOn` predicate that refuses a `ZodError`, a 4xx by status, a cassette miss and a record-write failure (`agent/graph/retry.ts#IO_RETRY`)                                                           | `RetryConfig`, whose `exceptions` is an allowlist of class names; unset retries everything (`workflow/retry_config.ts#RetryConfig`, `workflow/utils/retry_utils.ts#shouldRetryNode`)                                       | partial   | run T2 |
| 4   | Checkpoint and resume       | `PostgresSaver` after every node, `thread_id = runId`; a resumed run skips completed nodes (`memory/memory.module.ts#MemoryModule`, `agent/graph/resume.test.ts#does not re-run distill after a failure in reflect`) | node outputs persist as session events, but a failed invocation is a run boundary and a new turn re-runs every node (`workflow/utils/rehydration_utils.ts#eventsForCurrentRun`, `runner/runner.ts#Runner.runAsync`)        | none      | run T3 |
| 5   | Working memory              | `AgentState`, per run (`agent/graph/state.ts#AgentStateSchema`)                                                                                                                                                      | `temp:` session state, which is never committed to the session (`sessions/base_session_service.ts#BaseSessionService.updateSessionState`)                                                                                  | clean     | read   |
| 6   | Episodic memory             | `episodes`, keyed `(session_id, turn_index)`, first write wins, written only by `reflect` (`agent/nodes/reflect.node.ts#reflectNode`)                                                                                | the session's event log (`sessions/base_session_service.ts#BaseSessionService`, `sessions/database_session_service.ts#DatabaseSessionService`)                                                                             | redundant | read   |
| 7   | Semantic memory             | pgvector, vector-only retrieval with a `topK` (ADR 0009); Neo4j written and read by no request (`.context/architecture.md`, Semantic Memory)                                                                         | `BaseMemoryService`; `searchMemory` takes `appName`, `userId` and `query`, with no `topK` and no session scope (`memory/base_memory_service.ts#SearchMemoryRequest`)                                                       | partial   | read   |
| 8   | Single writer               | `reflect` alone receives the writers (`agent/graph/graph.ts#GraphDeps`, `CLAUDE.md`, Key Rules)                                                                                                                      | the memory service hangs off every invocation context; nothing enforces one writer (`runner/runner.ts#Runner.memoryService`, `memory/vertex_ai_memory_bank_service.ts#VertexAiMemoryBankService.addMemory`)                | partial   | read   |
| 9   | Model seam and cassettes    | `ModelDeps`, recorded and replayed at the decision seam (`agent/model/model-deps.ts#ModelDeps`, `agent/model/decision-seam.ts`, ADR 0005)                                                                            | `beforeModelCallback` and `beforeToolCallback` short-circuit the call (`agents/llm_agent.ts#LlmAgent.callLlmAsync`); embeddings sit inside the memory service, not at a seam                                               | partial   | run T4 |
| 10  | Tool selection              | a JSON prompt that picks one tool, at the `act.selectTool` seam (`agent/model/decision-seam.ts`, `agent/model/model-deps.ts#defaultTools`)                                                                           | native function calling in `LlmAgent`; `FunctionTool` with a Zod schema (`tools/function_tool.ts#FunctionTool`)                                                                                                            | partial   | read   |
| 11  | Evaluation                  | `pass@k` and `pass^k` per task, graders, axes (`packages/eval-harness/src/harness.ts#EvalHarness`)                                                                                                                   | none in TypeScript; Python averages `num_runs` (default 2) against a threshold (`src/google/adk/evaluation/agent_evaluator.py` at `v2.11.0`, `NUM_RUNS`)                                                                   | none      | read   |
| 12  | Telemetry                   | `invoke_agent` root, `agent.node.*` spans, content capture off with no switch, an attribute allowlist (`packages/telemetry/src/genai.ts#withNodeSpan`, `packages/telemetry/src/genai.ts#ALLOWED_SPAN_ATTRIBUTES`)    | `invoke_agent`, `invoke_workflow`, `execute_node`, `execute_tool` and model spans with `gen_ai.*` attributes; content captured by default (`telemetry/tracing.ts#traceCallLlm`, `telemetry/tracing.ts#traceNodeExecution`) | partial   | read   |
| 13  | HTTP and A2A surface        | NestJS `/runs`; A2A v1.0 at `/a2a/jsonrpc` with the v0.3 names, bearer auth (`a2a/mount.ts#mountA2a`, `a2a/run-executor.ts#RunExecutor`, ADR 0014)                                                                   | `RemoteA2AAgent` as a client (`a2a/a2a_remote_agent.ts#RemoteA2AAgent`); `toA2a` as a server, which refuses to mount without authentication (`a2a/agent_to_a2a.ts#toA2a`)                                                  | clean     | run T5 |
| 14  | Human in the loop           | `interrupt()` available and unused; the case that waits on a clinician lives above the graph (ADR 0001, ADR 0010)                                                                                                    | request-input nodes, long-running tools and tool confirmation (`workflow/request_input.ts#RequestInput`, `tools/function_tool.ts#ToolOptions`)                                                                             | clean     | read   |
| 15  | Deployment target           | Docker Compose (`docker-compose.yml`)                                                                                                                                                                                | Cloud Run, documented for TypeScript (`adk deploy cloud_run`); Agent Runtime, documented for Python and Go, with an `adk deploy agent_engine` command in `adk-js`'s `dev/src/cli/deploy/cli_deploy_agent_engine.ts`        | partial   | read   |
| 16  | Clinician gate              | an adverse determination is a type only a clinician's attestation constructs, barred from the graph by a lint rule (`@repo/determination/clinician`, ADR 0003)                                                       | tool confirmation pauses at run time for a human; nothing makes an unattested denial fail to compile (`tools/function_tool.ts#ToolOptions`)                                                                                | none      | read   |
| 17  | Run record and audit replay | every decision at the seam plus `memory.retrieve`, beside the checkpoints; `audit:replay` re-executes at the recorded commit (ADR 0007, `docs/STATUS.md` row 27)                                                     | the session event log holds each node's output and each model response; there is no replay at a recorded commit (`sessions/base_session_service.ts#BaseSessionService`)                                                    | partial   | read   |

### What each partial and none loses, and where the draft was wrong

- **2 · State.** ADK has no channels. The trial's adapter folds each node's partial update
  into the whole state by hand and outputs it, which is what LangGraph's last-value
  annotation does for free. Every node event then carries the whole state, and a
  `DatabaseSessionService` persists each one (T3 counted six node events in Postgres for one
  failed run).
- **3 · Retry.** `exceptions` names classes to retry. `retryOn` is a predicate over the
  error. ADK's default retries everything, `ZodError` included, so excluding it means
  listing every retryable class instead. A 4xx is recognised here by its `status`, which no
  list of class names can express (T2).
- **4 · Checkpoint and resume. The draft read `partial`; the trial says `none`, for
  TypeScript.** `ResumabilityConfig` says an invocation can resume "if it's paused or failed
  midway" (`apps/resumability_config.ts`). In 2.2.1 the TypeScript `Runner.runAsync` takes no
  invocation id, and every turn gets a fresh one. `eventsForCurrentRun` keeps prior events
  only for invocations that ended paused on a human-input request, and a failed invocation
  did not. So the outputs `distill` and the nodes before it wrote to Postgres were dropped,
  and the next turn ran all seven nodes again. Python's `Runner.run_async` takes an
  `invocation_id` "to resume" (`src/google/adk/runners.py` at `v2.11.0`); that path was read,
  not run. The two resume models also differ by design: LangGraph restores channel values
  from a snapshot, and ADK replays events and fast-forwards nodes that have outputs.
- **6 · Episodic, redundant with a caveat.** The session log replaces the `episodes` table,
  but not its key: `(session_id, turn_index)` with first-write-wins is what makes a re-sent
  history idempotent, and the A2A executor rebuilds a context from exactly turns `0..n-1`
  (`a2a/history.ts#rebuildHistory`). An append-only event log would need that rule
  restated.
- **7 · Semantic.** The draft's "here" side described Neo4j and pgvector fused by RRF, and
  `searchMemory` lacking a `hopDepth`. At HEAD retrieval is vector-only (ADR 0009) and
  `hopDepth` is gone (`agent/graph/state.ts#AgentStateSchema`). What `searchMemory` lacks is
  a `topK` and a session scope: it is scoped to a user. A custom `BaseMemoryService` over
  `memory-core` would carry both through its own configuration.
- **8 · Single writer.** Here the rule is structural: only `reflect` is handed the writers.
  In ADK any callback or tool can reach the memory service, so the rule becomes a review
  convention again.
- **9 · Model seam.** The seam exists and holds: a replay against `gemini-2.5-flash` served
  two recorded decisions and one tool result, ran no tool, and made no request (T4). Three
  losses. The Gemini client refuses to construct without an API key even when every call is
  short-circuited. `afterModelCallback` is not given the request, so a recorder keys the
  response in `beforeModelCallback`. And a miss does not reach the caller as its error
  class: `runAsync` completed, and the miss arrived as an event with code `UNKNOWN_ERROR`
  (`workflow/node_error_event.ts#createNodeErrorEvent`). The evaluation runner here tells an
  aborted run from a failed one by the class (`eval-abort.json`), so it would have to match
  messages. The runner-wide equivalent of `RunsService.setModelDecorator` is a plugin's
  `beforeModelCallback` (`plugins/base_plugin.ts#BasePlugin`).
- **10 · Tool selection.** Native function calling would replace the JSON prompt, and would
  change the recorded decisions: every cassette is keyed on the prompt (ADR 0005).
- **11 · Evaluation.** `adk.dev/evaluate` marks evaluation "Supported in ADK: Python".
  `adk-js` at `adk-v2.2.1` has no evaluation module. Python's `AgentEvaluator` runs
  `num_runs` and compares `statistics.mean` of the scores with a threshold, which is neither
  `pass@k` nor `pass^k`. A bridge would target `TracedRun` (`runs/runs.service.ts#TracedRun`);
  no PRD owns one.
- **12 · Telemetry. Partial for a reason the draft did not name.** ADK puts the model
  request and response, and tool arguments and results, on spans unless
  `ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS` is `false` or `0`
  (`telemetry/tracing.ts#shouldAddRequestResponseToSpans`). Here content capture is off with
  no switch, and `ALLOWED_SPAN_ATTRIBUTES` fails the run on an unlisted key
  (`.context/conventions.md`, Telemetry). ADK 2.x also opens a span per workflow node
  (`execute_node`), which the draft did not list.
- **15 · Deployment.** The draft said the Agent Platform documents Python only. On this date
  adk.dev's Agent Runtime page marks Python and Go, and its Cloud Run page marks all four
  languages, with `npx adk deploy cloud_run` for TypeScript. `adk-js`'s devtools ship an
  `adk deploy agent_engine` command that adk.dev does not document. None of that deploys a
  NestJS service; each deploys an ADK agent.
- **16 · Clinician gate.** None, and a port would not touch it: the gate is a type in
  `packages/determination` and a lint rule, not a LangGraph feature. Rows 16 and 17 are
  outside the draft's fifteen.
- **17 · Audit replay.** ADK's session log is a trace, like the checkpoints were before
  ADR 0007; it holds no request body, no retried attempt and no commit. A plugin could
  record decisions as the run record does. Replay at a recorded commit would be this
  repository's code either way.

## The trial

Run on 2026-10-08 (20:02–20:06 US Eastern; the output's timestamps are UTC) in a scratch
directory outside the workspace, so nothing ADK-shaped is in the tree. It imports the
compiled node functions from `apps/agent-service/dist`, built with
`yarn turbo build --filter=@repo/agent-service...`, and uses the stub dependency set: the
service's canned `plan`, `distill` and `selectTool`, and no-op memory writers, as
`agent/graph/resume.test.ts` builds them. T3 and T5 used throwaway containers,
`pgvector/pgvector:pg16` on host port 42432 and `neo4j:5-community` on 42687, removed after.
`globalThis.fetch` was wrapped to count and refuse any request to
`generativelanguage.googleapis.com`, and every step prints the count. `GOOGLE_API_KEY` was
unset.

```bash
npm install @google/adk@2.2.1 @mikro-orm/postgresql@^7.2.0   # 198 packages, 150 MB
node t1.mjs && node t2.mjs && node t3.mjs && node t4.mjs && node t5.mjs
```

The adapter T1 to T3 share puts each repository node in a `FunctionNode` whose input and
output are the whole `AgentState`, and gives `act` the route LangGraph's conditional edge
returns:

```ts
new Workflow({
  name: 'agent',
  edges: [
    ['START', ingress, retrieve, plan, act],
    [act, { act, distill }], // act emits createEvent({ output, route: shouldContinueActing(state) })
    [distill, reflect, egress],
  ],
});
```

### T1 · Topology and state — `clean`, `partial`, as drafted

The LangGraph side is `buildAgentGraph` from `dist`, streamed in `updates` mode and folded,
which is how `RunsService.run` drives it; `executeTraced` returns that loop's node sequence.
`toolSteps` makes the stub `selectTool` pick `web-search` that many times before it returns
`null`; at 0 it is the service's stub exactly.

```text
toolSteps=0
  langgraph: ingress > retrieve > plan > act > distill > reflect > egress
  adk:       ingress > retrieve > plan > act > distill > reflect > egress
  sequences identical: true
  final state identical on those fields: true   (outcome success, stepCount 1, 2 messages, 1 fact)
toolSteps=2
  langgraph: ingress > retrieve > plan > act > act > act > distill > reflect > egress
  adk:       ingress > retrieve > plan > act > act > act > distill > reflect > egress
  sequences identical: true
  final state identical on those fields: true   (outcome success, stepCount 3, 2 toolOutputs)
requests to generativelanguage.googleapis.com: 0
```

ADK logs `Class Workflow is experimental and may change in the future` on construction.

### T2 · Retry — `partial`, as drafted

`reflect`'s pgvector write fails as named, under `IO_RETRY` and under two ADK configs, each
with `maxAttempts: 3`.

```text
reflect: transient, twice then ok
  LangGraph IO_RETRY: 3 attempt(s), completed, outcome success
  ADK { maxAttempts: 3 }: 3 attempt(s), completed, outcome success
  ADK { maxAttempts: 3, exceptions: ['Error'] }: 3 attempt(s), completed, outcome success
reflect: ZodError every time
  LangGraph IO_RETRY: 1 attempt(s), threw ZodError
  ADK { maxAttempts: 3 }: 3 attempt(s), threw ZodError, error events 1
  ADK { maxAttempts: 3, exceptions: ['Error'] }: 1 attempt(s), threw ZodError, error events 1
reflect: status 400 every time
  LangGraph IO_RETRY: 1 attempt(s), threw Error
  ADK { maxAttempts: 3 }: 3 attempt(s), threw Error, error events 1
  ADK { maxAttempts: 3, exceptions: ['Error'] }: 3 attempt(s), threw Error, error events 1
requests to generativelanguage.googleapis.com: 0
```

### T3 · Checkpoint and resume — `none` in TypeScript; the draft read `partial`

`DatabaseSessionService` on the throwaway Postgres, `resumabilityConfig: { isResumable: true }`,
`reflect` failing on every attempt. The TypeScript `Runner` has no other way to resume than
another `runAsync` on the same session.

```text
attempt 1 (store down): ingress > retrieve > plan > act > distill > reflect > reflect > reflect
  result: threw EHOSTUNREACH: postgres went away; distill calls so far: 1
  session in Postgres: 7 events, 6 with a node path
  node paths with an output: retrieve, ingress, distill, act, plan
  events carrying an error: 1
attempt 2, same session, same message (store back): ingress > retrieve > plan > act > distill > reflect > egress
  result: completed, outcome success; distill calls so far: 2
attempt 3, same session, a continue message: ingress > retrieve > plan > act > distill > reflect > egress
  result: completed, outcome success; distill calls so far: 3
distill calls in total: 3 (LangGraph on the same thread_id: 1, agent/graph/resume.test.ts)
requests to generativelanguage.googleapis.com: 0
```

The mechanism, not only the count: the outputs were in Postgres, and ADK chose not to use
them, because `eventsForCurrentRun` treats an invocation that emitted node events without
pausing for input as finished. LangGraph's answer is one `distill` call because it resumes
the thread from its last checkpoint. That is the property that made `distill` a node of its
own (`.context/architecture.md`, LangGraph Topology): a second extraction can word a fact
differently, change its hash, and land a second row.

### T4 · The cassette seam — `partial`, as drafted

An `LlmAgent` with one `FunctionTool`, recorded against a scripted `BaseLlm` and replayed
against `model: 'gemini-2.5-flash'` with `beforeModelCallback` and `beforeToolCallback`
serving the recording, keyed on a SHA-256 of the request's contents.

```text
record: answer "LangGraph is a library for stateful agent graphs.", scripted model calls 2, tool executions 1
  cassette: 2 model decisions, 1 tool result
replay: answer "LangGraph is a library for stateful agent graphs.", decisions served 2, tool executions 0
  identical answer: true
miss: runAsync did not throw; answer undefined; error event: UNKNOWN_ERROR no recorded decision for request fe99c70fda0e
requests to anything during replay: 0
requests to generativelanguage.googleapis.com: 0
```

The first attempt failed before any callback ran: `API key must be provided via constructor
or the GOOGLE_GENAI_API_KEY, GOOGLE_API_KEY or GEMINI_API_KEY environment variable`. The
recorded run sets `GOOGLE_GENAI_API_KEY=not-a-key`, which is not a key, and the guard
refuses the host regardless.

### T5 · Integrate over A2A — `clean`, as drafted

The service ran from `dist` on port 43000 with `SERVICE_CREDENTIALS` set to one principal,
`adk`, so authentication was enforced (`auth.enforced` at boot), on the stub model axis and
the live memory axis. The client is an ADK for TypeScript `RemoteA2AAgent` in an
`InMemoryRunner`, whose `ClientFactory` uses a `JsonRpcTransportFactory` with a `fetchImpl`
that adds `Authorization: Bearer <token>`. TypeScript ran; no Python fallback was needed.

```text
card URL as agentCard, with token
  threw Error: Failed to fetch Agent Card from http://localhost:43000/.well-known/.well-known/agent-card.json: 401
base URL as agentCard, with token
  wire: POST /a2a/jsonrpc rpc=message/stream A2A-Version=(none) -> 200
  event: author=agent_service text="I will research this topic and provide a comprehensive answer based on the available context."
    a2a:response kind=artifact-update artifact=answer
  event: author=agent_service text="{\"runId\":\"683d4015-…\",\"outcome\":\"success\",…,\"messageCount\":1,\"retrievedCount\":0}"
    a2a:response kind=artifact-update artifact=run
  tasks/get 683d4015-fd0b-4727-a0df-36f6903115c5: state=completed artifacts=answer,run history=1
base URL as agentCard, without a token
  wire: POST /a2a/jsonrpc rpc=message/stream A2A-Version=(none) -> 401
  event: author=agent_service error=undefined HTTP error establishing stream for message/stream: 401 Unauthorized.
requests to generativelanguage.googleapis.com: 0
```

**Yes: an ADK for TypeScript `RemoteA2AAgent` completed a task against P5-A's server with
authentication enforced, speaking A2A v0.3.** It sent the v0.3 method `message/stream` with
no `A2A-Version` header, which the server serves on its v0.3 path. The task id is the run
id: the throwaway Postgres held a `run_records` row for it, `graph` `chat`, `model_axis`
`stub`, outcome `success`, and nine checkpoints under it as `thread_id`. Without the token
the same call was refused with 401.

One finding for whoever wires this up. `RemoteA2AAgentConfig.agentCard` is documented as the
"URL to AgentCard", and the 0.3 SDK's resolver appends `.well-known/agent-card.json` to it,
so the card's own URL doubles the path. Pass the service's base URL, or a fetched card
object. The doubled path answered 401 rather than 404 because the server denies by default
every route it does not exempt (ADR 0014).

## Integrate, don't port

An ADK or Gemini Enterprise estate that wants this agent calls it, as T5 did:

- **Discovery.** `GET /.well-known/agent-card.json`. With no `A2A-Version` header the server
  answers the v0.3 card, unsigned, which is what ADK for TypeScript 2.2.1 reads; with
  `A2A-Version: 1.0` it answers the v1.0 card, signed when `A2A_CARD_SIGNING_KEYS` is set, as
  it is on the compose stack (`.context/architecture.md`, Agent2Agent). The trial's service
  had no signing key.
- **Credential.** A bearer token issued out of band, whose SHA-256 digest is listed in
  `SERVICE_CREDENTIALS` under a principal name for the calling estate (ADR 0014). ADK passes
  it through the `fetchImpl` of the A2A client's transport factory.
- **Conversation.** Reuse the `contextId` the first task returned; the history is rebuilt
  from episodic memory per principal, so two estates never share a conversation.
- **What the caller gets.** An `answer` artifact and a `run` artifact whose `runId` is the
  key to the run record, the checkpoints and the ledger entry, so an auditor on this side can
  replay what the caller saw.

Porting would buy the same interoperability, which is already there, and pay for it with
rows 4, 9, 11 and 17.

## Why the repository stays on LangGraph

[ADR 0001](../adr/0001-langgraph-over-a-durable-execution-engine.md) chose LangGraph's
checkpointer because it reuses the Postgres already provisioned, and named it as "the
substrate P3-B's audit replay is built on". It names two revisit conditions. Neither holds at
HEAD.

> **Revisit if** a single run starts spanning minutes with external callbacks, …

**Does not hold.** A chat run completes inside the request that started it, and every A2A
task ends `COMPLETED` or `FAILED` in the exchange that created it (`.context/architecture.md`,
Agent2Agent, "Every task ends terminal"; `a2a/run-executor.ts#RunExecutor`). The one
workflow that does span days, a prior authorization waiting on a clinician, lives in
`prior_auth_cases` above the graph, which ends at `dispose` inside the `$submit` exchange
(ADR 0010; `.context/architecture.md`, The Prior-Authorization Case Layer).

> … or the system grows fan-out across agents with independent failure domains.

**Does not hold.** The service calls no other agent. Its A2A surface is a server only: at
HEAD, `git grep -n "sdk/client" -- 'apps/*/src/*' 'packages/*/src/*'` returns nothing. T5 is
another agent calling in, which is fan-in to one failure domain, not fan-out.

The argument that does not depend on ADK being weaker: T1 shows ADK 2.x maps the graph
cleanly, and T2 shows retry maps with a loss a careful port could work around. If the case
rested on topology it would be gone. It rests on three things. The checkpoint model a port
would give up is the one P3-B's replay and the `distill`/`reflect` split are built on, and
ADK for TypeScript 2.2.1 does not resume a failed run (T3). The evaluation harness has no
TypeScript counterpart, and Python's evaluator does not report `pass^k`. And A2A already
gives an ADK estate what a port would (T5). So the repository stays on LangGraph for cost and
for ADR 0001, not because ADK cannot express the agent.

## What would change the answer

Each is a condition someone could observe, not an intention:

- **ADR 0001's revisit conditions become true**: a run that waits minutes on an external
  callback, or this service calling other agents with failure domains of their own.
- **ADK for TypeScript resumes a failed invocation.** A `Runner.runAsync` that takes an
  invocation id, as Python's does, and fast-forwards the nodes that completed, would move
  row 4 to `partial` and remove the largest cost of a port. Re-run T3 to check.
- **ADK for TypeScript gains an evaluation module that reports `pass^k`**, or something a
  per-task all-trials-pass rate can be computed from. Row 11 would move off `none`.
- **Agent Runtime documents a TypeScript deployment path.** Today adk.dev marks Python and
  Go, and `adk-js` ships an undocumented `adk deploy agent_engine`. A documented path, and a
  requirement to run there, would make a TypeScript ADK agent the cheaper thing to deploy
  than this service.
- **A requirement appears for a Google-managed memory** (Memory Bank). Rows 6 and 7 would
  move to `redundant`, which would reopen ADR 0009, the record that superseded ADR 0002.
