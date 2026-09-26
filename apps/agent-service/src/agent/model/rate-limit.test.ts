import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { abortError, renderAbortSummary } from '@repo/eval-harness';
import { createGeminiChat } from '../../runs/runs.service.js';
import { explainAbort } from '../../eval/abort-cause.js';
import { createGeminiEmbedder } from './gemini-embedder.js';
import { classifyRateLimit } from './rate-limit.js';

/**
 * Two bodies, modelled on Google's documented `google.rpc` error model.
 *
 * Synthetic, and said so: the free-tier 429 this repository hits has not yet
 * been captured from the wire. The live criterion in P1-C checks the classifier
 * against a real one; these check the plumbing on both model paths.
 */
const DAILY_QUOTA_DETAILS = [
  {
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [
      {
        quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
        quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
        quotaDimensions: { location: 'global', model: 'gemini-2.5-flash' },
        quotaValue: '20',
      },
    ],
  },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '43s' },
];

const PER_MINUTE_DETAILS = [
  {
    '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
    violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
  },
];

function tooManyRequests(details?: unknown[]): Response {
  const error = {
    code: 429,
    message: 'You exceeded your current quota.',
    status: 'RESOURCE_EXHAUSTED',
    ...(details === undefined ? {} : { details }),
  };
  return new Response(JSON.stringify({ error }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'content-type': 'application/json' },
  });
}

/** The abort summary a run ending on this error would publish, after two finished trials. */
function abortSummaryFor(error: unknown): string {
  const progress = {
    completed: [0, 1].map((index) => ({
      taskId: 'memory-recall-001',
      index,
      runId: `run-${index}`,
      passed: true,
      failedGraders: [],
    })),
  };
  const cause = explainAbort(error, progress);
  return renderAbortSummary({
    suite: 'memory-recall',
    startedAt: '2026-09-26T00:00:00.000Z',
    abortedAt: '2026-09-26T00:01:00.000Z',
    axes: { model: 'live', memory: 'live' },
    error: abortError(error),
    ...(cause === undefined ? {} : { cause }),
    completedTrials: progress.completed,
  });
}

describe('classifyRateLimit', () => {
  it('is undefined for anything that is not a 429', () => {
    expect(classifyRateLimit(new Error('boom'))).toBeUndefined();
    expect(classifyRateLimit({ status: 503, errorDetails: DAILY_QUOTA_DETAILS })).toBeUndefined();
    expect(classifyRateLimit(undefined)).toBeUndefined();
  });

  it('reads a per-day QuotaFailure violation as a daily quota', () => {
    expect(classifyRateLimit({ status: 429, errorDetails: DAILY_QUOTA_DETAILS })).toBe(
      'daily-quota',
    );
  });

  it('leaves a per-minute quota, a detail-less 429 and a malformed detail unclassified', () => {
    expect(classifyRateLimit({ status: 429, errorDetails: PER_MINUTE_DETAILS })).toBe(
      'unclassified',
    );
    expect(classifyRateLimit({ status: 429 })).toBe('unclassified');
    expect(
      classifyRateLimit({
        status: 429,
        errorDetails: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: 'x' }],
      }),
    ).toBe('unclassified');
  });
});

/**
 * Stubbed transport: `fetch` is replaced and no request leaves the process.
 * The key is fake for the same reason.
 */
describe('a 429 on the chat path', () => {
  const fetchStub = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('makes one request when the details name a per-day quota', async () => {
    fetchStub.mockImplementation(async () => tooManyRequests(DAILY_QUOTA_DETAILS));

    const error: unknown = await createGeminiChat('fake-key')
      .invoke('hello')
      .catch((caught: unknown) => caught);

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(classifyRateLimit(error)).toBe('daily-quota');
    expect(abortSummaryFor(error)).toContain(
      '**Cause (`daily-quota`):** daily `generateContent` quota exhausted after 2 completed trials ' +
        '(`GenerateRequestsPerDayPerProjectPerModel-FreeTier`)',
    );
  });

  it('still makes seven requests for a 429 without those details', async () => {
    // The client's six retries back off exponentially — 92 seconds when this
    // was measured with real timers — so the clock is faked and run forward.
    vi.useFakeTimers();
    fetchStub.mockImplementation(async () => tooManyRequests());

    const settled = createGeminiChat('fake-key', { json: true })
      .invoke('hello')
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    for (let step = 0; step < 20 && fetchStub.mock.calls.length < 7; step++) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const error = await settled;

    expect(fetchStub).toHaveBeenCalledTimes(7);
    expect(classifyRateLimit(error)).toBe('unclassified');
    expect(abortSummaryFor(error)).toContain('**Cause (`rate-limit-unclassified`):**');
  });
});

describe('a 429 on the embed path', () => {
  const fetchStub = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('makes one request, and keeps the details a daily quota is classified by', async () => {
    fetchStub.mockImplementation(async () => tooManyRequests(DAILY_QUOTA_DETAILS));

    const error: unknown = await createGeminiEmbedder('fake-key')('hello').catch(
      (caught: unknown) => caught,
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(classifyRateLimit(error)).toBe('daily-quota');
    expect(abortSummaryFor(error)).toContain(
      '**Cause (`daily-quota`):** daily `embedContent` quota exhausted after 2 completed trials',
    );
  });

  it('makes one request for a 429 without those details too', async () => {
    fetchStub.mockImplementation(async () => tooManyRequests());

    const error: unknown = await createGeminiEmbedder('fake-key')('hello').catch(
      (caught: unknown) => caught,
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(classifyRateLimit(error)).toBe('unclassified');
    expect(abortSummaryFor(error)).toContain('**Cause (`rate-limit-unclassified`):**');
  });
});
