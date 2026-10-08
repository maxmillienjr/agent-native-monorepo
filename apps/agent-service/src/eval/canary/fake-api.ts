import { channel } from 'node:diagnostics_channel';
import { encodeFloat32Base64 } from '@repo/agent-cassette';
import { EMBEDDING_DIMENSIONS, l2Normalize } from '@repo/memory-core';
import type { CanaryBaseline } from './baseline.js';

/**
 * A stand-in for the Gemini API, for the canary's stubbed-transport tests.
 *
 * It replaces `fetch`, so no request leaves the process, and it publishes each
 * request on `undici:request:create` the way undici does, so the runner's
 * request counter is exercised by its subscription rather than bypassed.
 */

export const PINNED = 'gemini-2.5-flash';
export const EMBEDDING = 'gemini-embedding-001';
export const FLOATING = 'gemini-flash-latest';

/** Deterministic, distinct per text, and not unit-norm, so `l2Normalize` has work to do. */
export function rawVector(text: string): number[] {
  let seed = 0;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 9973;
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (((seed + i * 37) % 101) - 50) / 7);
}

/** What the embedder stores for a text: normalised, then float32. */
export function recordedVector(text: string): string {
  return encodeFloat32Base64(l2Normalize(rawVector(text)));
}

export const PROBE_TEXTS = Array.from({ length: 21 }, (_, i) => `probe text ${i}`);

export function testBaseline(overrides: Partial<CanaryBaseline> = {}): CanaryBaseline {
  return {
    formatVersion: 1,
    metadata: {
      [PINNED]: { version: '001', displayName: 'Gemini 2.5 Flash', observedAt: '2026-10-01' },
      [EMBEDDING]: {
        version: '001',
        displayName: 'Gemini Embedding 001',
        observedAt: '2026-10-01',
      },
      [FLOATING]: {
        version: 'Gemini Flash Latest',
        displayName: 'Gemini Flash Latest',
        observedAt: '2026-10-01',
      },
    },
    chat: {
      [PINNED]: { modelVersion: 'gemini-2.5-flash', observedAt: '2026-10-01' },
      [FLOATING]: { modelVersion: 'gemini-3.5-flash', observedAt: '2026-10-01' },
    },
    embedding: {
      model: EMBEDDING,
      dimensions: EMBEDDING_DIMENSIONS,
      since: '2026-09-11',
      source: 'test',
      probes: PROBE_TEXTS.map((text, i) => ({
        taskId: i < 14 ? 'memory-recall-001' : 'tool-use-001',
        text,
        float32Base64: recordedVector(text),
      })),
    },
    ...overrides,
  };
}

export interface FakeApiState {
  metadata: Record<string, { version: string; displayName: string } | 404>;
  /** `undefined` leaves the field out of the response. */
  modelVersion: Record<string, string | undefined | 404>;
  /** Overrides the vector returned for a text. */
  vectors: Record<string, number[]>;
  /** A response to return instead, for a matching path. */
  failWith?: { readonly match: RegExp; readonly status: number; readonly body: unknown };
}

export function healthyState(): FakeApiState {
  return {
    metadata: {
      [PINNED]: { version: '001', displayName: 'Gemini 2.5 Flash' },
      [EMBEDDING]: { version: '001', displayName: 'Gemini Embedding 001' },
      [FLOATING]: { version: 'Gemini Flash Latest', displayName: 'Gemini Flash Latest' },
    },
    modelVersion: { [PINNED]: 'gemini-2.5-flash', [FLOATING]: 'gemini-3.5-flash' },
    vectors: {},
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A `fetch` that answers as the API does, and the list of requests it saw. */
export function fakeFetch(state: FakeApiState): {
  fetch: typeof fetch;
  requests: string[];
} {
  const requests: string[] = [];
  const published = channel('undici:request:create');

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.pathname}`);
    published.publish({ request: { origin: url.origin, path: url.pathname, method } });

    if (state.failWith !== undefined && state.failWith.match.test(url.pathname)) {
      return json(state.failWith.status, state.failWith.body);
    }

    const [, model, action] = /\/v1beta\/models\/([^/:]+)(?::(\w+))?$/.exec(url.pathname) ?? [];
    if (model === undefined) return json(400, { error: { message: 'unexpected path' } });

    if (action === undefined) {
      const entry = state.metadata[model];
      if (entry === undefined || entry === 404) return json(404, { error: { code: 404 } });
      return json(200, { name: `models/${model}`, ...entry });
    }

    if (action === 'generateContent') {
      const version = state.modelVersion[model];
      if (version === 404) return json(404, { error: { code: 404 } });
      return json(200, {
        candidates: [{ finishReason: 'MAX_TOKENS', content: { role: 'model' } }],
        usageMetadata: { promptTokenCount: 7, thoughtsTokenCount: 60, totalTokenCount: 67 },
        ...(version === undefined ? {} : { modelVersion: version }),
        responseId: 'r',
      });
    }

    if (action === 'embedContent') {
      const body = JSON.parse(String(init?.body)) as { content: { parts: { text: string }[] } };
      const text = body.content.parts[0]!.text;
      return json(200, { embedding: { values: state.vectors[text] ?? rawVector(text) } });
    }

    return json(400, { error: { message: `unexpected action ${action}` } });
  };

  return { fetch: fetchImpl as typeof fetch, requests };
}

/** A 429 whose details name a per-day quota, as the free tier sends one. */
export const DAILY_QUOTA_BODY = {
  error: {
    code: 429,
    message: 'You exceeded your current quota.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
        ],
      },
    ],
  },
};
