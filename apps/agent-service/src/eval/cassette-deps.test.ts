import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from '@repo/memory-core';
import {
  CassetteMissError,
  CassettePlayer,
  CassetteRecorder,
  CassetteRecordRefusedError,
  type Cassette,
  type Deck,
} from '@repo/agent-cassette';
import { CHAT_MODEL, RunsService, type ModelDeps } from '../runs/runs.service.js';
import { recordingModelDeps, replayModelDeps, tokenCountsFor } from './cassette-deps.js';

/**
 * Every construction of the chat client, counted.
 *
 * "Replay never falls through to a live call" is a claim about what exists in
 * the process, not about what the network saw — a client that is constructed
 * and never used makes no request either, and proves nothing about the next
 * change. Counting constructions is what makes the claim checkable. The stand-in
 * also keeps this file's other specs off the network by construction.
 */
const { geminiConstructions } = vi.hoisted(() => ({ geminiConstructions: [] as string[] }));

vi.mock('@langchain/google-genai', () => ({
  ChatGoogleGenerativeAI: class {
    constructor(options: { model: string }) {
      geminiConstructions.push(options.model);
    }
    invoke() {
      throw new Error('the stand-in chat client was invoked, which no spec here should do');
    }
  },
}));

const liveHeader = {
  formatVersion: 1 as const,
  taskId: 'memory-recall-001',
  trialIndex: 0,
  recordedAt: '2026-09-10T12:00:00.000Z',
  gitSha: 'a'.repeat(40),
  axes: { model: 'live', memory: 'live' },
  chatModel: CHAT_MODEL,
  embeddingModel: EMBEDDING_MODEL,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
};

const replayConfig = {
  chatModel: CHAT_MODEL,
  embeddingModel: EMBEDDING_MODEL,
  embeddingDimensions: EMBEDDING_DIMENSIONS,
};

/** A model half that answers without a network, and counts what it was asked. */
function fakeLive(calls: string[]): ModelDeps {
  return {
    plan: {
      callLlm: async (systemPrompt, userPrompt) => {
        calls.push(`plan:${systemPrompt}|${userPrompt}`);
        return { content: 'a plan', tokenCounts: { prompt: 11, completion: 7 } };
      },
    },
    act: {
      tools: [
        {
          name: 'web-search',
          execute: async (input) => {
            calls.push(`tool:${JSON.stringify(input)}`);
            return { results: ['a result'] };
          },
        },
      ],
      selectTool: async (plan) => {
        calls.push(`select:${plan}`);
        return { toolName: 'web-search', input: { q: 'langgraph' } };
      },
    },
    distill: {
      extractEntities: async (context) => {
        calls.push(`extract:${context}`);
        return { entities: [], relationships: [], facts: [{ text: 'a fact' }] };
      },
    },
    embed: async (text) => {
      calls.push(`embed:${text}`);
      // Quarters, which are exactly representable in float32. A recorded vector
      // round-trips with equality; an arbitrary float64 one would round, which
      // is the loss pgvector's `float4` column makes on the way in anyway.
      return new Array(EMBEDDING_DIMENSIONS).fill(0).map((_, i) => ((i % 8) - 4) * 0.25);
    },
  };
}

/** Drives every seam once, in the order a run would. */
async function exercise(deps: ModelDeps): Promise<unknown[]> {
  const plan = await deps.plan.callLlm('system', 'user');
  const selection = await deps.act.selectTool('a plan', deps.act.tools);
  const tool = deps.act.tools.find((entry) => entry.name === selection?.toolName);
  const output = await tool!.execute(selection!.input);
  const extraction = await deps.distill.extractEntities('a conversation');
  const vector = await deps.embed('a fact');

  return [plan, selection, output, extraction, vector];
}

async function record(live: ModelDeps): Promise<{ cassette: Cassette; results: unknown[] }> {
  const recorder = new CassetteRecorder({ header: liveHeader, tokenCountsFor });
  const results = await exercise(recordingModelDeps(live, recorder));
  return { cassette: await recorder.close(), results };
}

describe('the recording and replay directions of the same seam', () => {
  it('replays every seam without the live set being reachable', async () => {
    const calls: string[] = [];
    const { cassette, results } = await record(fakeLive(calls));
    expect(calls).toHaveLength(5);

    const replayed = await exercise(replayModelDeps(new CassettePlayer(cassette, replayConfig)));

    // Same answers, and `replayModelDeps` has no argument through which a live
    // set could have been reached.
    expect(replayed).toEqual(results);
    expect(calls).toHaveLength(5);
  });

  it('records the five seams the PRD names, and the tool under its own label', async () => {
    const { cassette } = await record(fakeLive([]));

    expect(cassette.decisions.map((decision) => decision.seam)).toEqual([
      'plan.callLlm',
      'act.selectTool',
      'act.tool',
      'distill.extractEntities',
      'embed',
    ]);
    expect(cassette.decisions[2]!.label).toBe('web-search');
  });

  it('stores the embedding as a vector rather than a JSON float array', async () => {
    const { cassette } = await record(fakeLive([]));
    const embed = cassette.decisions.at(-1)!;

    expect(embed.response.kind).toBe('vector');
    // The saving that makes a committed set affordable: 4 bytes a dimension
    // before base64, against roughly 21 as JSON text.
    expect(JSON.stringify(embed.response).length).toBeLessThan(EMBEDDING_DIMENSIONS * 8);
  });

  it('records the token counts it can actually reach, and claims no others', async () => {
    const { cassette } = await record(fakeLive([]));

    expect(cassette.decisions[0]!.tokenCounts).toEqual({ prompt: 11, completion: 7 });
    // `selectTool` and `extractEntities` return a parsed value; their usage
    // metadata is gone before this wrapper sees it. P1-F owns the rest.
    expect(cassette.decisions[1]!.tokenCounts).toBeUndefined();
  });

  it('misses rather than inventing an answer when the prompt moves', async () => {
    const { cassette } = await record(fakeLive([]));
    const replayed = replayModelDeps(new CassettePlayer(cassette, replayConfig));

    await expect(replayed.plan.callLlm('system', 'a different user prompt')).rejects.toThrow(
      CassetteMissError,
    );
  });

  it('refuses to record off the live model axis', () => {
    // The refusal is the header schema's two literals, which is what makes
    // `EVAL_CASSETTE_MODE=record` on the stub axis impossible rather than
    // merely discouraged.
    expect(
      () =>
        new CassetteRecorder({
          header: { ...liveHeader, axes: { model: 'stub', memory: 'live' } },
        }),
    ).toThrow(CassetteRecordRefusedError);
  });
});

/**
 * The premise the whole scheme rests on, asserted by running rather than by
 * reading five call sites: no recorded request depends on the `runId`.
 *
 * It is what lets a replayed run mint a fresh id, write under it, and still be
 * graded by `episodic_row_written` and `entity_merged`. A node that starts
 * interpolating the run id into a prompt breaks replay silently — every trial
 * after it misses on its first decision — and this is the test that names the
 * cause instead.
 */
describe('request hashes across two runs of the same task', () => {
  const key = process.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    // `getDeps` reads the key per request. Left alone, this spec would build a
    // Gemini client and make real calls on a developer's machine.
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  async function hashesOfOneRun(): Promise<string[]> {
    // Every memory dependency null: the stub writers and the stub retrieval
    // facade, which is what makes this a unit test. The model half is the stub
    // set, decorated by a recorder that keeps the hashes.
    const service = new RunsService(null, null, null, null, null);
    const recorder = new CassetteRecorder({ header: liveHeader });
    service.setModelDecorator((live) => recordingModelDeps(live, recorder));

    await service.executeTraced({
      body: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'what did we say about langgraph?' }],
      },
      correlationId: 'eval-hash-stability',
    });

    const cassette = await recorder.close();
    return cassette.decisions.map((decision) => decision.requestHash);
  }

  it('are identical, because no request carries the run id', async () => {
    const first = await hashesOfOneRun();
    const second = await hashesOfOneRun();

    expect(first.length).toBeGreaterThan(0);
    expect(second).toEqual(first);
  });
});

/** One canned answer per seam, so a stand-in deck can serve a whole run. */
const seamAnswers: Record<string, unknown> = {
  'plan.callLlm': { content: 'a plan', tokenCounts: { prompt: 1, completion: 1 } },
  'act.selectTool': null,
  'distill.extractEntities': { entities: [], relationships: [], facts: [] },
  embed: new Array(EMBEDDING_DIMENSIONS).fill(0),
};

describe('the decorator seam on RunsService', () => {
  const key = process.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    if (key !== undefined) process.env['GOOGLE_API_KEY'] = key;
  });

  it('never touches the memory half', async () => {
    const service = new RunsService(null, null, null, null, null);
    const seen: string[] = [];

    // A decorator that replaces the model half entirely, which is what replay
    // does. If `retrieve` and `reflect` were assembled from anything but the
    // decorated set, the run would use two different embedders.
    service.setModelDecorator(() => ({
      plan: {
        callLlm: async () => ({ content: 'a plan', tokenCounts: { prompt: 1, completion: 1 } }),
      },
      act: { tools: [], selectTool: async () => null },
      distill: {
        extractEntities: async () => ({ entities: [], relationships: [], facts: [] }),
      },
      embed: async (text) => {
        seen.push(text);
        return new Array(EMBEDDING_DIMENSIONS).fill(0);
      },
    }));

    const traced = await service.executeTraced({
      body: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'hello' }],
      },
      correlationId: 'eval-decorator',
    });

    expect(traced.response.runId).toMatch(/[0-9a-f-]{36}/);
    // `retrieve.embedQuery` is the decorated `embed`, so the query reached it.
    expect(seen).toContain('hello');
  });

  it('does not build the axis it decorates until the decorator asks for it', async () => {
    // The structural half of "replay never falls through to a live call": with
    // a key in the environment and a decorator that ignores its argument, no
    // chat client is constructed at all. A deck that answers every seam stands
    // in for the player.
    process.env['GOOGLE_API_KEY'] = 'a-key-that-is-never-used';
    geminiConstructions.length = 0;

    const deck: Deck = {
      mode: 'replay',
      resolve: async <R>(call: { seam: string }): Promise<R> => seamAnswers[call.seam] as R,
    };

    const service = new RunsService(null, null, null, null, null);
    service.setModelDecorator(() => replayModelDeps(deck));

    await expect(
      service.executeTraced({
        body: {
          sessionId: '550e8400-e29b-41d4-a716-446655440000',
          messages: [{ role: 'user', content: 'hello' }],
        },
        correlationId: 'eval-no-client',
      }),
    ).resolves.toBeDefined();

    expect(geminiConstructions).toEqual([]);
  });

  it('builds it the moment the decorator reads it, which is what makes the count mean something', async () => {
    // The contrast. Nothing else in the run changes: the same key, the same
    // deck, the same graph — only that the decorator touches its argument, and
    // the two chat clients then exist.
    process.env['GOOGLE_API_KEY'] = 'a-key-that-is-never-used';
    geminiConstructions.length = 0;

    const deck: Deck = {
      mode: 'replay',
      resolve: async <R>(call: { seam: string }): Promise<R> => seamAnswers[call.seam] as R,
    };

    const service = new RunsService(null, null, null, null, null);
    service.setModelDecorator((live) => {
      // `tools` is the one member of the lazy set that has to resolve it.
      void live.act.tools;
      return replayModelDeps(deck);
    });

    await service.executeTraced({
      body: {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'hello' }],
      },
      correlationId: 'eval-client-built',
    });

    // Two: prose, and the `json: true` instance that stops Gemini fencing a
    // JSON answer.
    expect(geminiConstructions).toEqual([CHAT_MODEL, CHAT_MODEL]);
  });
});
