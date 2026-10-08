import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanaryBaseline } from './baseline.js';
import {
  DAILY_QUOTA_BODY,
  EMBEDDING,
  FLOATING,
  PINNED,
  fakeFetch,
  healthyState,
  rawVector,
  testBaseline,
  type FakeApiState,
} from './fake-api.js';
import { readProbeSelection, runCanary, type CanaryAbort, type CanaryReport } from './runner.js';

/**
 * The runner against a stand-in API: `fetch` is replaced, no request leaves
 * the process, and every request is published on `undici:request:create` so
 * the counts in the report come from the runner's own subscription.
 *
 * One test per row of the PRD's verdict table.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'canary-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

async function run(
  state: FakeApiState,
  options: { baseline?: CanaryBaseline; update?: (b: CanaryBaseline) => void } = {},
) {
  const api = fakeFetch(state);
  vi.stubGlobal('fetch', api.fetch);
  const end = await runCanary({
    outputDir: dir,
    apiKey: 'fake-key',
    baseline: () => options.baseline ?? testBaseline(),
    ...(options.update === undefined ? {} : { update: options.update }),
    now: () => new Date('2026-10-08T03:00:00.000Z'),
  });
  return { end, api };
}

const report = (): CanaryReport =>
  JSON.parse(readFileSync(join(dir, 'canary-report.json'), 'utf8')) as CanaryReport;
const summary = (): string => readFileSync(join(dir, 'canary-summary.md'), 'utf8');
const verdictOf = (probe: string, id: string): string | undefined =>
  report().results.find((result) => result.probe === probe && result.id === id)?.verdict;

describe('one canary run', () => {
  it('makes 3 metadata, 2 generateContent and 21 embedContent requests, and prints the counts', async () => {
    const { end, api } = await run(healthyState());

    expect(end).toBe('passed');
    expect(report().requests).toEqual({
      metadata: 3,
      generateContent: 2,
      embedContent: 21,
      other: 0,
    });
    expect(api.requests).toHaveLength(26);
    expect(summary()).toContain(
      '**Requests:** 3 `models.get`, 2 `generateContent`, 21 `embedContent`.',
    );
    expect(summary()).toMatch(/^## Canary — unchanged/);
    expect(summary()).toContain(
      'has returned identical vectors since 2026-09-11, on all 21 baseline texts',
    );
    expect(existsSync(join(dir, 'canary-abort.json'))).toBe(false);
  });
});

describe('the verdict table', () => {
  it('metadata: a 404 on a pinned id is gone, exits 1, and writes the report', async () => {
    const state = healthyState();
    state.metadata[EMBEDDING] = 404;
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('metadata', EMBEDDING)).toBe('gone');
    expect(report().result).toBe('failed');
    expect(summary()).toMatch(/^## Canary — drift/);
  });

  it('metadata: a pinned version that moved is changed, and exits 1', async () => {
    const state = healthyState();
    state.metadata[PINNED] = { version: '002', displayName: 'Gemini 2.5 Flash' };
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('metadata', PINNED)).toBe('changed');
    expect(summary()).toContain('CANARY_BASELINE=update yarn canary');
  });

  it('chat, pinned: a changed modelVersion exits 1', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = 'gemini-2.5-flash-preview-11-2026';
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('chat-pinned', PINNED)).toBe('changed');
    // The cassettes replay the old model's answers, so the summary names the re-record too.
    expect(summary()).toContain('EVAL_CASSETTE_MODE=record EVAL_TRIALS=1 yarn eval');
  });

  it('chat, pinned: a missing modelVersion is unobserved and exits 1', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = undefined;
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('chat-pinned', PINNED)).toBe('unobserved');
  });

  it('chat, pinned: a 404 is gone and exits 1', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = 404;
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('chat-pinned', PINNED)).toBe('gone');
  });

  it('chat, floating: a moved alias exits 0 with a notice', async () => {
    const state = healthyState();
    state.modelVersion[FLOATING] = 'gemini-4-flash';
    const { end } = await run(state);

    expect(end).toBe('passed');
    expect(verdictOf('chat-floating', FLOATING)).toBe('moved');
    expect(summary()).toContain(
      '**Notice:** the floating alias `gemini-flash-latest` is `moved` on chat-floating, now `gemini-4-flash`',
    );
  });

  it('chat, floating: a missing modelVersion is a notice, not a failure', async () => {
    const state = healthyState();
    state.modelVersion[FLOATING] = undefined;
    const { end } = await run(state);

    expect(end).toBe('passed');
    expect(verdictOf('chat-floating', FLOATING)).toBe('unobserved');
    expect(summary()).toContain('**Notice:**');
  });

  it('embedding: one changed vector exits 1 and reports its cosine', async () => {
    const state = healthyState();
    const nudged = rawVector('probe text 17');
    nudged[0] = nudged[0]! + 1;
    state.vectors['probe text 17'] = nudged;
    const { end } = await run(state);

    expect(end).toBe('failed');
    expect(verdictOf('embedding', EMBEDDING)).toBe('changed');
    expect(summary()).toMatch(/1 of 21 vectors differ; min cosine 0\.99\d+ — #17 \(tool-use-001\)/);
    expect(summary()).not.toContain('has returned identical vectors');
  });
});

describe('an abort', () => {
  it('on a per-day 429 from the chat probe: one request, an abort file naming the quota, no report', async () => {
    const state = healthyState();
    state.failWith = { match: /:generateContent$/, status: 429, body: DAILY_QUOTA_BODY };
    const { end, api } = await run(state);

    expect(end).toBe('aborted');
    expect(api.requests.filter((request) => request.endsWith(':generateContent'))).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(['canary-abort.json', 'canary-summary.md']);

    const abort = JSON.parse(readFileSync(join(dir, 'canary-abort.json'), 'utf8')) as CanaryAbort;
    expect(abort.cause?.code).toBe('daily-quota');
    expect(abort.requests.generateContent).toBe(1);
    // The metadata probes finished before it, and are kept.
    expect(abort.completed.map((result) => result.probe)).toEqual([
      'metadata',
      'metadata',
      'metadata',
    ]);
    expect(summary()).toMatch(/^## Canary — aborted/);
    expect(summary()).toContain(
      'daily `generateContent` quota exhausted (`GenerateRequestsPerDayPerProjectPerModel-FreeTier`)',
    );
  });

  it('without a key: names the variable and makes no request', async () => {
    const api = fakeFetch(healthyState());
    vi.stubGlobal('fetch', api.fetch);

    const end = await runCanary({
      outputDir: dir,
      apiKey: '',
      baseline: () => {
        throw new Error('the baseline should not be read before the key is checked');
      },
    });

    expect(end).toBe('aborted');
    expect(api.requests).toEqual([]);
    expect(existsSync(join(dir, 'canary-report.json'))).toBe(false);
    expect(summary()).toContain('GOOGLE_API_KEY');
    const abort = JSON.parse(readFileSync(join(dir, 'canary-abort.json'), 'utf8')) as CanaryAbort;
    expect(abort.cause?.code).toBe('no-key');
    expect(abort.requests).toEqual({ metadata: 0, generateContent: 0, embedContent: 0, other: 0 });
  });
});

describe('CANARY_BASELINE=update', () => {
  it('writes what was observed, dated, keeps an unchanged embedding date, and goes green', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = 'gemini-2.5-flash-002';
    let written: CanaryBaseline | undefined;
    const { end } = await run(state, { update: (baseline) => (written = baseline) });

    expect(end).toBe('passed');
    expect(written?.chat[PINNED]).toEqual({
      modelVersion: 'gemini-2.5-flash-002',
      observedAt: '2026-10-08',
    });
    // Unchanged entries keep the date they were first observed.
    expect(written?.chat[FLOATING]?.observedAt).toBe('2026-10-01');
    expect(written?.embedding.since).toBe('2026-09-11');
    expect(report().baselineUpdated).toBe(true);
    expect(summary()).toContain('**The baseline was rewritten**');
  });

  it('cannot accept a missing modelVersion', async () => {
    const state = healthyState();
    state.modelVersion[PINNED] = undefined;
    let written: CanaryBaseline | undefined;
    const { end } = await run(state, { update: (baseline) => (written = baseline) });

    expect(end).toBe('failed');
    expect(written?.chat[PINNED]?.modelVersion).toBe('gemini-2.5-flash');
  });

  it('takes a first observation into an empty chat baseline', async () => {
    let written: CanaryBaseline | undefined;
    const { end } = await run(healthyState(), {
      baseline: testBaseline({ chat: {} }),
      update: (baseline) => (written = baseline),
    });

    expect(end).toBe('passed');
    expect(written?.chat).toEqual({
      [PINNED]: { modelVersion: 'gemini-2.5-flash', observedAt: '2026-10-08' },
      [FLOATING]: { modelVersion: 'gemini-3.5-flash', observedAt: '2026-10-08' },
    });
  });
});

describe('CANARY_PROBES', () => {
  it('runs a subset, says what was left out, and refuses a name it does not know', async () => {
    expect(readProbeSelection(undefined)).toEqual([
      'metadata',
      'chat-pinned',
      'chat-floating',
      'embedding',
    ]);
    expect(readProbeSelection('embedding, metadata')).toEqual(['metadata', 'embedding']);
    expect(() => readProbeSelection('embedding,chat')).toThrow(/`chat`/);

    const api = fakeFetch(healthyState());
    vi.stubGlobal('fetch', api.fetch);
    const end = await runCanary({
      outputDir: dir,
      apiKey: 'fake-key',
      baseline: () => testBaseline(),
      probes: readProbeSelection('metadata,embedding'),
    });

    expect(end).toBe('passed');
    expect(report().requests.generateContent).toBe(0);
    expect(report().notRun).toEqual(['chat-pinned', 'chat-floating']);
    expect(summary()).toContain('**Not run (CANARY_PROBES):** chat-pinned, chat-floating');
  });
});
