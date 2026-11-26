import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsService, createGeminiChat } from '../../runs/runs.service.js';
import { selectionRequest } from '../tools/selection.js';
import { classifyRateLimit } from './rate-limit.js';
import { ProviderUnavailableError, serverErrorStatus } from './server-errors.js';

/**
 * Stubbed transport: `fetch` is replaced and no request leaves the process.
 * The key is fake for the same reason. The client's backoff is real time, so
 * the clock is faked and run forward until the call settles.
 */

/** Google's 503 body, as the canary of 2026-11-07 received it. */
function unavailable(): Response {
  const error = {
    code: 503,
    message: 'This model is currently experiencing high demand. Please try again later.',
    status: 'UNAVAILABLE',
  };
  return new Response(JSON.stringify({ error }), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'content-type': 'application/json' },
  });
}

function dailyQuota(): Response {
  const error = {
    code: 429,
    message: 'You exceeded your current quota.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
    ],
  };
  return new Response(JSON.stringify({ error }), {
    status: 429,
    statusText: 'Too Many Requests',
    headers: { 'content-type': 'application/json' },
  });
}

function answer(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Settles `call` with the clock faked, stepping it forward until it does. */
async function settle<T>(call: Promise<T>): Promise<T | unknown> {
  let done = false;
  const settled = call.then(
    (value) => value,
    (caught: unknown) => caught,
  );
  void settled.finally(() => (done = true));
  for (let step = 0; step < 40 && !done; step++) {
    await vi.advanceTimersByTimeAsync(30_000);
  }
  return settled;
}

describe('a 5xx on the chat path', () => {
  const fetchStub = vi.fn<typeof fetch>();
  const key = process.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    if (key === undefined) delete process.env['GOOGLE_API_KEY'];
    else process.env['GOOGLE_API_KEY'] = key;
  });

  it('makes four requests with the bound, and throws ProviderUnavailableError', async () => {
    fetchStub.mockImplementation(async () => unavailable());

    const error = await settle(
      createGeminiChat('fake-key', { boundServerErrors: true }).invoke('hello'),
    );

    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as ProviderUnavailableError).status).toBe(503);
    expect((error as Error).message).toMatch(/^generateContent answered 503 on 4 consecutive/);
  });

  it('spaces the retries, so a burst of 503s a minute long is waited out', async () => {
    // Three 503s, then an answer: the shape of the nights of 2026-11-20 to 11-26,
    // where one retry two seconds later met the same burst.
    fetchStub
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(answer('a plan'));
    const started = Date.now();

    const reply = await settle(
      createGeminiChat('fake-key', { boundServerErrors: true }).invoke('hello'),
    );

    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect((reply as { content: unknown }).content).toBe('a plan');
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_000 + 15_000 + 60_000);
  });

  it('answers with the bound when the retry succeeds', async () => {
    fetchStub.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(answer('a plan'));

    const reply = await settle(
      createGeminiChat('fake-key', { boundServerErrors: true }).invoke('hello'),
    );

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect((reply as { content: unknown }).content).toBe('a plan');
  });

  it("keeps stopOnDailyQuota's rule with the bound: one request for a daily-quota 429", async () => {
    fetchStub.mockImplementation(async () => dailyQuota());

    const error = await settle(
      createGeminiChat('fake-key', { boundServerErrors: true, json: true }).invoke('hello'),
    );

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(classifyRateLimit(error)).toBe('daily-quota');
  });

  it("makes LangChain's default seven requests without the bound", async () => {
    fetchStub.mockImplementation(async () => unavailable());

    const error = await settle(createGeminiChat('fake-key').invoke('hello'));

    expect(fetchStub).toHaveBeenCalledTimes(7);
    expect(error).not.toBeInstanceOf(ProviderUnavailableError);
    expect(serverErrorStatus(error)).toBe(503);
  });

  it("keeps the default retries on the service's request path", async () => {
    // What a request builds: no `setChatOptions` call, which only `yarn eval`
    // makes.
    process.env['GOOGLE_API_KEY'] = 'fake-key';
    fetchStub.mockImplementation(async () => unavailable());

    const callLlm = new RunsService(null, null, null, null, null).modelDeps().plan.callLlm;
    const error = await settle(callLlm('system', 'user'));

    expect(fetchStub).toHaveBeenCalledTimes(7);
    expect(error).not.toBeInstanceOf(ProviderUnavailableError);
    expect(serverErrorStatus(error)).toBe(503);
  });

  it('bounds the service once `yarn eval` sets the option', async () => {
    process.env['GOOGLE_API_KEY'] = 'fake-key';
    fetchStub.mockImplementation(async () => unavailable());

    const runs = new RunsService(null, null, null, null, null);
    runs.setChatOptions({ boundServerErrors: true });
    const { act } = runs.modelDeps();
    const error = await settle(act.selectTool(selectionRequest('a plan', act.registry, [])));

    expect(fetchStub).toHaveBeenCalledTimes(4);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
  });
});
