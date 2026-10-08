import { describe, it, expect } from 'vitest';
import { AGENT_NATIVE, GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';
import { checkBudgets, estimateCost, trialUsage } from './budgets.js';
import type { Axes, PriceTable, SpanRecord, Transcript } from './types.js';

const live: Axes = { model: 'live', memory: 'live' };
const replay: Axes = { model: 'replay', memory: 'live' };

let next = 0;
function span(attributes: Record<string, unknown>, extra: Partial<SpanRecord> = {}): SpanRecord {
  next += 1;
  return {
    name: 'a span',
    kind: 'client',
    traceId: 't'.repeat(32),
    spanId: String(next).padStart(16, '0'),
    startTimeUnixMs: 0,
    durationMs: 100,
    status: 'unset',
    attributes,
    ...extra,
  };
}

/** A `generate_content` span with the usage a live client would record. */
function chat(
  input: number | undefined,
  output: number | undefined,
  options: { replayed?: boolean; reasoning?: number; model?: string } = {},
): SpanRecord {
  return span({
    [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.GENERATE_CONTENT,
    [GEN_AI.REQUEST_MODEL]: options.model ?? 'gemini-2.5-flash',
    ...(input === undefined ? {} : { [GEN_AI.USAGE_INPUT_TOKENS]: input }),
    ...(output === undefined ? {} : { [GEN_AI.USAGE_OUTPUT_TOKENS]: output }),
    ...(options.reasoning === undefined
      ? {}
      : { [GEN_AI.USAGE_REASONING_OUTPUT_TOKENS]: options.reasoning }),
    ...(options.replayed === true ? { [AGENT_NATIVE.REPLAYED]: true } : {}),
  });
}

/** A request that failed: it was made, so it counts, and it carries no usage. */
const errored = (): SpanRecord =>
  span(
    {
      [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.GENERATE_CONTENT,
      [GEN_AI.REQUEST_MODEL]: 'gemini-2.5-flash',
      'error.type': '503',
    },
    { status: 'error' },
  );

const embedding = (replayed = false): SpanRecord =>
  span({
    [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.EMBEDDINGS,
    [GEN_AI.REQUEST_MODEL]: 'gemini-embedding-001',
    ...(replayed ? { [AGENT_NATIVE.REPLAYED]: true } : {}),
  });

function transcript(spans: SpanRecord[] | undefined): Transcript {
  return {
    runId: 'run-0',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [],
    nodeSequence: [],
    toolCalls: [],
    retrievedContext: [],
    tokenCounts: { prompt: 0, completion: 0 },
    outcome: 'success',
    latencyMs: 1,
    ...(spans === undefined ? {} : { spans }),
  };
}

const budgets = { inputTokens: 300, outputTokens: 1000, modelCalls: 3 };
const labels = (results: ReturnType<typeof checkBudgets>) =>
  Object.fromEntries(results.map((result) => [result.budget, result.label]));

describe('checkBudgets', () => {
  it('is within when every sum is at or under its ceiling, measured on live', () => {
    const results = checkBudgets(
      transcript([chat(100, 400), chat(200, 600), embedding()]),
      budgets,
      live,
    );

    expect(labels(results)).toEqual({
      inputTokens: 'within',
      outputTokens: 'within',
      modelCalls: 'within',
    });
    expect(results.map((result) => [result.actual, result.source])).toEqual([
      [300, 'measured'],
      [1000, 'measured'],
      [2, 'measured'],
    ]);
  });

  it('is breached over the ceiling, with the limit and the actual value', () => {
    const results = checkBudgets(
      transcript([chat(250, 400), chat(100, 700), chat(1, 1), chat(1, 1)]),
      budgets,
      live,
    );

    expect(labels(results)).toEqual({
      inputTokens: 'breached',
      outputTokens: 'breached',
      modelCalls: 'breached',
    });
    expect(results[0]).toMatchObject({ limit: 300, actual: 352 });
    expect(results[0]?.explanation).toContain('over by 52');
  });

  it('is unmeasurable, not zero, when a successful call carries no usage key', () => {
    const results = checkBudgets(transcript([chat(100, 400), chat(undefined, 600)]), budgets, live);

    expect(labels(results)).toEqual({
      inputTokens: 'unmeasurable',
      outputTokens: 'within',
      modelCalls: 'within',
    });
    expect(results[0]?.actual).toBeNull();
    expect(results[0]?.explanation).toContain('absent is not zero');
  });

  it('is unmeasurable on every budget when there is no inference span at all', () => {
    // The two ways a transcript can have nothing to read: spans collected but
    // none of them a model call, and no spans collected.
    for (const spans of [[embedding()], undefined]) {
      const results = checkBudgets(transcript(spans), budgets, replay);
      expect(labels(results)).toEqual({
        inputTokens: 'unmeasurable',
        outputTokens: 'unmeasurable',
        modelCalls: 'unmeasurable',
      });
    }
  });

  it('is unmeasurable on every budget when replayed and measured spans are mixed', () => {
    const results = checkBudgets(
      transcript([chat(10, 10, { replayed: true }), chat(10, 10)]),
      budgets,
      replay,
    );

    expect(labels(results)).toEqual({
      inputTokens: 'unmeasurable',
      outputTokens: 'unmeasurable',
      modelCalls: 'unmeasurable',
    });
    expect(results[0]?.explanation).toContain('neither');
  });

  it('counts an errored call toward modelCalls without making the token budgets unmeasurable', () => {
    const results = checkBudgets(
      transcript([chat(100, 400), errored(), errored(), chat(100, 400)]),
      budgets,
      live,
    );

    expect(labels(results)).toEqual({
      inputTokens: 'within',
      outputTokens: 'within',
      modelCalls: 'breached',
    });
    expect(results.find((result) => result.budget === 'modelCalls')?.actual).toBe(4);
  });

  it('says the figure is the recording’s when every inference span was replayed', () => {
    const results = checkBudgets(
      transcript([chat(100, 400, { replayed: true }), embedding(true)]),
      budgets,
      replay,
    );

    expect(results.every((result) => result.source === 'recorded')).toBe(true);
    expect(results[0]?.explanation).toContain('as recorded in the cassette');
  });

  it('checks nothing on model=stub, and nothing a task did not declare', () => {
    expect(checkBudgets(transcript([]), budgets, { model: 'stub', memory: 'live' })).toEqual([]);
    expect(checkBudgets(transcript([chat(1, 1)]), undefined, live)).toEqual([]);
    expect(
      checkBudgets(transcript([chat(1, 1)]), { modelCalls: 5 }, live).map((r) => r.budget),
    ).toEqual(['modelCalls']);
  });
});

const prices: PriceTable = {
  source: 'https://example.test/pricing',
  pageLastUpdated: '2026-10-07',
  readOn: '2026-10-08',
  tier: 'paid, standard',
  models: { 'gemini-2.5-flash': { inputUsdPerMTok: 0.3, outputUsdPerMTok: 2.5 } },
};

describe('estimateCost', () => {
  it('prices input and output per million tokens of the model the span names', () => {
    // 1,000,000 input × $0.30 + 2,000,000 output × $2.50
    const cost = estimateCost([chat(600_000, 1_500_000), chat(400_000, 500_000)], prices);
    expect(cost.usd).toBeCloseTo(0.3 + 5, 10);
    expect(cost.unpricedModels).toEqual([]);
  });

  it('names a model missing from the table as unpriced, and never costs it at zero', () => {
    const cost = estimateCost(
      [chat(1_000_000, 0), chat(1_000_000, 1_000_000, { model: 'gemini-9-ultra' })],
      prices,
    );
    expect(cost.usd).toBeCloseTo(0.3, 10);
    expect(cost.unpricedModels).toEqual(['gemini-9-ultra']);

    const nothingPriced = estimateCost([chat(1, 1, { model: 'gemini-9-ultra' })], prices);
    expect(nothingPriced.usd).toBeNull();
  });

  it('counts embedding calls and prices none of them', () => {
    const cost = estimateCost([chat(10, 10), embedding(), embedding()], prices);
    expect(cost.unpricedEmbeddingCalls).toBe(2);
  });

  it('prices nothing without a table', () => {
    expect(estimateCost([chat(10, 10)], undefined)).toEqual({
      usd: null,
      unpricedModels: ['gemini-2.5-flash'],
      unpricedEmbeddingCalls: 0,
    });
  });
});

describe('trialUsage', () => {
  it('sums latency over the model and embedding calls on the live axis only', () => {
    const measured = trialUsage('t', 0, transcript([chat(1, 1), embedding()]), prices);
    expect(measured.modelLatencyMs).toBe(200);

    const recorded = trialUsage(
      't',
      0,
      transcript([chat(1, 1, { replayed: true }), embedding(true)]),
      prices,
    );
    expect(recorded.source).toBe('recorded');
    expect(recorded.modelLatencyMs).toBeNull();
  });

  it('reports the thinking share beside the output it is part of', () => {
    const usage = trialUsage('t', 0, transcript([chat(10, 900, { reasoning: 850 })]));
    expect(usage).toMatchObject({ inputTokens: 10, outputTokens: 900, reasoningTokens: 850 });
  });
});
