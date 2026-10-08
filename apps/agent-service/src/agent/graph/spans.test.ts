import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { SpanKind, SpanStatusCode, context, trace, type Span } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { EMBEDDING_DIMENSIONS } from '@repo/memory-core';
import { ALLOWED_SPAN_ATTRIBUTES, unlistedAttributeKeys } from '@repo/telemetry';
import { CHAT_MODEL, RunsService } from '../../runs/runs.service.js';
import { invokeChat, type ChatClient, type ChatReply } from '../model/gemini-chat.js';
import { createGeminiEmbedder } from '../model/gemini-embedder.js';
import type { GraphDeps } from './graph.js';

const exporter = new InMemorySpanExporter();

/** Every span any test in this file produced, for the allowlist at the end. */
const everySpan: ReadableSpan[] = [];

const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';

const body = (maxSteps = 1) => ({
  sessionId: SESSION_ID,
  messages: [{ role: 'user', content: 'What is LangGraph?' }],
  config: { topK: 3, maxSteps },
});

/** A LangChain reply as `@langchain/google-genai` shapes one: thought tokens only in the total. */
const reply = (content: string): ChatReply => ({
  content,
  usage_metadata: { input_tokens: 10, output_tokens: 20, total_tokens: 45 },
  response_metadata: { finishReason: 'STOP' },
});

const fakeLlm = (content: () => string): ChatClient => ({
  invoke: async () => reply(content()),
});

/** An `embedContent` response, served to the real embedder in place of the network. */
const fakeFetch = async (): Promise<Response> =>
  new Response(
    JSON.stringify({ embedding: { values: new Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * A dependency set whose model half is the real client wrappers over a fake
 * LangChain client and a fake `fetch`, so the inference and embeddings spans
 * are the ones production opens; the stores are fakes that open the spans
 * `memory-core`'s adapters open.
 */
function deps(tool: (input: unknown) => Promise<unknown>): GraphDeps {
  const tracer = trace.getTracer('memory-core');
  const withSpan = async <T>(name: string, attrs: Record<string, number | string>, value: T) =>
    tracer.startActiveSpan(name, async (span: Span) => {
      for (const [key, attr] of Object.entries(attrs)) span.setAttribute(key, attr);
      span.end();
      return value;
    });

  const embed = createGeminiEmbedder('fake-key');
  const chat = (
    seam: 'plan.callLlm' | 'act.selectTool' | 'distill.extractEntities',
    text: string,
  ) =>
    invokeChat(
      fakeLlm(() => text),
      { model: CHAT_MODEL, seam, json: seam !== 'plan.callLlm' },
      's',
      'u',
    );

  return {
    retrieve: {
      // Stands in for VectorRetrievalFacade, which opens exactly this span,
      // from PgPgvectorReader. It opens no `memory.neo4j.expand`: since ADR
      // 0009 no request reads the graph.
      retrievalFacade: {
        retrieve: async (query) => {
          await withSpan(
            'memory.pgvector.search',
            { topK: query.topK ?? -1, 'gen_ai.operation.name': 'search_memory' },
            null,
          );
          return [];
        },
      },
      embedQuery: embed,
    },
    plan: { callLlm: () => chat('plan.callLlm', 'a plan') },
    act: {
      tools: [{ name: 'web-search', execute: tool }],
      selectTool: async () => {
        const response = await chat('act.selectTool', '{"toolName":"web-search","input":"q"}');
        return JSON.parse(response.content) as { toolName: string; input: unknown };
      },
    },
    distill: {
      extractEntities: async () => {
        await chat('distill.extractEntities', '{}');
        return {
          entities: [{ id: 'langgraph', label: 'LangGraph' }],
          relationships: [],
          facts: [{ text: 'A fact.' }],
        };
      },
    },
    reflect: {
      episodicRepo: {
        write: async () => ({ id: '550e8400-e29b-41d4-a716-446655440002' }),
        findBySession: async () => [],
      },
      neo4jWriter: {
        mergeEntity: async () => {
          await withSpan(
            'memory.neo4j.mergeEntity',
            { 'gen_ai.operation.name': 'upsert_memory' },
            undefined,
          );
        },
        mergeRelationship: async () => {},
        mergeFact: async () => {},
      },
      pgvectorWriter: {
        upsertFact: async () => {
          await withSpan(
            'memory.pgvector.upsert',
            { 'gen_ai.operation.name': 'upsert_memory' },
            undefined,
          );
        },
      },
      embedText: embed,
    },
  };
}

/** Runs one request through `RunsService`, which is what opens the root, and returns its spans. */
async function run(
  tool: (input: unknown) => Promise<unknown>,
  request: unknown = body(),
): Promise<ReadableSpan[]> {
  exporter.reset();
  const service = new RunsService(null, null, null, null, null);
  service.setDeps(deps(tool));
  await service.executeTraced({ body: request, correlationId: 'corr-123' }).catch(() => undefined);
  const spans = exporter.getFinishedSpans();
  everySpan.push(...spans);
  return spans;
}

const named = (spans: readonly ReadableSpan[], name: string) =>
  spans.filter((span) => span.name === name);
const find = (spans: readonly ReadableSpan[], name: string) => named(spans, name)[0];
const parentOf = (spans: readonly ReadableSpan[], child: ReadableSpan | undefined) =>
  spans.find((span) => span.spanContext().spanId === child?.parentSpanContext?.spanId);

/**
 * The shape of the trace one run produces.
 *
 * `docs/STATUS.md` row 13 recorded the memory child spans as real but
 * unreachable, and until P2-C a run was not one trace at all: nothing enclosed
 * the graph, so each of the seven node spans was the root of its own. These
 * assertions are about the trace the wired service produces.
 */
describe('trace shape', () => {
  let spans: ReadableSpan[];

  beforeAll(async () => {
    // The conventions name this as the opt-in switch for content capture. It
    // is set to show that nothing reads it: the allowlist below must pass
    // with it on.
    process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'] = 'true';

    // Without a context manager `startActiveSpan` does not propagate the
    // active span and every span comes out parentless, which would make these
    // assertions vacuous. `initTelemetry` gets one from sdk-node in the real
    // service; this suite registers it directly.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
    );
    vi.stubGlobal('fetch', fakeFetch);

    spans = await run(async (input) => ({ results: [String(input)] }));
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    delete process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT'];
    await exporter.shutdown();
  });

  it('is one trace, rooted at invoke_agent', () => {
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);

    const root = find(spans, 'invoke_agent agent-service');
    expect(root?.kind).toBe(SpanKind.INTERNAL);
    expect(root?.parentSpanContext).toBeUndefined();
    expect(root?.attributes).toMatchObject({
      'gen_ai.operation.name': 'invoke_agent',
      'gen_ai.agent.name': 'agent-service',
      'gen_ai.conversation.id': SESSION_ID,
    });

    const nodes = spans.filter((span) => span.name.startsWith('agent.node.'));
    expect(nodes.map((span) => span.name).sort()).toEqual(
      ['act', 'distill', 'egress', 'ingress', 'plan', 'reflect', 'retrieve']
        .map((node) => `agent.node.${node}`)
        .sort(),
    );
    for (const node of nodes) expect(parentOf(spans, node)?.name).toBe(root?.name);
  });

  it('marks agent.node.plan as the plan operation and keeps usage off it', () => {
    const plan = find(spans, 'agent.node.plan');
    expect(plan?.attributes['gen_ai.operation.name']).toBe('plan');
    expect(plan?.attributes['prompt_tokens']).toBeUndefined();
    expect(plan?.attributes['completion_tokens']).toBeUndefined();
  });

  it('opens one inference span per chat call, under the node that made it', () => {
    const chats = named(spans, `generate_content ${CHAT_MODEL}`);
    expect(
      chats.map((span) => [span.attributes['agent_native.seam'], parentOf(spans, span)?.name]),
    ).toEqual([
      ['plan.callLlm', 'agent.node.plan'],
      ['act.selectTool', 'agent.node.act'],
      ['distill.extractEntities', 'agent.node.distill'],
    ]);
  });

  it('records the conventions’ attributes on an inference span, output including thought tokens', () => {
    const plan = named(spans, `generate_content ${CHAT_MODEL}`)[0];
    expect(plan?.kind).toBe(SpanKind.CLIENT);
    expect(plan?.attributes).toEqual({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gcp.gemini',
      'gen_ai.request.model': 'gemini-2.5-flash',
      'server.address': 'generativelanguage.googleapis.com',
      'server.port': 443,
      'agent_native.seam': 'plan.callLlm',
      'gen_ai.usage.input_tokens': 10,
      'gen_ai.usage.output_tokens': 35,
      'gen_ai.usage.reasoning.output_tokens': 15,
      'gen_ai.response.finish_reasons': ['STOP'],
    });
    expect(
      named(spans, `generate_content ${CHAT_MODEL}`)[1]?.attributes['gen_ai.output.type'],
    ).toBe('json');
  });

  it('opens one embeddings span per embedContent call, with the width and no usage', () => {
    const embeddings = named(spans, 'embeddings gemini-embedding-001');
    // The user's message in `retrieve`, and the one fact in `reflect`.
    expect(embeddings.map((span) => parentOf(spans, span)?.name)).toEqual([
      'agent.node.retrieve',
      'agent.node.reflect',
    ]);
    for (const span of embeddings) {
      expect(span.kind).toBe(SpanKind.CLIENT);
      expect(span.attributes['gen_ai.embeddings.dimension.count']).toBe(EMBEDDING_DIMENSIONS);
      expect(Object.keys(span.attributes).some((key) => key.startsWith('gen_ai.usage.'))).toBe(
        false,
      );
    }
  });

  it('opens execute_tool under agent.node.act', () => {
    const tool = find(spans, 'execute_tool web-search');
    expect(tool?.kind).toBe(SpanKind.INTERNAL);
    expect(tool?.attributes['gen_ai.tool.name']).toBe('web-search');
    expect(tool?.attributes['gen_ai.operation.name']).toBe('execute_tool');
    expect(parentOf(spans, tool)?.name).toBe('agent.node.act');
    expect(find(spans, 'agent.node.act')?.attributes['tool.name']).toBeUndefined();
  });

  it('keeps gen_ai.tool.name, and records the error, on a tool that throws', async () => {
    const failed = await run(async () => {
      throw new Error('offline');
    });

    const tool = find(failed, 'execute_tool web-search');
    expect(tool?.status.code).toBe(SpanStatusCode.ERROR);
    expect(tool?.attributes['error.type']).toBe('Error');
    expect(tool?.attributes['gen_ai.tool.name']).toBe('web-search');
    // `act` records the failure as a tool output and does not throw.
    expect(find(failed, 'agent.node.act')?.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('ends a node that throws with ERROR status and error.type, and the run with it', async () => {
    const failed = await run(async () => ({}), { sessionId: 'not-a-uuid', messages: [] });

    const ingress = find(failed, 'agent.node.ingress');
    expect(ingress?.status.code).toBe(SpanStatusCode.ERROR);
    expect(ingress?.attributes['error.type']).toBe('ZodError');
    expect(find(failed, 'invoke_agent agent-service')?.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('nests the retrieval store span under agent.node.retrieve', () => {
    expect(parentOf(spans, find(spans, 'memory.pgvector.search'))?.name).toBe(
      'agent.node.retrieve',
    );
  });

  it('nests the write spans under agent.node.reflect', () => {
    expect(parentOf(spans, find(spans, 'memory.neo4j.mergeEntity'))?.name).toBe(
      'agent.node.reflect',
    );
    expect(parentOf(spans, find(spans, 'memory.pgvector.upsert'))?.name).toBe('agent.node.reflect');
  });

  it('carries the request’s topK into the store span', () => {
    // RunRequestConfig validated it and retrieve then hardcoded 10.
    expect(find(spans, 'memory.pgvector.search')?.attributes['topK']).toBe(3);
  });

  // Last, so it covers every span every test above produced.
  it('puts no attribute outside ALLOWED_SPAN_ATTRIBUTES on any span, with capture switched on', () => {
    expect(process.env['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT']).toBe('true');
    // Three runs: a full one, one whose tool throws, one that fails in `ingress`.
    expect(everySpan.length).toBeGreaterThan(30);
    expect(unlistedAttributeKeys(everySpan)).toEqual([]);
    expect(ALLOWED_SPAN_ATTRIBUTES.has('gen_ai.input.messages')).toBe(false);
  });
});
