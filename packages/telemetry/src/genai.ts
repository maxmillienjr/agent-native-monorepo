import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/**
 * The OpenTelemetry GenAI vocabulary this repository emits, and the helpers
 * that emit it.
 *
 * This entry point imports `@opentelemetry/api` and nothing else, so a package
 * that only needs the names — `memory-core`, `eval-harness` — does not load
 * `sdk-node`. `genai.test.ts` asserts that.
 */

/**
 * The GenAI conventions this repository emits. Bump deliberately; see
 * `.context/conventions.md`.
 *
 * A commit and not a release because the repository the conventions moved to
 * has no tag yet, and not the npm package because
 * `@opentelemetry/semantic-conventions` marks every `ATTR_GEN_AI_*` constant
 * deprecated and is already behind the source — it has no `plan` operation.
 */
export const GENAI_SEMCONV = {
  repository: 'https://github.com/open-telemetry/semantic-conventions-genai',
  commit: 'e57c543b4889619eb2a05702471937db5119165d',
  schemaUrl: 'https://opentelemetry.io/schemas/gen-ai-dev/1.42.0-dev',
} as const;

/**
 * Every GenAI key this repository emits, and no other.
 *
 * Two Recommended attributes are absent on purpose:
 *
 * - `gen_ai.response.model`. Gemini returns `modelVersion` at the top level of
 *   the response, and `@langchain/google-genai` builds its message from the
 *   first candidate and `usageMetadata` only, so the value never reaches the
 *   client wrapper. Recording it would need the client to surface it.
 * - Embedding usage. The `embedContent` response has no usage block. Absent is
 *   recorded as absent — never estimated, never zero.
 *
 * The content-bearing keys — `gen_ai.input.messages`, `gen_ai.output.messages`,
 * `gen_ai.system_instructions`, `gen_ai.tool.definitions`,
 * `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` — are absent too, and
 * `ALLOWED_SPAN_ATTRIBUTES` is what keeps them absent.
 */
export const GEN_AI = {
  OPERATION_NAME: 'gen_ai.operation.name',
  PROVIDER_NAME: 'gen_ai.provider.name',
  REQUEST_MODEL: 'gen_ai.request.model',
  OUTPUT_TYPE: 'gen_ai.output.type',
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  USAGE_REASONING_OUTPUT_TOKENS: 'gen_ai.usage.reasoning.output_tokens',
  RESPONSE_FINISH_REASONS: 'gen_ai.response.finish_reasons',
  EMBEDDINGS_DIMENSION_COUNT: 'gen_ai.embeddings.dimension.count',
  AGENT_NAME: 'gen_ai.agent.name',
  CONVERSATION_ID: 'gen_ai.conversation.id',
  TOOL_NAME: 'gen_ai.tool.name',
  EVALUATION_NAME: 'gen_ai.evaluation.name',
  EVALUATION_SCORE_VALUE: 'gen_ai.evaluation.score.value',
  EVALUATION_SCORE_LABEL: 'gen_ai.evaluation.score.label',
  EVALUATION_EXPLANATION: 'gen_ai.evaluation.explanation',
} as const;

/** The `gen_ai.operation.name` values this repository emits. */
export const GEN_AI_OPERATION = {
  INVOKE_AGENT: 'invoke_agent',
  PLAN: 'plan',
  GENERATE_CONTENT: 'generate_content',
  EMBEDDINGS: 'embeddings',
  EXECUTE_TOOL: 'execute_tool',
  SEARCH_MEMORY: 'search_memory',
  UPSERT_MEMORY: 'upsert_memory',
} as const;

/** The event name of an evaluation result — a log record, not a span event. */
export const GEN_AI_EVALUATION_RESULT = 'gen_ai.evaluation.result';

/**
 * The provider value the conventions reserve for the
 * `generativelanguage.googleapis.com` endpoint, which both clients call.
 */
export const GCP_GEMINI = 'gcp.gemini';

/** The host and port both Gemini clients call. */
export const GEMINI_SERVER = { address: 'generativelanguage.googleapis.com', port: 443 } as const;

/** Keys in this repository's own namespace, beside the GenAI ones. */
export const AGENT_NATIVE = {
  RUN_ID: 'agent_native.run_id',
  /** Which decision seam made a model call — the cassette vocabulary. */
  SEAM: 'agent_native.seam',
  /** The span was emitted from a cassette on the replay axis; no call happened. */
  REPLAYED: 'agent_native.replayed',
  EVAL_TASK_ID: 'agent_native.eval.task_id',
  EVAL_TRIAL_INDEX: 'agent_native.eval.trial_index',
  EVAL_GRADER_KIND: 'agent_native.eval.grader_kind',
  MODEL_AXIS: 'agent_native.model_axis',
  MEMORY_AXIS: 'agent_native.memory_axis',
} as const;

/** General OpenTelemetry keys the helpers set. */
const SERVER_ADDRESS = 'server.address';
const SERVER_PORT = 'server.port';
const ERROR_TYPE = 'error.type';

/**
 * Every attribute key any span in this repository may carry.
 *
 * An allowlist rather than a denylist because content has already leaked
 * through keys nobody labelled as content: `entity.id` and
 * `relationship.fromId` were model output taken from the conversation, and in
 * the payer domain an entity id can be a member's name. A new key needs a
 * deliberate edit here, which is where a reviewer asks whether it carries
 * content. `spans.test.ts` and `run-eval.ts` hold every span to it.
 *
 * `fact.contentHash` stays: it is the key the write path is idempotent on and
 * the trace's only join to the stores. A sha256 of a short fact is guessable
 * by enumeration, which is harmless on synthetic data and P3-C's question on
 * real member data.
 */
export const ALLOWED_SPAN_ATTRIBUTES: ReadonlySet<string> = new Set<string>([
  GEN_AI.OPERATION_NAME,
  GEN_AI.PROVIDER_NAME,
  GEN_AI.REQUEST_MODEL,
  GEN_AI.OUTPUT_TYPE,
  GEN_AI.USAGE_INPUT_TOKENS,
  GEN_AI.USAGE_OUTPUT_TOKENS,
  GEN_AI.USAGE_REASONING_OUTPUT_TOKENS,
  GEN_AI.RESPONSE_FINISH_REASONS,
  GEN_AI.EMBEDDINGS_DIMENSION_COUNT,
  GEN_AI.AGENT_NAME,
  GEN_AI.CONVERSATION_ID,
  GEN_AI.TOOL_NAME,
  AGENT_NATIVE.RUN_ID,
  AGENT_NATIVE.SEAM,
  AGENT_NATIVE.REPLAYED,
  SERVER_ADDRESS,
  SERVER_PORT,
  ERROR_TYPE,
  // The node spans. Identifiers and counts; nothing the model wrote.
  'run_id',
  'session_id',
  'step_count',
  'message_count',
  'entity_count',
  'relationship_count',
  'fact_count',
  'candidateCount',
  'outcome',
  // The tool registry (P4-C). A tier is one of three words the code declares,
  // and the other two are booleans; none is the call's input or output.
  'tool.tier',
  'tool.duplicate_suppressed',
  'tool.compensation',
  'tool.awaiting_approval',
  // The prior-authorization nodes (P3-D). Times, a priority and the kind of
  // disposition: the request clock P1-F budgets and P3-E sorts by, and nothing
  // from the member's record. No code, no criterion, no finding.
  'prior_auth.received_at',
  'prior_auth.priority',
  'prior_auth.decision_due_by',
  'prior_auth.disposition',
  'prior_auth.elapsed_ms',
  // The memory-core spans.
  'topK',
  'queryLength',
  'crossSession',
  'resultCount',
  'seedEntityCount',
  'hopDepth',
  'fact.contentHash',
  'fact.entityCount',
  // The harness's own seed and inspection spans, which are not part of a run.
  'conceptCount',
  'relationshipCount',
  'factCount',
  'graphFactCount',
  'seedConceptCount',
  'seedFactCount',
  'episodeRowsForRun',
  'factRowsForRun',
  'factNodesForRun',
]);

/** The keys on these spans that are not in `ALLOWED_SPAN_ATTRIBUTES`, sorted and distinct. */
export function unlistedAttributeKeys(
  spans: Iterable<{ readonly attributes: Readonly<Record<string, unknown>> }>,
): string[] {
  const unlisted = new Set<string>();
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      if (!ALLOWED_SPAN_ATTRIBUTES.has(key)) unlisted.add(key);
    }
  }
  return [...unlisted].sort();
}

/**
 * The tracer every helper uses, carrying the schema URL — the OTLP-native way
 * for a backend to know which names a scope follows.
 *
 * Resolved per call rather than once: the API hands out a proxy until a
 * provider is registered, and a test that registers one after this module
 * loaded must still see its spans.
 */
function tracer(): Tracer {
  return trace
    .getTracerProvider()
    .getTracer('agent-native.genai', undefined, { schemaUrl: GENAI_SEMCONV.schemaUrl });
}

/**
 * What `error.type` says about a thrown value: the HTTP status where the error
 * carries one — the shape `retry.ts` already reads — otherwise its name.
 *
 * The message is never recorded, on the span or in its status. A replayed
 * `CassetteMissError` carries a diff of the prompt, and a model client's error
 * can quote the request.
 */
export function errorType(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { status?: unknown; statusCode?: unknown; name?: unknown };
    const status = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
    if (typeof status === 'number') return String(status);
    if (typeof candidate.name === 'string' && candidate.name !== '') return candidate.name;
  }
  return '_OTHER';
}

function recordError(span: Span, error: unknown): void {
  const type = errorType(error);
  span.setAttribute(ERROR_TYPE, type);
  span.setStatus({ code: SpanStatusCode.ERROR, message: type });
}

/**
 * Opens an active span, records `error.type` and ERROR status on a throw,
 * rethrows, and always ends it.
 */
function withSpan<T>(
  name: string,
  kind: SpanKind,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  return tracer().startActiveSpan(name, { kind, attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (error) {
      recordError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

// --- invoke_agent --------------------------------------------------------------

export interface AgentRequest {
  /** `gen_ai.agent.name`, known at creation because it is sampling-relevant. */
  readonly agentName: string;
  readonly runId: string;
}

export interface AgentSpan {
  /** The trace every span of this run belongs to. */
  readonly traceId: string;
  /** `gen_ai.conversation.id`. Known only once `ingress` has validated the body. */
  setConversationId(id: string): void;
  /** For a caller that contains its own failure, as the SSE path does. */
  recordError(error: unknown): void;
}

/**
 * The root of a run: `invoke_agent {agentName}`, kind INTERNAL — the in-process
 * agent variant the conventions give LangChain agents as the example of. Every
 * node span is its child, which is what makes a run one trace.
 */
export function withAgentSpan<T>(
  request: AgentRequest,
  fn: (span: AgentSpan) => Promise<T>,
): Promise<T> {
  return withSpan(
    `${GEN_AI_OPERATION.INVOKE_AGENT} ${request.agentName}`,
    SpanKind.INTERNAL,
    {
      [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.INVOKE_AGENT,
      [GEN_AI.AGENT_NAME]: request.agentName,
      [AGENT_NATIVE.RUN_ID]: request.runId,
    },
    (span) =>
      fn({
        traceId: span.spanContext().traceId,
        setConversationId: (id) => span.setAttribute(GEN_AI.CONVERSATION_ID, id),
        recordError: (error) => recordError(span, error),
      }),
  );
}

// --- agent.node.* --------------------------------------------------------------

export interface NodeSpanOptions {
  /**
   * `plan` on the `plan` node only: the conventions report a Plan span when the
   * instrumentation can reliably tell the operation is planning, and a node
   * named `plan` whose output is `currentPlan` is that case.
   */
  readonly operation?: typeof GEN_AI_OPERATION.PLAN;
}

/**
 * `agent.node.{node}`, the span every graph node opens.
 *
 * The names predate these conventions and are public vocabulary — SSE frames,
 * the console, `docs/STATUS.md` — so they stay, and the operation rides as an
 * attribute where one applies. A node that throws ends its span with ERROR and
 * `error.type`; a bare `finally` used to leave the status unset.
 */
export function withNodeSpan<T>(
  node: string,
  fn: (span: Span) => Promise<T>,
  options: NodeSpanOptions = {},
): Promise<T> {
  const attributes: Attributes =
    options.operation === undefined ? {} : { [GEN_AI.OPERATION_NAME]: options.operation };
  return withSpan(`agent.node.${node}`, SpanKind.INTERNAL, attributes, fn);
}

// --- execute_tool --------------------------------------------------------------

/**
 * `execute_tool {tool}`, kind INTERNAL, around one tool execution. The tool's
 * name is set at creation, so a tool that throws still carries it. Its
 * arguments and result are content and are never recorded.
 */
export function withToolSpan<T>(toolName: string, fn: (span: Span) => Promise<T>): Promise<T> {
  return withSpan(
    `${GEN_AI_OPERATION.EXECUTE_TOOL} ${toolName}`,
    SpanKind.INTERNAL,
    { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.EXECUTE_TOOL, [GEN_AI.TOOL_NAME]: toolName },
    fn,
  );
}

// --- generate_content, embeddings ----------------------------------------------

/** The decision seams, in the cassette's vocabulary, so P1-F can attribute cost. */
export type InferenceSeam =
  'plan.callLlm' | 'act.selectTool' | 'distill.extractEntities' | 'embed' | 'assess.criteria';

export interface InferenceRequest {
  readonly operation: typeof GEN_AI_OPERATION.GENERATE_CONTENT | typeof GEN_AI_OPERATION.EMBEDDINGS;
  readonly model: string;
  readonly seam: InferenceSeam;
  /** Set when the request asked for JSON. */
  readonly outputType?: 'text' | 'json';
  /** `gen_ai.embeddings.dimension.count`, on an embeddings request. */
  readonly dimensions?: number;
}

export interface TokenUsage {
  readonly input?: number;
  readonly output?: number;
  /** Included in `output` as well, as the conventions ask. */
  readonly reasoningOutput?: number;
}

export interface InferenceSpan {
  /** Sets only the counts that are present. An absent count is never written as zero. */
  recordUsage(usage: TokenUsage): void;
  recordFinishReasons(reasons: readonly string[]): void;
  /** `agent_native.replayed = true`: served from a cassette, no call made. */
  markReplayed(): void;
}

function inferenceSpan(span: Span): InferenceSpan {
  const setCount = (key: string, value: number | undefined) => {
    if (value !== undefined && Number.isFinite(value)) span.setAttribute(key, value);
  };
  return {
    recordUsage: (usage) => {
      setCount(GEN_AI.USAGE_INPUT_TOKENS, usage.input);
      setCount(GEN_AI.USAGE_OUTPUT_TOKENS, usage.output);
      setCount(GEN_AI.USAGE_REASONING_OUTPUT_TOKENS, usage.reasoningOutput);
    },
    recordFinishReasons: (reasons) => {
      if (reasons.length > 0) span.setAttribute(GEN_AI.RESPONSE_FINISH_REASONS, [...reasons]);
    },
    markReplayed: () => span.setAttribute(AGENT_NATIVE.REPLAYED, true),
  };
}

/**
 * One model call: a CLIENT span named `{operation} {model}`.
 *
 * Opened where the client is, not at the `ModelDeps` seam, so it exists exactly
 * when a client does — the stub axis emits none — and so that the raw response,
 * the only place finish reasons and total token counts are, is in reach. A
 * client's own retries happen inside the call and so inside this span.
 */
export function withInferenceSpan<T>(
  request: InferenceRequest,
  fn: (span: InferenceSpan) => Promise<T>,
): Promise<T> {
  const attributes: Attributes = {
    [GEN_AI.OPERATION_NAME]: request.operation,
    [GEN_AI.PROVIDER_NAME]: GCP_GEMINI,
    [GEN_AI.REQUEST_MODEL]: request.model,
    [SERVER_ADDRESS]: GEMINI_SERVER.address,
    [SERVER_PORT]: GEMINI_SERVER.port,
    [AGENT_NATIVE.SEAM]: request.seam,
  };
  if (request.outputType !== undefined) attributes[GEN_AI.OUTPUT_TYPE] = request.outputType;
  if (request.dimensions !== undefined) {
    attributes[GEN_AI.EMBEDDINGS_DIMENSION_COUNT] = request.dimensions;
  }

  return withSpan(`${request.operation} ${request.model}`, SpanKind.CLIENT, attributes, (span) =>
    fn(inferenceSpan(span)),
  );
}

/**
 * The active span, seen through `InferenceSpan`.
 *
 * For code that runs inside a span it did not open — the cassette player's
 * `onServe`, which fires inside whichever inference, embeddings or tool span
 * is serving the decision.
 */
export function activeInferenceSpan(): InferenceSpan | undefined {
  const span = trace.getActiveSpan();
  return span === undefined ? undefined : inferenceSpan(span);
}

/**
 * Usage as a Gemini chat response reports it through LangChain, in the
 * conventions' terms.
 *
 * LangChain maps `output_tokens` to `candidatesTokenCount` and `total_tokens`
 * to `totalTokenCount`. A thinking model's thought tokens are billed as output
 * and reported in a separate `thoughtsTokenCount` that neither LangChain nor
 * the pinned SDK type surfaces, and the conventions say reasoning tokens
 * SHOULD be included in `output_tokens`. So when a total is present, output is
 * `total − input` and reasoning is what that adds to the candidates; without
 * one, output is the candidate count alone.
 */
export function chatUsage(meta: {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
}): TokenUsage {
  const input = meta.input_tokens;
  const candidates = meta.output_tokens;
  const total = meta.total_tokens;

  if (
    input !== undefined &&
    candidates !== undefined &&
    total !== undefined &&
    total >= input + candidates
  ) {
    return { input, output: total - input, reasoningOutput: total - input - candidates };
  }

  return {
    ...(input === undefined ? {} : { input }),
    ...(candidates === undefined ? {} : { output: candidates }),
  };
}
