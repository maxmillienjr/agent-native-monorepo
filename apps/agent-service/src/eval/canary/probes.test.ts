import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGeminiEmbedder } from '../../agent/model/gemini-embedder.js';
import {
  EMBEDDING,
  FLOATING,
  PINNED,
  fakeFetch,
  healthyState,
  rawVector,
  testBaseline,
} from './fake-api.js';
import { chatVerdict, metadataVerdict, probeChatVersion, probeEmbeddings } from './probes.js';

/** Stubbed transport: `fetch` is replaced and no request leaves the process. */

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeChatVersion', () => {
  it('makes exactly one request, to the id it is given, and returns modelVersion', async () => {
    const api = fakeFetch(healthyState());
    vi.stubGlobal('fetch', api.fetch);

    const observation = await probeChatVersion(FLOATING, 'fake-key');

    expect(api.requests).toEqual([`POST /v1beta/models/${FLOATING}:generateContent`]);
    expect(observation.modelVersion).toBe('gemini-3.5-flash');
    expect(observation.finishReason).toBe('MAX_TOKENS');
    expect(observation.usage?.totalTokenCount).toBe(67);
  });

  it('yields unobserved, never unchanged, for a response without modelVersion', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = undefined;
    vi.stubGlobal('fetch', fakeFetch(state).fetch);

    const observation = await probeChatVersion(PINNED, 'fake-key');
    expect(observation.modelVersion).toBeUndefined();

    // Whatever the baseline holds — including nothing — a missing field is
    // not a match.
    for (const baseline of ['gemini-2.5-flash', undefined]) {
      expect(chatVerdict(observation, true, baseline).verdict).toBe('unobserved');
      expect(chatVerdict(observation, false, baseline).verdict).toBe('unobserved');
    }
  });

  it('reads a 404 as gone, and a string that differs as changed when pinned, moved when floating', () => {
    expect(chatVerdict({ id: PINNED, found: false }, true, 'x').verdict).toBe('gone');
    const observed = { id: PINNED, found: true, modelVersion: 'gemini-2.5-flash-002' };
    expect(chatVerdict(observed, true, 'gemini-2.5-flash').verdict).toBe('changed');
    expect(chatVerdict(observed, false, 'gemini-2.5-flash').verdict).toBe('moved');
    expect(chatVerdict(observed, true, 'gemini-2.5-flash-002').verdict).toBe('unchanged');
    // The first observation has nothing to match: red until a baseline is committed.
    expect(chatVerdict(observed, true, undefined).verdict).toBe('changed');
  });
});

describe('metadataVerdict', () => {
  const baseline = { version: '001', displayName: 'Gemini 2.5 Flash' };

  it('reads a 404 on a pinned id as gone, and a version that moved as changed', () => {
    expect(metadataVerdict(PINNED, true, baseline, 'not-found').verdict).toBe('gone');
    expect(metadataVerdict(PINNED, true, baseline, { ...baseline, version: '002' }).verdict).toBe(
      'changed',
    );
    expect(metadataVerdict(PINNED, true, baseline, baseline).verdict).toBe('unchanged');
    expect(metadataVerdict(FLOATING, false, baseline, { ...baseline, version: 'x' }).verdict).toBe(
      'moved',
    );
  });
});

describe('probeEmbeddings', () => {
  it('goes through createGeminiEmbedder and reports bit-identical vectors as unchanged', async () => {
    const api = fakeFetch(healthyState());
    vi.stubGlobal('fetch', api.fetch);
    const baseline = testBaseline().embedding;

    const result = await probeEmbeddings(createGeminiEmbedder('fake-key'), baseline);

    expect(result.verdict).toBe('unchanged');
    expect(result.observed).toBe('21 of 21 bit-identical');
    expect(result.baseline).toBe('2026-09-11');
    // The production embedder's request, once per baseline text, in order.
    expect(api.requests).toHaveLength(21);
    expect(new Set(api.requests)).toEqual(
      new Set([`POST /v1beta/models/${EMBEDDING}:embedContent`]),
    );
  });

  it('reports one differing component of one vector as changed, with its cosine', async () => {
    const state = healthyState();
    const nudged = rawVector('probe text 4');
    nudged[100] = nudged[100]! + 0.5;
    state.vectors['probe text 4'] = nudged;
    vi.stubGlobal('fetch', fakeFetch(state).fetch);

    const result = await probeEmbeddings(
      createGeminiEmbedder('fake-key'),
      testBaseline().embedding,
    );

    expect(result.verdict).toBe('changed');
    expect(result.observed).toBe('20 of 21 bit-identical');
    expect(result.detail).toMatch(
      /^1 of 21 vectors differ; min cosine 0\.99\d+ — #4 \(memory-recall-001\) 0\.99\d+$/,
    );
    expect(result.vectors).toHaveLength(21);
  });
});
