import { describe, expect, it, vi } from 'vitest';
import { CassetteRecordRefusedError, CassetteRecorder } from './recorder.js';
import { CassetteSchema, type Cassette } from './types.js';
import { decodeFloat32Base64 } from './vector.js';

const GIT_SHA = 'a'.repeat(40);

/** Key-shaped and not a key, assembled so the fixture is not itself scannable. */
const KEY_SHAPED = ['AI', 'za', 'x'.repeat(35)].join('');

function header(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    formatVersion: 1,
    taskId: 'memory-recall-001',
    trialIndex: 0,
    recordedAt: '2026-01-01T00:00:00.000Z',
    gitSha: GIT_SHA,
    axes: { model: 'live', memory: 'live' },
    chatModel: 'gemini-2.5-flash',
    embeddingModel: 'gemini-embedding-001',
    embeddingDimensions: 768,
    ...overrides,
  };
}

describe('CassetteRecorder', () => {
  it('appends what the live call returned and writes a schema-valid cassette', async () => {
    const written: Cassette[] = [];
    const recorder = new CassetteRecorder({
      header: header(),
      sink: (cassette) => void written.push(cassette),
    });

    const answer = await recorder.resolve({ seam: 'plan.callLlm', request: { user: 'hi' } }, () =>
      Promise.resolve({ content: 'a plan', promptTokens: 10 }),
    );

    expect(answer).toEqual({ content: 'a plan', promptTokens: 10 });

    const cassette = await recorder.close();
    expect(CassetteSchema.safeParse(cassette).success).toBe(true);
    expect(written).toEqual([cassette]);
    expect(cassette.decisions).toHaveLength(1);
    expect(cassette.decisions[0]?.response).toEqual({
      kind: 'value',
      value: { content: 'a plan', promptTokens: 10 },
    });
  });

  it('records an embedding as base64 float32 rather than a JSON float array', async () => {
    const recorder = new CassetteRecorder({ header: header() });
    const vector = Array.from({ length: 768 }, (_, i) => i / 1000);

    await recorder.resolve({ seam: 'embed', request: 'a fact' }, () => Promise.resolve(vector));
    const [decision] = (await recorder.close()).decisions;

    expect(decision?.response.kind).toBe('vector');
    if (decision?.response.kind !== 'vector') throw new Error('expected a vector response');
    expect(decodeFloat32Base64(decision.response.float32Base64)).toEqual(
      Array.from(Float32Array.from(vector)),
    );
  });

  it('records a failure, redacts it, and re-throws so the run fails as it did live', async () => {
    const recorder = new CassetteRecorder({ header: header() });
    const failure = Object.assign(
      new Error(`got 429 from https://generativelanguage.googleapis.com/v1?key=${KEY_SHAPED}`),
      { name: 'GoogleGenerativeAIFetchError', status: 429 },
    );

    await expect(
      recorder.resolve({ seam: 'plan.callLlm', request: { user: 'hi' } }, () =>
        Promise.reject(failure),
      ),
    ).rejects.toThrow(failure);

    const [decision] = (await recorder.close()).decisions;
    expect(decision?.response).toEqual({
      kind: 'error',
      name: 'GoogleGenerativeAIFetchError',
      message: 'got 429 from https://generativelanguage.googleapis.com/v1?key=[REDACTED]',
      status: 429,
    });
  });

  it('refuses to record off the live model axis', () => {
    expect(
      () => new CassetteRecorder({ header: header({ axes: { model: 'stub', memory: 'live' } }) }),
    ).toThrow(CassetteRecordRefusedError);

    expect(
      () => new CassetteRecorder({ header: header({ axes: { model: 'stub', memory: 'live' } }) }),
    ).toThrow(/model=stub memory=live/);
  });

  it('refuses an unconfigured memory axis for the same reason', () => {
    expect(
      () =>
        new CassetteRecorder({
          header: header({ axes: { model: 'live', memory: 'unconfigured' } }),
        }),
    ).toThrow(CassetteRecordRefusedError);
  });

  it('names the invalid header field when the problem is not the axes', () => {
    expect(() => new CassetteRecorder({ header: header({ gitSha: 'short' }) })).toThrow(/gitSha/);
  });

  it('records the latency of the live call', async () => {
    const now = vi.fn<() => number>().mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);
    const recorder = new CassetteRecorder({ header: header(), now });

    await recorder.resolve({ seam: 'embed', request: 'x' }, () => Promise.resolve([0.5]));

    expect((await recorder.close()).decisions[0]?.latencyMs).toBe(250);
  });

  it('carries token counts when the caller can supply them', async () => {
    const recorder = new CassetteRecorder({
      header: header(),
      tokenCountsFor: () => ({ prompt: 120, completion: 30 }),
    });

    await recorder.resolve({ seam: 'plan.callLlm', request: { user: 'hi' } }, () =>
      Promise.resolve({ content: 'a plan' }),
    );

    expect((await recorder.close()).decisions[0]?.tokenCounts).toEqual({
      prompt: 120,
      completion: 30,
    });
  });

  it('refuses a second close, which would be a second write nobody asked for', async () => {
    const recorder = new CassetteRecorder({ header: header() });
    await recorder.close();

    await expect(recorder.close()).rejects.toThrow(CassetteRecordRefusedError);
  });
});
