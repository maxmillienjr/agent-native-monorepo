---
id: P2-C
title: OpenTelemetry GenAI semantics, including evaluation events
tier: 2
status: accepted
size: L
depends_on: [P1-A, P1-B]
blocks: [P1-F]
issue: null
superseded_by: null
controls: [CTL-OBS-01]
---

# P2-C · OpenTelemetry GenAI semantics, including evaluation events

## Problem

The service emits spans, but none of them uses the OpenTelemetry GenAI vocabulary, none
of them covers a model call, and one run does not produce one trace.

**A run is seven traces.** Every node opens its span with `tracer.startActiveSpan` and
nothing opens a span around the graph: `RunsService.execute` calls `compiled.invoke`
directly (`runs.service.ts:283-292`), and so do `executeTraced` (`:310-340`) and `stream`
(`:342-385`). Nothing upstream supplies a parent either. `initTelemetry` builds a
`NodeSDK` with a resource and a trace exporter and no `instrumentations`
(`packages/telemetry/src/otel.setup.ts:18-23`), and `NodeSDK` registers none by default
(`@opentelemetry/sdk-node@0.222.0`, `build/src/sdk.js:151`:
`configuration.instrumentations?.flat() ?? []`), so there is no HTTP server span for a node
span to hang off. Measured, not inferred: one `buildAgentGraph(...).invoke` under an
in-memory exporter, with the context manager `spans.test.ts:26-35` registers, produced
seven spans — `agent.node.ingress` through `agent.node.egress` — carrying seven different
trace ids and no parent. Wrapping the same `invoke` in one active span put all seven into
that span's trace as its children, so LangGraph propagates the context and the missing
piece is the root. `.context/glossary.md:52` defines a trace as "a tree of spans
representing one complete request"; at HEAD a request is a forest.

**The model call has no span of its own, and two of three have no usage anywhere.**
`plan` records `prompt_tokens` and `completion_tokens` on the node span
(`plan.node.ts:39-40`). The Gemini client computes the same pair for every call
(`runs.service.ts:204-218`), and then `selectTool` (`:227-238`) and `extractEntities`
(`:240-245`) return the parsed value and drop it. `plan.node.ts:49-52` is the only writer
of `state.tokenCounts`, so `RunResponse.tokenCounts`
(`packages/agent-contracts/src/run-response.schema.ts:15`) counts one call in three. The
cassette recorder inherits the gap and says so (`cassette-deps.ts:62-74`): in the committed
set, `plan.callLlm` carries `{"prompt":58,"completion":922}` for `memory-recall-001` and
`{"prompt":68,"completion":217}` for `tool-use-001`, and every `act.selectTool` and
`distill.extractEntities` decision carries none. The embedder reads a response typed as
`{ embedding?: { values?: number[] } }` (`gemini-embedder.ts:49`) and records nothing.

**No attribute uses the standard names.** Across `apps/agent-service` and
`packages/memory-core` the attribute keys are `run_id`, `session_id`, `prompt_tokens`,
`tool.name`, `candidateCount`, `topK` and similar; a grep for `gen_ai` over both finds
none. A GenAI-aware backend therefore sees no model, no provider, no operation and no
usage in this service's traces.

**Two things the rest of the repository assumes do not exist.** `CLAUDE.md:11-12` tells
an author to "use the span helpers in packages/telemetry"; the package exports
`initTelemetry`, `shutdownTelemetry`, `getTracer` and three logger functions and nothing
else (`packages/telemetry/src/index.ts:1-2`), and `.context/workflows.md:30-44` shows the
raw `startActiveSpan` pattern instead. `Transcript.spans` is declared
(`packages/eval-harness/src/types.ts:118-121`, `:135-140`) and never filled:
`AgentServiceHarness.run` builds the transcript without it (`agent-harness.ts:135-157`),
and `run-eval.ts` never initialises telemetry, so every span in an evaluation process goes
to the no-op tracer.

**The evaluation-event plan was written against an API that is being deprecated.** The
`Score` comment says P2-C will "emit these as span events with no translation layer"
(`types.ts:145-147`, and `P1-A-eval-harness.md:127-129`). OpenTelemetry has since
announced the deprecation of `Span.AddEvent` in favour of log-based events emitted through
the Logs API (OTEP 4430). `gen_ai.evaluation.result` is defined as a named event — a log
record — that "SHOULD be parented to GenAI operation span being evaluated".

**Content that the conventions keep off by default is already on spans.**
`memory.neo4j.mergeEntity` records `entity.id` (`neo4j.writer.ts:43`) and
`memory.neo4j.mergeRelationship` records `relationship.type`, `.fromId` and `.toId`
(`:118-120`). All four are produced by the model from the conversation
(`reflect.node.ts:66-76`). ADR 0003 makes real PHI the boundary for this repository, and in
the payer domain Tier 3 targets an extracted entity id can be a member's name.

**P2-A handed this PRD a rename it can no longer do literally.** `P2-A-wire-memory-core.md:148-149`
says renaming the `memory.*` spans "to `gen_ai.*` is **P2-C**". The conventions define no
`gen_ai.*` span names; they define `gen_ai.operation.name` values, including
`search_memory` and `upsert_memory` for memory operations.

## Why it matters

The OpenTelemetry GenAI semantic conventions are the shared schema that LLM observability
products read — model, provider, operation, token usage, finish reason, agent and tool
structure, and evaluation results — and emitting them is what turns "we have spans" into
"any GenAI-aware backend can show cost per call and a trial's graded result against the
trace that produced it". For this repository two consumers are close and named. P1-F turns
cost and latency into CI assertions and needs per-call usage that today exists for one call
in three. And an evaluation harness whose results arrive as `gen_ai.evaluation.result`
events on the trace of the run they grade is the standard shape for connecting offline
evaluation to production telemetry — the thing P1-A's `Score` was shaped for. The part
worth being exact about is that these conventions are in Development status and moving:
knowing what the pinned version is, what happens when it changes, and why content capture
stays off in a payer domain is the difference between adopting a standard and copying its
attribute names.

## Scope

- **One trace per run.** An `invoke_agent` root span opened by `RunsService` around the
  graph on all three entry points, with every node span as its child.
- **Inference and embeddings spans** at the Gemini client, one per `generateContent` and
  per `embedContent` call, carrying the Required and applicable Recommended attributes —
  including usage for all three chat seams, not only `plan`.
- **`execute_tool` spans** around tool execution in `act`, and `gen_ai.operation.name` on
  the existing node and memory spans where a convention value applies (`plan`,
  `search_memory`, `upsert_memory`).
- **Span helpers in `packages/telemetry`**, published at `@repo/telemetry/genai`: the
  attribute constants, pinned to one convention commit, and the wrappers that open, record
  errors on and end these spans. This makes `CLAUDE.md:11-12` true.
- **Replay spans.** On the `replay` model axis the inference spans are emitted from the
  cassette, carrying the recorded usage where the cassette has it and marked as replayed.
- **Content capture off, and enforced by a test.** No `gen_ai.input.messages`,
  `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments` or
  `gen_ai.tool.call.result`; the four content-derived memory attributes above removed.
- **`Transcript.spans` filled** for every trial on every axis, from an in-memory exporter
  the evaluation process registers, and `SpanRecord` widened to carry what a consumer needs
  to rebuild the tree.
- **`gen_ai.evaluation.result` events**, one per grader per trial, emitted as log-based
  events through the Logs API and parented to the trial's `invoke_agent` span.
- `OTEL_EXPORTER_OTLP_ENDPOINT` declared on `turbo.json`'s `eval` task, so an evaluation
  run can export its traces and events when an endpoint is configured.
- The docs that describe telemetry made true: `docs/STATUS.md` gains a row,
  `.context/glossary.md:52` and `.context/workflows.md:30-44` are corrected, the pin and the
  upgrade procedure are recorded in `.context/conventions.md`, and the `Score` comment and
  `packages/eval-harness/README.md:165-166` stop promising span events.

### Non-goals

- **Budgets, and deciding what a run's token total is.** P2-C puts usage on each inference
  span. Summing it per run, asserting a budget on it, deciding whether
  `RunResponse.tokenCounts` should become the run's total rather than `plan`'s, and reading
  latency on the replay axis without mistaking replay speed for the agent's are **P1-F**'s.
  So is recording usage for `act.selectTool` and `distill.extractEntities` into cassettes:
  the hook exists (`tokenCountsFor`, `cassette-deps.ts:70-74`), and filling it means a
  re-recording that P1-F is the reason for.
- **Opt-in content capture.** The conventions' recommended production pattern for content
  is to store it outside telemetry under separate access control and put a reference on the
  span. In this repository that store is the decision ledger, and the access model is
  ADR 0003's — **P3-C**. This PRD ships no switch; it ships the test that fails if content
  appears.
- **Audit reconstruction.** A trace is sampled, lossy and unsigned; it is not the record of
  what a run did. **P3-B** reconstructs runs from checkpoints and **P3-C** makes the ledger
  tamper-evident.
- **Cross-service propagation and HTTP server spans.** `apps/gateway` initialises its own
  SDK (`apps/gateway/src/server.ts:6`) and no instrumentation is registered on either side,
  so a gateway request and the run it causes are separate traces. The first PRD with a
  second agent calling this one over HTTP is **P5-A**, and it inherits W3C context
  propagation. This PRD's root span is the run, not the request.
- **GenAI metrics** (`gen_ai.client.token.usage`, `gen_ai.client.operation.duration`).
  Rejected rather than deferred: the SDK is configured with a trace exporter only
  (`otel.setup.ts:22`), nothing in the repository reads a metric, and P1-F reads spans.
- **Renaming existing span names and non-GenAI attributes.** Span names are `SHOULD` in the
  conventions and `gen_ai.operation.name` is `Required`; the `agent.node.*` and `memory.*`
  names are public vocabulary (`.context/workflows.md:54-55`) asserted by
  `spans.test.ts:114-127` and cited by `docs/STATUS.md` row 13. They keep their names and
  gain the operation attribute. New spans use the convention names because nothing depends
  on them yet. Namespacing `run_id`, `candidateCount` and the rest is rejected: it breaks
  those assertions for no change in meaning.
- **Span links to cassettes or checkpoints**, and an `invoke_workflow` span above
  `invoke_agent`. Neither has a consumer.

## Design

### The convention version, and what happens when it moves

The GenAI conventions moved out of `open-telemetry/semantic-conventions`. The last core
release that carries them is `v1.41.1` (2026-05-11); from `v1.42.0` (2026-06-12) through
`v1.44.0` (2026-08-04) `docs/gen-ai/gen-ai-spans.md` is a "Moved" notice and `model/gen-ai`
holds only `deprecated/`. They now live in `open-telemetry/semantic-conventions-genai`,
whose `model/manifest.yaml` declares `stability: development`,
`schema_url: https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev`, and a dependency on
core `v1.44.0`. That repository has **no release tag yet** — `git ls-remote --tags` returns
nothing, and `RELEASING.md` describes a `vX.Y.Z-dev` tag scheme that has not been used —
and it moves quickly: fifty commits between 2026-07-28 and 2026-09-24, ten of them to
`gen-ai-spans.md`.

**This PRD designs against commit `e57c543b4889619eb2a05702471937db5119165d`
(2026-09-24).** Every attribute name and value below is read from that commit.

The npm package cannot be the pin. `@repo/telemetry` depends on
`@opentelemetry/semantic-conventions ^1.43.0` (`packages/telemetry/package.json:20`), and
at 1.43.0 its `/incubating` entry still exports the `ATTR_GEN_AI_*` constants — each marked
`@deprecated Moved to the OpenTelemetry GenAI semantic conventions repository`
(`build/src/experimental_attributes.d.ts:5937` onward) — and is already behind the
source: its `gen_ai.operation.name` values (`:6219-6289`) have no `plan`, which the pinned
commit defines. So the names are spelled once, as string literals, in
`packages/telemetry/src/genai.ts`, next to the commit they came from:

```ts
/** The GenAI conventions this repository emits. Bump deliberately; see .context/conventions.md. */
export const GENAI_SEMCONV = {
  repository: 'https://github.com/open-telemetry/semantic-conventions-genai',
  commit: 'e57c543b4889619eb2a05702471937db5119165d',
  schemaUrl: 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev',
} as const;

export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  // ... every key this repository emits, and no other
} as const;
```

The tracer every helper uses is obtained with `schemaUrl: GENAI_SEMCONV.schemaUrl`, which
is the OTLP-native way for a backend to know which names a scope follows.

When the conventions change:

- **Nothing changes until someone bumps the commit.** Emission is pinned; a rename
  upstream is not a defect here.
- **A bump is a pull request that edits `genai.ts` and nothing it does not have to.** The
  attribute-allowlist test (below) and the per-span conformance assertions fail on any
  renamed or removed key, so the bump cannot be silent.
- **No dual emission.** The core conventions' `OTEL_SEMCONV_STABILITY_OPT_IN` transition
  pattern exists for downstream dashboards that cannot move in lockstep. This repository's
  only downstream reader is P1-F, which reads through the same constants, so it moves in
  the same commit.
- **Re-pin to a tag when one exists.** The first `v*-dev` release of the GenAI repository
  replaces the commit with the tag, in a pull request of its own.

### The trace a run produces

| Span                                | Kind     | Opened by                         | `gen_ai.operation.name` |
| ----------------------------------- | -------- | --------------------------------- | ----------------------- |
| `invoke_agent agent-service`        | INTERNAL | `RunsService`, around the graph   | `invoke_agent`          |
| `agent.node.<name>` × 7             | INTERNAL | each node (unchanged names)       | `plan` on `plan` only   |
| `generate_content gemini-2.5-flash` | CLIENT   | the chat client, one per call     | `generate_content`      |
| `embeddings gemini-embedding-001`   | CLIENT   | the embedder, one per call        | `embeddings`            |
| `execute_tool <tool>`               | INTERNAL | `act`, around `tool.execute`      | `execute_tool`          |
| `memory.pgvector.search`, `.expand` | INTERNAL | `memory-core` readers (unchanged) | `search_memory`         |
| `memory.pgvector.upsert`, `.merge*` | INTERNAL | `memory-core` writers (unchanged) | `upsert_memory`         |

`invoke_agent` is the internal-agent variant: the conventions give LangChain agents as the
example of an in-process agent, and the kind is `INTERNAL`. Its attributes are
`gen_ai.agent.name` (`agent-service`, set at creation because it is sampling-relevant) and
`gen_ai.conversation.id` — the request's `sessionId`, which is exactly the "identifier for
the conversation readily available" the convention asks for, since episodic memory is keyed
on it. The session id is known only after `ingress` validates the body, so it is set when
the run finishes; only the operation name and agent name are needed at creation. The run
id rides along as `agent_native.run_id`, in a namespace of this repository's own.

`agent.node.plan` gains `gen_ai.operation.name = plan`: the Plan span is to be reported
"when [the instrumentation] can reliably determine that the operation being instrumented is
planning", and a node named `plan` whose output is `currentPlan` is that case. The
convention asks for the model call that produces the plan to be its child, which it already
is. `prompt_tokens` and `completion_tokens` leave the node span, because usage now lives on
the inference span and a consumer summing `gen_ai.usage.*` must not find it twice.
`tool.name` (`act.node.ts:59`) moves to `execute_tool` as `gen_ai.tool.name`, where it is
also recorded when the tool throws — today it is set only after a successful `execute`.

`search_memory` and `upsert_memory` are the operation values P2-A's deferred rename
resolves to. The memory-span convention's span name is `{gen_ai.operation.name}` and it is a
`SHOULD`; the names stay for the reason in the non-goals.

`EpisodicRepository.write` has no span today and gains none; the episodic write is covered
by `agent.node.reflect`.

### Where the inference span is opened, and why not at the seam

At the client, inside `createGeminiModelDeps` (`runs.service.ts:196-248`) and
`createGeminiEmbedder` (`gemini-embedder.ts:30-60`), around `llm.invoke` and `fetch`.

The alternative — opening it at the `ModelDeps` seam, above the cassette decorator — would
put it on every axis for free, and that is the problem with it. On the stub axis it would
emit a span saying `gen_ai.provider.name = gcp.gemini` for a canned string, with the stub's
fixed `{ prompt: 150, completion: 45 }` (`runs.service.ts:259`) as usage. A span opened
where the client is exists exactly when a client does. It is also the only place the raw
response is in reach: finish reasons and total token counts are on the LangChain message,
not on the parsed value a seam returns.

```ts
export interface InferenceRequest {
  readonly operation: 'generate_content' | 'embeddings';
  readonly model: string;
  /** Which decision seam made the call — the cassette vocabulary, so P1-F can attribute cost. */
  readonly seam: 'plan.callLlm' | 'act.selectTool' | 'distill.extractEntities' | 'embed';
  readonly outputType?: 'text' | 'json';
}

export interface InferenceSpan {
  recordUsage(usage: { input?: number; output?: number; reasoningOutput?: number }): void;
  recordFinishReasons(reasons: readonly string[]): void;
  markReplayed(): void;
}

/** Opens a CLIENT span named `{operation} {model}`, records error.type and ERROR status on a throw, rethrows, ends. */
export function withInferenceSpan<T>(
  request: InferenceRequest,
  fn: (span: InferenceSpan) => Promise<T>,
): Promise<T>;
```

Attributes on every inference span: `gen_ai.operation.name`,
`gen_ai.provider.name = gcp.gemini` (the value the conventions reserve for the
`generativelanguage.googleapis.com` endpoint, which is the one both clients call),
`gen_ai.request.model`, `server.address`, `server.port`, `gen_ai.output.type` where the
request asked for JSON, and `agent_native.seam`. After the call: `gen_ai.usage.input_tokens`,
`gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons`. On embeddings:
`gen_ai.embeddings.dimension.count` from `EMBEDDING_DIMENSIONS`. On a throw:
`error.type` — the HTTP status where the error carries one (the shape `retry.ts:10-15`
already reads), otherwise the error's name.

Two Recommended attributes are left out, with the reason recorded next to the constant:

- **`gen_ai.response.model`.** Gemini returns `modelVersion` at the top level of the
  response. `@langchain/google-genai@0.2.18` builds the message from the first candidate
  and `usageMetadata` only (`dist/chat_models.js:661-672`, `dist/utils/common.js:384-441`),
  and the pinned `@google/generative-ai@0.24.1` type does not declare the field. P5-C's
  client upgrade does not change that: P1-E found that `@langchain/google-genai@2.3.2`
  still drops `modelVersion`. P1-E's canary reads it from a direct call; recording it on
  every inference span would need the client to surface it, and no PRD owns that.
- **Embedding usage.** The `embedContent` response the embedder reads has no usage block
  (`gemini-embedder.ts:49`). Absent is recorded as absent; it is never estimated and never
  zero.

**Output tokens need one derivation, and it is unverified.** LangChain maps
`output_tokens` to `candidatesTokenCount` and `total_tokens` to `totalTokenCount`
(`chat_models.js:664-667`). `gemini-2.5-flash` is a thinking model; its thought tokens are
billed as output and reported in a separate `thoughtsTokenCount`, which neither the pinned
SDK type nor LangChain surfaces. The conventions say reasoning tokens "SHOULD be included in
`gen_ai.usage.output_tokens`". The wrapper therefore records
`output = total − input` and `reasoning.output = total − input − candidates` when
`total_tokens` is present, and the plain candidate count otherwise. That arithmetic assumes
`totalTokenCount` is the sum of the three, which this PRD has not observed on a live
response; the second live criterion below checks it.

A retried node is a second logical operation and gets a second node span and a second
inference span; the first carries `error.type`. That is consistent with the convention,
which asks one span to cover a client's own automatic retries — LangChain's
`completionWithRetry` runs inside `llm.invoke`, so those are inside the span.

### The replay axis: recorded usage, marked

On `replay` no model client exists (`cassette-deps.ts:107-152`), so no client span can be
opened. Two answers are possible, and this PRD takes the second.

- **None.** Honest in the narrowest sense — no call happened. But it makes the shape of
  `Transcript.spans` depend on the axis, so any span-reading grader would need
  `requires: { model: 'live' }` and would skip on the only tier cheap enough to run on every
  pull request; and it leaves P1-F's cost budget with no input on that tier.
- **Recorded values, marked.** `replayModelDeps` opens the same `withInferenceSpan` around
  each `deck.resolve`, with the request model taken from the cassette header, calls
  `markReplayed()` — `agent_native.replayed = true` — and records the decision's recorded
  `tokenCounts` when it has them. Token usage is a property of the request-and-response
  pair, which is exactly what a cassette freezes; the recording measured it. Duration is
  not such a property, and the span's duration on replay is replay speed — P1-F owns not
  reading it as the agent's.

What the replayed spans say, against the committed set: `plan.callLlm` carries
`input_tokens` 58 and `output_tokens` 922 for `memory-recall-001`, and 68 and 217 for
`tool-use-001`. `act.selectTool` and `distill.extractEntities` carry **no usage keys** —
not zero, which would be a claim — because the cassettes recorded none. No finish reasons,
because none were recorded either. And because the recording predates this PRD, the
recorded `completion` is `candidatesTokenCount`, not the derived output above; a replayed
`output_tokens` undercounts a thinking model until the set is re-recorded, which is P1-F's.

`CassettePlayer` gains one option so the wrapper can see the decision it served:

```ts
/** Called synchronously with each decision as it is served, inside `resolve`. */
readonly onServe?: (decision: Decision) => void;
```

It fires inside the active inference span, so `cassette-deps.ts` sets the recorded usage on
`trace.getActiveSpan()`. The same hook marks the `execute_tool` span replayed at the
`act.tool` seam. The package keeps `zod` as its only runtime dependency.

The stub axis emits no inference or embeddings spans at all.

### Content capture stays off, and a test holds it there

The conventions: instrumentations "SHOULD NOT capture [instructions, inputs, outputs] by
default, but SHOULD provide an option for users to opt in", naming
`OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` as an example switch. This PRD ships
the default and not the option, for the reason in the non-goals: in a payer domain the
option's only acceptable implementation is the external-store pattern, and that store is
P3-C's.

"Off" has to be more than the absence of code, because content already leaks through
attributes nobody labelled as content. The enforcement is an **allowlist**: a test runs a
full graph under an in-memory exporter, plus the client wrappers against fake responses,
and asserts that every attribute key on every span is in `ALLOWED_SPAN_ATTRIBUTES`, a
constant beside `GEN_AI`. The list contains none of the Opt-In content keys and none of the
four model-derived memory attributes, which this PRD removes (`neo4j.writer.ts:43`,
`:118-120`; the counts on the node span stay). A new attribute therefore needs a deliberate
edit to one list, which is where a reviewer asks whether it carries content. The test runs
with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true` set, to show the variable is
not read.

`fact.contentHash` (`pgvector.writer.ts:29`, `neo4j.writer.ts:81`) stays: it is a sha256,
it is the key the whole write path is idempotent on, and removing it would cost the trace
its join to the stores. A hash of a short fact is guessable by enumeration; that is recorded
as a risk rather than solved here.

### `Transcript.spans`

`SpanRecord` (`types.ts:118-121`) widens to what a consumer needs to rebuild the tree
without an OTel dependency:

```ts
export interface SpanRecord {
  readonly name: string;
  readonly kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly startTimeUnixMs: number;
  readonly durationMs: number;
  readonly status: 'unset' | 'ok' | 'error';
  readonly attributes: Readonly<Record<string, unknown>>;
}
```

The collection sits on the application side of `AgentHarness`, where the package boundary
already puts everything that knows about the service (`agent-harness.ts:26-37`).
`run-eval.ts` initialises telemetry with an in-memory span exporter behind a
`SimpleSpanProcessor` — through `initTelemetry`, which gains an options form, so the
context manager `NodeSDK` registers is present and spans nest (`spans.test.ts:27-30` records
what happens without one). `TracedRun` gains the root span's `traceId`; `run` keeps the
finished spans with that trace id and resets the exporter. Filtering by trace rather than
taking everything drops `memory.inspect.run` and the seed spans
(`run-inspector.ts:53`, `seed-manager.ts:77`, `:100`), which belong to the harness's own
reset and capture, not to the run under evaluation.

`renderJsonReport` serialises the whole report (`reporters/json.ts:15-17`), so the spans
land in `eval-report.json` with no reporter change — tens of records a trial, most of
them `embeddings` and `upsert_memory` spans, one per distilled fact.

When `OTEL_EXPORTER_OTLP_ENDPOINT` is set, the evaluation process also exports over OTLP.
It is declared on `turbo.json`'s `eval` task (`:40-52`) in the same change: Turbo runs in
strict env mode, and P1-B found two documented variables that never reached this task.

### Evaluation events

One `gen_ai.evaluation.result` event per `GraderResult`, emitted by `EvalHarness.run` after
`runGraders` (`harness.ts:131-133`) through `@opentelemetry/api-logs`:

| Attribute                       | From                              |
| ------------------------------- | --------------------------------- |
| `gen_ai.evaluation.name`        | `GraderResult.grader`             |
| `gen_ai.evaluation.score.value` | `Score.value`                     |
| `gen_ai.evaluation.score.label` | `Score.label` (`pass` / `fail`)   |
| `gen_ai.evaluation.explanation` | `Score.explanation`, when present |
| `agent_native.eval.task_id`     | `Trial.taskId`                    |
| `agent_native.eval.trial_index` | `Trial.index`                     |
| `agent_native.eval.grader_kind` | `GraderResult.kind`               |
| `agent_native.model_axis`       | `SuiteReport.axes.model`          |
| `agent_native.memory_axis`      | `SuiteReport.axes.memory`         |

**Parented to the run.** The event's context is the trial's `invoke_agent` span, rebuilt
from the transcript's root `SpanRecord` with `trace.setSpanContext`. That span has ended by
the time grading runs; an event carries a trace and span id, not a live span, so that is
allowed. The graders judge the run — its trajectory and its writes — so the run is the
"GenAI operation span being evaluated". A transcript with no root span (another
`AgentHarness` implementor) produces unparented events, which the convention permits by
falling back to `gen_ai.response.id`; this repository has no response id to offer and says
so in the helper.

**The axes travel with the result.** A replayed `pass` is a frozen sample (ADR 0005), and
an event stream that did not say which axis produced it would let a dashboard average a
replayed score with a live one — the same failure `SuiteReport.axes` exists to prevent.

**Log records, not span events.** `Span.addEvent` is the API OTEP 4430 deprecates, and the
convention defines the evaluation result as an event in the Logs data model. The `Score`
comment that promised span events is corrected in the same change.

`packages/eval-harness` gains `@opentelemetry/api` and `@opentelemetry/api-logs` as
dependencies — API packages that are no-ops without an SDK, so a consumer that registers
nothing pays nothing — and imports the names from `@repo/telemetry/genai`, a subpath
export that pulls in the API and not `sdk-node`.

### What P2-C provides P1-F, and what it does not

| P2-C provides                                                                 | P1-F owns                                                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Usage on each live inference span, all three chat seams, tagged with the seam | Summing it per run, and the budget                              |
| Recorded usage on replayed spans where the cassette has it, marked `replayed` | Re-recording so `selectTool` and `distill` have usage on replay |
| Span durations in `Transcript.spans`                                          | Not reading a replayed duration as latency                      |
| The attribute constants, pinned                                               | Reading through them rather than through string literals        |
| —                                                                             | Whether `RunResponse.tokenCounts` becomes the run total         |

### Layout

```
packages/telemetry/src/
  genai.ts            GENAI_SEMCONV, GEN_AI, ALLOWED_SPAN_ATTRIBUTES,
                      withInferenceSpan, withToolSpan, withAgentSpan, withNodeSpan
  genai.test.ts
  otel.setup.ts       initTelemetry(options) — processors, optional OTLP
  package.json        exports "./genai"

apps/agent-service/src/
  runs/runs.service.ts           invoke_agent root; client-level inference spans
  agent/model/gemini-embedder.ts embeddings spans
  agent/nodes/*.node.ts          withNodeSpan; plan operation; act execute_tool
  agent/graph/spans.test.ts      one trace, the allowlist, the conformance assertions
  eval/cassette-deps.ts          replayed inference spans via onServe
  eval/agent-harness.ts          Transcript.spans
  eval/run-eval.ts               in-memory processors; optional OTLP

packages/agent-cassette/src/player.ts   onServe
packages/eval-harness/src/
  types.ts            SpanRecord; the Score comment
  telemetry.ts        emitEvaluationResults
  harness.ts          calls it after runGraders
packages/memory-core/src/semantic/neo4j/neo4j.writer.ts  content-derived attributes out
```

`withNodeSpan` also records `error.type` and ERROR status when a node throws; today a node
that throws ends its span with status unset, because every node closes in a bare `finally`.

## Acceptance criteria

Each criterion names the model axis it is verified on. "Fakes" means in-process fakes for
every dependency — a unit test, on neither axis — and verifies a mapping, not a client.

- [ ] `@repo/telemetry/genai` exports `GENAI_SEMCONV` naming commit
      `e57c543b4889619eb2a05702471937db5119165d`, the `GEN_AI` constants, and the four
      helpers, and importing it does not load `@opentelemetry/sdk-node`. Unit test.
- [ ] A graph run produces exactly one trace: `spans.test.ts` asserts one distinct trace id
      across every exported span, and that each `agent.node.*` span's parent is the
      `invoke_agent agent-service` span, which has kind INTERNAL,
      `gen_ai.operation.name = invoke_agent`, `gen_ai.agent.name = agent-service` and
      `gen_ai.conversation.id` equal to the request's `sessionId`. Fakes.
- [ ] `agent.node.plan` carries `gen_ai.operation.name = plan` and no `prompt_tokens` or
      `completion_tokens`. Fakes.
- [ ] With a fake tool selected, `act` emits `execute_tool web-search`, kind INTERNAL, with
      `gen_ai.tool.name = web-search`, as a child of `agent.node.act`; with a tool that
      throws, the span has ERROR status, `error.type`, and still carries `gen_ai.tool.name`.
      Fakes.
- [ ] A node that throws ends its span with ERROR status and `error.type`. Fakes.
- [ ] The chat wrapper, given a fake LangChain response with
      `usage_metadata { input_tokens: 10, output_tokens: 20, total_tokens: 45 }` and
      `finishReason: 'STOP'`, emits `generate_content gemini-2.5-flash`, kind CLIENT, with
      `gen_ai.provider.name = gcp.gemini`, `gen_ai.request.model = gemini-2.5-flash`,
      `gen_ai.usage.input_tokens = 10`, `gen_ai.usage.output_tokens = 35`,
      `gen_ai.usage.reasoning.output_tokens = 15`, `gen_ai.response.finish_reasons = ['STOP']`
      and `agent_native.seam`. Fakes.
- [ ] On model `live` / memory `live`, one trial of `memory-recall-001`
      (`EVAL_TRIALS=1 yarn eval`): the transcript's spans in `eval-report.json` include one
      `generate_content` span for each of `plan.callLlm`, `act.selectTool` and
      `distill.extractEntities`, each with `gen_ai.usage.input_tokens > 0` and
      `gen_ai.usage.output_tokens > 0`, each a descendant of `invoke_agent`, and one
      `embeddings gemini-embedding-001` span per `embedContent` call. **Live axis only** —
      the stub axis has no inference spans by design, so it cannot verify this. Budget:
      three `generateContent` calls and the run's embeddings.
- [ ] On the same live run, the derivation holds: for each chat span,
      `output_tokens − reasoning.output_tokens` equals the call's `candidatesTokenCount` as
      LangChain reports it. If `totalTokenCount` turns out not to include thought tokens,
      this criterion fails and the derivation is removed rather than the criterion edited.
- [ ] On model `replay` / memory `live`, run with `EVAL_CASSETTE_MODE=replay` and an
      empty `GOOGLE_API_KEY`: the `plan.callLlm` span of `memory-recall-001` carries
      input tokens 58, output tokens 922 and `agent_native.replayed` true; its
      `act.selectTool` and `distill.extractEntities` spans carry `agent_native.replayed`
      true and no key beginning `gen_ai.usage.`; the existing watcher still reports no
      request to `generativelanguage.googleapis.com`.
- [ ] On model `stub` / memory `live`, no span in any transcript carries
      `gen_ai.provider.name`.
- [ ] The allowlist test passes with `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true`
      set: every attribute key on every span of a full graph run and of the wrapper tests is
      in `ALLOWED_SPAN_ATTRIBUTES`, which contains no `gen_ai.input.messages`,
      `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`,
      `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `entity.id` or
      `relationship.*` key. Fakes; the live run above is additionally checked against the
      same list.
- [ ] `Transcript.spans` is populated on every trial of a replay run, every record carries
      the widened `SpanRecord` fields, all share the root's trace id, and none is named
      `memory.inspect.*`. Replay axis, memory `live`.
- [ ] `EvalHarness` emits one `gen_ai.evaluation.result` log record per `GraderResult`,
      carrying the attributes in the design table, with the trace and span id of the
      trial's `invoke_agent` record; a transcript with no spans produces unparented events
      and no error. `harness.test.ts` with a fake `AgentHarness` and an
      `InMemoryLogRecordExporter`. Fakes.
- [ ] On the replay run, `run-eval` logs the number of evaluation events emitted, and it
      equals the number of grader results in `eval-report.json` — twenty-one for the
      committed set. Replay axis.
- [ ] `turbo.json`'s `eval` task declares `OTEL_EXPORTER_OTLP_ENDPOINT`.
- [ ] `eval-report.json` carries the GenAI conventions commit (`GENAI_SEMCONV.commit`)
      beside the axes, and the Markdown summary prints it. Replay axis, memory `live`.
- [ ] `docs/STATUS.md` gains a row for GenAI telemetry with file and line evidence;
      `.context/glossary.md` no longer says a request is one trace unless it is;
      `.context/workflows.md` shows `withNodeSpan`; `.context/conventions.md` records the pin
      and the upgrade procedure; the `Score` comment and
      `packages/eval-harness/README.md` describe log-based events.
- [ ] `yarn turbo typecheck`, `yarn turbo lint`, `yarn turbo test:unit`, `yarn lint:docs` and
      `yarn format:check` pass.

## Risks and open questions

- **The conventions will move under this design.** They are Development status in a
  repository with no release and fifty commits in two months. The pin makes that a
  scheduling question rather than a correctness one, and the allowlist makes a bump loud.
  What the pin does not solve is historical `eval-report.json` files, which record span
  attributes without the convention commit they followed. If P1-D compares reports across
  a bump, it needs the commit in the report. **Decided at review, 2026-09-26:** this PRD
  adds it — `SuiteReport` carries `GENAI_SEMCONV.commit` beside the axes, because the
  comparison P1-D makes is the first consumer and one field now is cheaper than a
  migration of stored reports later.
- **Replayed usage is a choice a reviewer may reverse.** If the answer is "no span without
  a call", the `onServe` hook and the replay criteria go, P1-F loses its replay-tier input,
  and any span-reading grader has to declare `requires: { model: 'live' }`. **Decided at
  review, 2026-09-26: replayed usage stays**, marked `agent_native.replayed`, because the
  replay tier is the one P1-C runs on every pull request and P1-F's budgets are useless if
  that tier cannot see them. A reader who sums usage across tiers must filter on the
  marker, and P1-F owns saying so.
- **The output-token derivation rests on an unobserved response.** If `totalTokenCount`
  does not include thought tokens, or LangChain's `total_tokens` is not
  `totalTokenCount`, the arithmetic is wrong in a direction that understates cost. The
  second live criterion is the check, and its failure removes the derivation.
- **Size is `L`, not the index's `M`.** Changes in five workspaces, a public
  option on `packages/agent-cassette`, and one response path — Gemini usage through
  LangChain for a thinking model — that has never been observed. The index row is updated
  with this draft.
- **Removing four memory attributes may belong to Tier 3.** They are here because
  "content off by default" is not true while they exist, and the allowlist cannot pass with
  them. **Decided at review, 2026-09-26: they come off in P2-C.** An allowlist with an
  exception is not the invariant the test claims.
- **A hash of a short fact is enumerable.** `fact.contentHash` stays on spans. For the
  synthetic data ADR 0003 permits this is harmless; for real member data a keyed hash
  would be needed, and that is P3-C's question.
- **`eval-harness` gains its first OTel dependency.** The API packages are no-ops without
  an SDK; the alternative, emitting from `run-eval.ts`'s `onTrial`, keeps the package
  OTel-free at the cost of every other `AgentHarness` consumer re-implementing the event
  shape. **Accepted at review, 2026-09-26.**

## References

- OpenTelemetry GenAI semantic conventions, pinned at
  [`e57c543`](https://github.com/open-telemetry/semantic-conventions-genai/tree/e57c543b4889619eb2a05702471937db5119165d):
  `docs/gen-ai/gen-ai-spans.md` (inference, embeddings, memory, execute tool, content
  capture), `docs/gen-ai/gen-ai-agent-spans.md` (invoke agent, plan),
  `docs/gen-ai/gen-ai-events.md` (`gen_ai.evaluation.result`), `model/manifest.yaml`,
  `RELEASING.md`.
- [OpenTelemetry semantic conventions `v1.41.1`](https://github.com/open-telemetry/semantic-conventions/tree/v1.41.1/docs/gen-ai)
  — the last core release carrying the GenAI documents.
- [OTEP 4430: Span Event API deprecation plan](https://github.com/open-telemetry/opentelemetry-specification/blob/main/oteps/4430-span-event-api-deprecation-plan.md)
  and [Deprecating Span Events API](https://opentelemetry.io/blog/2026/deprecating-span-events/).
- `docs/adr/0003-payer-domain-with-licensing-and-phi-as-the-boundary.md` — the boundary
  content capture is held to.
- `docs/adr/0005-decision-seam-rather-than-transport-for-replay.md` — what replay stops
  measuring, which the replayed spans inherit.
- `docs/prd/P1-A-eval-harness.md` — the `Score` shape and `Transcript.spans`.
- `docs/prd/P1-B-agent-cassette.md` — the replay axis and the cassette format.
- `docs/prd/P2-A-wire-memory-core.md:148-149` — the memory-span rename this resolves.
