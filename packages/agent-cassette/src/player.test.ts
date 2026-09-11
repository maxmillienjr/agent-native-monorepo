import { describe, expect, it, vi } from 'vitest';
import { requestHash } from './hash.js';
import {
  CassetteIncompatibleError,
  CassetteMissError,
  CassettePlayer,
  ReplayedError,
} from './player.js';
import { encodeFloat32Base64 } from './vector.js';
import type { Decision, DecisionCall, DecisionResponse, ReplayConfig } from './types.js';

const CONFIG: ReplayConfig = {
  chatModel: 'gemini-2.5-flash',
  embeddingModel: 'gemini-embedding-001',
  embeddingDimensions: 768,
};

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    taskId: 'memory-recall-001',
    trialIndex: 0,
    recordedAt: '2026-01-01T00:00:00.000Z',
    gitSha: 'a'.repeat(40),
    axes: { model: 'live', memory: 'live' },
    ...CONFIG,
    ...overrides,
  };
}

function decision(call: DecisionCall, response: DecisionResponse): Decision {
  return {
    seam: call.seam,
    ...(call.label === undefined ? {} : { label: call.label }),
    requestHash: requestHash(call),
    request: call.request,
    response,
    latencyMs: 1,
  };
}

function cassette(decisions: Decision[], headerOverrides: Record<string, unknown> = {}): unknown {
  return { header: header(headerOverrides), decisions };
}

/** A player that has been handed a live function it must never reach for. */
function neverLive(): () => Promise<never> {
  return vi.fn<() => Promise<never>>(() =>
    Promise.reject(new Error('replay fell through to a live call')),
  );
}

const PLAN: DecisionCall = { seam: 'plan.callLlm', request: { system: 'You plan.', user: 'hi' } };

describe('CassettePlayer lookup', () => {
  it('serves a recorded value without calling live', async () => {
    const live = neverLive();
    const player = new CassettePlayer(
      cassette([decision(PLAN, { kind: 'value', value: { content: 'a plan' } })]),
      CONFIG,
    );

    await expect(player.resolve(PLAN, live)).resolves.toEqual({ content: 'a plan' });
    expect(live).not.toHaveBeenCalled();
    expect(player.remaining()).toBe(0);
  });

  it('consumes a queue in recorded order and does not reuse the head', async () => {
    const player = new CassettePlayer(
      cassette([
        decision(PLAN, { kind: 'value', value: 'first' }),
        decision(PLAN, { kind: 'value', value: 'second' }),
      ]),
      CONFIG,
    );

    await expect(player.resolve(PLAN, neverLive())).resolves.toBe('first');
    await expect(player.resolve(PLAN, neverLive())).resolves.toBe('second');
    // An empty queue is a miss. Serving `second` a second time would turn one
    // recorded sample into as many passes as the suite asks for.
    await expect(player.resolve(PLAN, neverLive())).rejects.toBeInstanceOf(CassetteMissError);
  });

  it('decodes a recorded vector back to the floats the embedder returned', async () => {
    const vector = Array.from({ length: 768 }, (_, i) => i / 10_000);
    const call: DecisionCall = { seam: 'embed', request: 'a fact' };
    const player = new CassettePlayer(
      cassette([decision(call, { kind: 'vector', float32Base64: encodeFloat32Base64(vector) })]),
      CONFIG,
    );

    await expect(player.resolve(call, neverLive())).resolves.toEqual(
      Array.from(Float32Array.from(vector)),
    );
  });

  it('keeps two tools with the same input in separate queues', async () => {
    const upper: DecisionCall = { seam: 'act.tool', label: 'uppercase', request: { text: 'x' } };
    const reverse: DecisionCall = { seam: 'act.tool', label: 'reverse', request: { text: 'x' } };
    const player = new CassettePlayer(
      cassette([
        decision(upper, { kind: 'value', value: 'X' }),
        decision(reverse, { kind: 'value', value: 'x' }),
      ]),
      CONFIG,
    );

    await expect(player.resolve(reverse, neverLive())).resolves.toBe('x');
    await expect(player.resolve(upper, neverLive())).resolves.toBe('X');
  });
});

describe('a miss', () => {
  it('names the seam, the request hash and the diff of recorded against actual', async () => {
    const player = new CassettePlayer(
      cassette([decision(PLAN, { kind: 'value', value: 'a plan' })]),
      CONFIG,
    );
    const edited: DecisionCall = {
      seam: 'plan.callLlm',
      request: { system: 'You plan carefully.', user: 'hi' },
    };

    const error = await player.resolve(edited, neverLive()).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CassetteMissError);
    if (!(error instanceof CassetteMissError)) throw new Error('expected a miss');

    expect(error.seam).toBe('plan.callLlm');
    expect(error.missedRequestHash).toBe(requestHash(edited));
    expect(error.message).toContain('plan.callLlm');
    expect(error.message).toContain(requestHash(edited));
    expect(error.diff).toMatch(/^- +"system": "You plan\.",$/m);
    expect(error.diff).toMatch(/^\+ +"system": "You plan carefully\.",$/m);
    // The unchanged half is context, not noise: it is what says the prompt
    // moved rather than the request being for something else entirely.
    expect(error.diff).toMatch(/^ {4}"user": "hi"$/m);
  });

  it('says so plainly when nothing was recorded at the seam at all', async () => {
    const player = new CassettePlayer(cassette([]), CONFIG);

    await expect(player.resolve(PLAN, neverLive())).rejects.toThrow(/no decision was recorded/);
  });
});

describe('replay refuses', () => {
  it('a header recorded off the live model axis', () => {
    expect(
      () => new CassettePlayer(cassette([], { axes: { model: 'stub', memory: 'live' } }), CONFIG),
    ).toThrow(CassetteIncompatibleError);

    expect(
      () => new CassettePlayer(cassette([], { axes: { model: 'stub', memory: 'live' } }), CONFIG),
    ).toThrow(/model axis "stub"/);
  });

  it('a chatModel that differs from the running configuration', () => {
    expect(() => new CassettePlayer(cassette([], { chatModel: 'gemini-1.5-pro' }), CONFIG)).toThrow(
      /chatModel is `gemini-1.5-pro`/,
    );
  });

  it('an embeddingModel that differs from the running configuration', () => {
    expect(
      () => new CassettePlayer(cassette([], { embeddingModel: 'text-embedding-004' }), CONFIG),
    ).toThrow(/embeddingModel is `text-embedding-004`/);
  });

  it('an embeddingDimensions that differs from the running configuration', () => {
    expect(() => new CassettePlayer(cassette([], { embeddingDimensions: 1536 }), CONFIG)).toThrow(
      /embeddingDimensions is 1536/,
    );
  });

  it('a formatVersion that is not 1', () => {
    expect(() => new CassettePlayer(cassette([], { formatVersion: 2 }), CONFIG)).toThrow(
      /formatVersion is 2, this player reads 1/,
    );
  });

  it('collects every configuration mismatch rather than the first', () => {
    const error = (() => {
      try {
        new CassettePlayer(
          cassette([], { chatModel: 'other-chat', embeddingDimensions: 1536 }),
          CONFIG,
        );
        return undefined;
      } catch (thrown: unknown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(CassetteIncompatibleError);
    if (!(error instanceof CassetteIncompatibleError)) throw new Error('expected a refusal');
    expect(error.reasons).toHaveLength(2);
  });
});

describe('a recorded retry', () => {
  it('replays an error then a success as two attempts, reproducing IO_RETRY', async () => {
    // Two entries under one hash: attempt 1 threw live, the node's retry
    // policy re-ran it with the same input, and attempt 2 succeeded.
    const player = new CassettePlayer(
      cassette([
        decision(PLAN, {
          kind: 'error',
          name: 'GoogleGenerativeAIFetchError',
          message: 'got 429 Too Many Requests',
          status: 429,
        }),
        decision(PLAN, { kind: 'value', value: { content: 'a plan' } }),
      ]),
      CONFIG,
    );

    const attempt = async (): Promise<unknown> => player.resolve(PLAN, neverLive());

    const first = await attempt().catch((thrown: unknown) => thrown);
    expect(first).toBeInstanceOf(ReplayedError);
    if (!(first instanceof ReplayedError)) throw new Error('expected the recorded failure');
    expect(first.name).toBe('GoogleGenerativeAIFetchError');
    expect(first.status).toBe(429);

    await expect(attempt()).resolves.toEqual({ content: 'a plan' });
    expect(player.remaining()).toBe(0);
  });
});
