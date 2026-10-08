import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { SpanKind, SpanStatusCode, context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace';
import {
  ALLOWED_SPAN_ATTRIBUTES,
  GENAI_SEMCONV,
  GEN_AI,
  activeInferenceSpan,
  chatUsage,
  errorType,
  unlistedAttributeKeys,
  withAgentSpan,
  withInferenceSpan,
  withNodeSpan,
  withServiceSpan,
  withToolSpan,
} from './genai.js';

const exporter = new InMemorySpanExporter();

beforeAll(() => {
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  trace.setGlobalTracerProvider(
    new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] }),
  );
});

beforeEach(() => exporter.reset());

const only = (): ReadableSpan => {
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

class HttpError extends Error {
  constructor(readonly status: number) {
    super('the request quoted: a member name');
    this.name = 'HttpError';
  }
}

describe('GENAI_SEMCONV', () => {
  it('pins the conventions to one commit and names the schema every helper emits under', async () => {
    expect(GENAI_SEMCONV.commit).toBe('e57c543b4889619eb2a05702471937db5119165d');
    await withNodeSpan('plan', async () => undefined);
    expect(only().instrumentationScope.schemaUrl).toBe(GENAI_SEMCONV.schemaUrl);
  });
});

describe('withInferenceSpan', () => {
  it('opens a CLIENT span named for the operation and the model, with the request attributes', async () => {
    await withInferenceSpan(
      {
        operation: 'generate_content',
        model: 'gemini-2.5-flash',
        seam: 'act.selectTool',
        outputType: 'json',
      },
      async (span) => {
        span.recordUsage({ input: 10, output: 35, reasoningOutput: 15 });
        span.recordFinishReasons(['STOP']);
      },
    );

    const span = only();
    expect(span.name).toBe('generate_content gemini-2.5-flash');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gcp.gemini',
      'gen_ai.request.model': 'gemini-2.5-flash',
      'gen_ai.output.type': 'json',
      'server.address': 'generativelanguage.googleapis.com',
      'server.port': 443,
      'agent_native.seam': 'act.selectTool',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 35,
      'gen_ai.usage.reasoning.output_tokens': 15,
      'gen_ai.response.finish_reasons': ['STOP'],
    });
  });

  it('writes no usage key for a count it was not given, rather than a zero', async () => {
    await withInferenceSpan(
      { operation: 'embeddings', model: 'gemini-embedding-001', seam: 'embed', dimensions: 768 },
      async (span) => span.recordUsage({}),
    );

    const span = only();
    expect(span.attributes[GEN_AI.EMBEDDINGS_DIMENSION_COUNT]).toBe(768);
    expect(Object.keys(span.attributes).filter((key) => key.startsWith('gen_ai.usage.'))).toEqual(
      [],
    );
  });

  it('records the HTTP status as error.type and ERROR status on a throw, and rethrows', async () => {
    await expect(
      withInferenceSpan(
        { operation: 'generate_content', model: 'gemini-2.5-flash', seam: 'plan.callLlm' },
        async () => {
          throw new HttpError(429);
        },
      ),
    ).rejects.toThrow(HttpError);

    const span = only();
    expect(span.attributes['error.type']).toBe('429');
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // The message quoted the request; it must not reach the span.
    expect(span.status.message).toBe('429');
    expect(span.events).toEqual([]);
  });

  it('is visible to code running inside it that did not open it', async () => {
    await withInferenceSpan(
      { operation: 'generate_content', model: 'gemini-2.5-flash', seam: 'plan.callLlm' },
      async () => {
        activeInferenceSpan()?.markReplayed();
        activeInferenceSpan()?.recordUsage({ input: 58, output: 922 });
      },
    );

    expect(only().attributes).toMatchObject({
      'agent_native.replayed': true,
      'gen_ai.usage.input_tokens': 58,
      'gen_ai.usage.output_tokens': 922,
    });
  });
});

describe('withNodeSpan', () => {
  it('names the span agent.node.<name> and sets the operation only where one applies', async () => {
    await withNodeSpan('plan', async () => undefined, { operation: 'plan' });
    await withNodeSpan('retrieve', async () => undefined);

    const [plan, retrieve] = exporter.getFinishedSpans();
    expect(plan!.name).toBe('agent.node.plan');
    expect(plan!.attributes[GEN_AI.OPERATION_NAME]).toBe('plan');
    expect(retrieve!.name).toBe('agent.node.retrieve');
    expect(retrieve!.attributes[GEN_AI.OPERATION_NAME]).toBeUndefined();
  });

  it('ends a throwing node with ERROR status and the error name as error.type', async () => {
    await expect(
      withNodeSpan('reflect', async () => {
        throw new TypeError('boom');
      }),
    ).rejects.toThrow('boom');

    const span = only();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.attributes['error.type']).toBe('TypeError');
  });
});

describe('withServiceSpan', () => {
  it('opens an internal span with no GenAI operation, and records error.type on a throw', async () => {
    await expect(
      withServiceSpan('review.determination', async (span) => {
        span.setAttribute('prior_auth.case_id', 'synthetic-case');
        throw new HttpError(409);
      }),
    ).rejects.toThrow();

    const span = only();
    expect(span.name).toBe('review.determination');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes[GEN_AI.OPERATION_NAME]).toBeUndefined();
    expect(span.attributes['error.type']).toBe('409');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: '409' });
    expect(unlistedAttributeKeys([span])).toEqual([]);
  });
});

describe('withToolSpan', () => {
  it('keeps gen_ai.tool.name on a tool that throws', async () => {
    await expect(
      withToolSpan('web-search', async () => {
        throw new Error('offline');
      }),
    ).rejects.toThrow('offline');

    const span = only();
    expect(span.name).toBe('execute_tool web-search');
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.attributes[GEN_AI.TOOL_NAME]).toBe('web-search');
    expect(span.attributes['error.type']).toBe('Error');
  });
});

describe('withAgentSpan', () => {
  it('is the parent of the spans opened inside it, and takes the conversation id late', async () => {
    let traceId = '';
    await withAgentSpan({ agentName: 'agent-service', runId: 'run-1' }, async (agent) => {
      traceId = agent.traceId;
      await withNodeSpan('ingress', async () => undefined);
      agent.setConversationId('session-1');
    });

    const [node, root] = exporter.getFinishedSpans();
    expect(root!.name).toBe('invoke_agent agent-service');
    expect(root!.kind).toBe(SpanKind.INTERNAL);
    expect(root!.attributes).toEqual({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'agent-service',
      'gen_ai.conversation.id': 'session-1',
      'agent_native.run_id': 'run-1',
    });
    expect(root!.spanContext().traceId).toBe(traceId);
    expect(node!.parentSpanContext?.spanId).toBe(root!.spanContext().spanId);
  });
});

describe('chatUsage', () => {
  it('counts thought tokens as output when a total is reported', () => {
    // LangChain: output_tokens is candidatesTokenCount, total_tokens is totalTokenCount.
    expect(chatUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 45 })).toEqual({
      input: 10,
      output: 35,
      reasoningOutput: 15,
    });
  });

  it('falls back to the candidate count when the total is absent or reported as zero', () => {
    // `@langchain/google-genai` writes `totalTokenCount ?? 0`.
    expect(chatUsage({ input_tokens: 10, output_tokens: 20, total_tokens: 0 })).toEqual({
      input: 10,
      output: 20,
    });
    expect(chatUsage({})).toEqual({});
  });
});

describe('errorType', () => {
  it('prefers a status, then a name', () => {
    expect(errorType(new HttpError(503))).toBe('503');
    expect(errorType({ statusCode: 404 })).toBe('404');
    expect(errorType(new RangeError('x'))).toBe('RangeError');
    expect(errorType('a string')).toBe('_OTHER');
  });
});

describe('ALLOWED_SPAN_ATTRIBUTES', () => {
  it('contains no content-bearing key', () => {
    const content = [
      'gen_ai.input.messages',
      'gen_ai.output.messages',
      'gen_ai.system_instructions',
      'gen_ai.tool.definitions',
      'gen_ai.tool.call.arguments',
      'gen_ai.tool.call.result',
      'entity.id',
    ];
    for (const key of content) expect(ALLOWED_SPAN_ATTRIBUTES.has(key)).toBe(false);
    expect([...ALLOWED_SPAN_ATTRIBUTES].filter((key) => key.startsWith('relationship.'))).toEqual(
      [],
    );
  });

  it('names what a span carries that is not on the list', () => {
    expect(
      unlistedAttributeKeys([
        { attributes: { run_id: 'r', 'entity.id': 'a member' } },
        { attributes: { 'gen_ai.input.messages': '[]', 'entity.id': 'b' } },
      ]),
    ).toEqual(['entity.id', 'gen_ai.input.messages']);
  });
});
