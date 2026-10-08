import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAGE2_CONDITIONS } from '@repo/eval-harness';
import { RunsService } from '../runs/runs.service.js';
import { CHAT_MODEL } from '../agent/model/model-deps.js';
import {
  AnswerFileRefusedError,
  AnswerFileSchema,
  answerKey,
  promptHash,
  recordAnswers,
  replayAnswers,
  type AnswerFileHeader,
  type AnswerItem,
  type RecordAnswersOptions,
} from './answer-file.js';

const GIT = 'b'.repeat(40);
const QUERIES = ['relational-001', 'relational-002', 'relational-003'];

const header: AnswerFileHeader = {
  formatVersion: 1,
  decisionFormatVersion: 2,
  chatModel: CHAT_MODEL,
  datasetSha256: 'd'.repeat(64),
  labelsSha256: 'e'.repeat(64),
  queries: QUERIES,
};

const items: AnswerItem[] = QUERIES.flatMap((queryId) =>
  STAGE2_CONDITIONS.map((condition) => ({
    queryId,
    condition,
    systemPrompt: 'You are a helpful research assistant.',
    userPrompt: `user: ${queryId}?${condition === 'with' ? '\n\nConnections in memory:\n- context 1: a' : ''}`,
  })),
);

/** The free tier's per-day 429, as the client surfaces it. */
const dailyQuota = (): Error =>
  Object.assign(new Error('[429 Too Many Requests] You exceeded your current quota.'), {
    status: 429,
    errorDetails: [
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
      },
    ],
  });

/**
 * A fake model that answers each prompt with a string derived from it and
 * counts every call by prompt, so a call made twice cannot hide.
 */
function fakeModel(failOn: (callNumber: number) => Error | undefined = () => undefined) {
  const prompts: string[] = [];
  return {
    prompts,
    callLlm: async (_system: string, user: string) => {
      prompts.push(user);
      const failure = failOn(prompts.length);
      if (failure !== undefined) throw failure;
      return { content: `answer to ${user}`, tokenCounts: { prompt: 10, completion: 3 } };
    },
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'answer-file-'));
  path = join(dir, 'recorded', 'explanation-answers.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const options = (overrides: Partial<RecordAnswersOptions>): RecordAnswersOptions => ({
  path,
  header,
  items,
  callLlm: fakeModel().callLlm,
  maxCalls: 100,
  paceMs: 0,
  gitSha: GIT,
  now: () => new Date('2026-10-09T15:00:00.000Z'),
  ...overrides,
});

const onDisk = () => AnswerFileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

describe('recordAnswers', () => {
  it('asks every call once, in order, and writes the file after each', async () => {
    const model = fakeModel();
    const seenOnDisk: number[] = [];
    const outcome = await recordAnswers(
      options({
        callLlm: async (system, user) => {
          // What is on disk when the next call starts: every earlier answer.
          seenOnDisk.push(existsSync(path) ? Object.keys(onDisk().answers).length : 0);
          return model.callLlm(system, user);
        },
      }),
    );

    expect(outcome).toEqual({
      invocation: 1,
      requested: 6,
      recorded: 6,
      alreadyRecorded: 0,
      remaining: 0,
      stoppedBy: 'complete',
    });
    expect(model.prompts).toEqual(items.map((item) => item.userPrompt));
    expect(seenOnDisk).toEqual([0, 1, 2, 3, 4, 5]);

    const file = onDisk();
    const entry = file.answers[answerKey('relational-001', 'with')]!;
    expect(entry).toMatchObject({ queryId: 'relational-001', condition: 'with', invocation: 1 });
    // A cassette decision, keyed on the cassette's hash of the plan call.
    expect(entry.decision).toMatchObject({
      seam: 'plan.callLlm',
      requestHash: promptHash(items[1]!),
      tokenCounts: { prompt: 10, completion: 3 },
      response: { kind: 'value', value: { content: `answer to ${items[1]!.userPrompt}` } },
    });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('starts a query only if both its calls fit the budget', async () => {
    const model = fakeModel();
    const outcome = await recordAnswers(options({ callLlm: model.callLlm, maxCalls: 3 }));
    expect(outcome).toMatchObject({ requested: 2, recorded: 2, remaining: 4, stoppedBy: 'budget' });
    expect(Object.keys(onDisk().answers).sort()).toEqual([
      'relational-001/with',
      'relational-001/without',
    ]);
  });

  it('resumes where it stopped, never asking a recorded call again', async () => {
    const first = fakeModel();
    await recordAnswers(options({ callLlm: first.callLlm, maxCalls: 2 }));
    const second = fakeModel();
    const outcome = await recordAnswers(options({ callLlm: second.callLlm, maxCalls: 2 }));
    const third = fakeModel();
    const last = await recordAnswers(options({ callLlm: third.callLlm }));

    expect(outcome).toMatchObject({ invocation: 2, alreadyRecorded: 2, recorded: 2 });
    expect(last).toMatchObject({ invocation: 3, alreadyRecorded: 4, recorded: 2, remaining: 0 });
    const asked = [...first.prompts, ...second.prompts, ...third.prompts];
    expect(asked).toEqual(items.map((item) => item.userPrompt));
    expect(new Set(asked).size).toBe(asked.length);

    const file = onDisk();
    expect(Object.keys(file.answers)).toHaveLength(6);
    expect(file.answers['relational-003/with']!.invocation).toBe(3);

    // A fourth invocation has nothing to do, and asks nothing.
    const fourth = fakeModel();
    expect(await recordAnswers(options({ callLlm: fourth.callLlm }))).toMatchObject({
      stoppedBy: 'complete',
      requested: 0,
      alreadyRecorded: 6,
    });
    expect(fourth.prompts).toEqual([]);
  });

  it('stops on a daily-quota 429 without recording it, and finishes that pair first next time', async () => {
    const model = fakeModel((n) => (n === 4 ? dailyQuota() : undefined));
    const outcome = await recordAnswers(options({ callLlm: model.callLlm }));
    expect(outcome).toEqual({
      invocation: 1,
      requested: 4,
      recorded: 3,
      alreadyRecorded: 0,
      remaining: 3,
      stoppedBy: 'daily-quota',
      detail: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    });
    expect(Object.keys(onDisk().answers)).not.toContain('relational-002/with');

    const next = fakeModel();
    await recordAnswers(options({ callLlm: next.callLlm }));
    expect(next.prompts[0]).toBe(items[3]!.userPrompt); // relational-002/with
    expect(next.prompts).toHaveLength(3);
  });

  it('stops on a 429 the client could not retry past', async () => {
    const perMinute = Object.assign(new Error('Resource has been exhausted'), { status: 429 });
    const model = fakeModel((n) => (n === 1 ? perMinute : undefined));
    expect(await recordAnswers(options({ callLlm: model.callLlm }))).toMatchObject({
      stoppedBy: 'rate-limit',
      recorded: 0,
      detail: 'Resource has been exhausted',
    });
    expect(existsSync(path)).toBe(false);
  });

  it('throws any other failure with every earlier answer kept, and releases the lock', async () => {
    const model = fakeModel((n) => (n === 3 ? new Error('socket hang up') : undefined));
    await expect(recordAnswers(options({ callLlm: model.callLlm }))).rejects.toThrow(
      'socket hang up',
    );
    expect(Object.keys(onDisk().answers)).toHaveLength(2);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it('waits between calls, not before the first', async () => {
    const sleep = vi.fn(async () => undefined);
    await recordAnswers(options({ maxCalls: 4, paceMs: 13_000, sleep }));
    expect(sleep.mock.calls).toEqual([[13_000], [13_000], [13_000]]);
  });

  it('refuses to resume into a recording for another prompt, before any call', async () => {
    await recordAnswers(options({ maxCalls: 2 }));
    const changed = items.map((item, i) =>
      i === 1 ? { ...item, userPrompt: `${item.userPrompt} (changed)` } : item,
    );
    const model = fakeModel();
    await expect(
      recordAnswers(options({ items: changed, callLlm: model.callLlm })),
    ).rejects.toThrow('relational-001/with: recorded for another prompt than this run builds');
    expect(model.prompts).toEqual([]);
  });

  it('refuses to resume into a recording for another model or selection', async () => {
    await recordAnswers(options({ maxCalls: 2 }));
    await expect(
      recordAnswers(options({ header: { ...header, chatModel: 'gemini-x' } })),
    ).rejects.toThrow('chatModel is gemini-2.5-flash, running gemini-x');
    await expect(
      recordAnswers(options({ header: { ...header, queries: QUERIES.slice(1) } })),
    ).rejects.toThrow('another selection of 3 queries than this run');
  });

  it('refuses while a live recorder holds the lock, and takes over a dead one', async () => {
    await recordAnswers(options({ maxCalls: 2 }));

    // The parent of this test process is alive for as long as the test is.
    writeFileSync(`${path}.lock`, `${process.ppid}\n`);
    const model = fakeModel();
    await expect(recordAnswers(options({ callLlm: model.callLlm }))).rejects.toThrow(
      AnswerFileRefusedError,
    );
    expect(model.prompts).toEqual([]);

    // A process that has exited: a recorder killed mid-run.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid!;
    writeFileSync(`${path}.lock`, `${dead}\n`);
    expect(await recordAnswers(options({ callLlm: model.callLlm }))).toMatchObject({
      stoppedBy: 'complete',
      alreadyRecorded: 2,
      recorded: 4,
    });
  });
});

describe('replayAnswers', () => {
  it('serves what was recorded, part-recorded included, with no model', async () => {
    await recordAnswers(options({ maxCalls: 4 }));
    const answers = replayAnswers(JSON.parse(readFileSync(path, 'utf8')), header, items);
    expect([...answers.keys()].sort()).toEqual([
      'relational-001/with',
      'relational-001/without',
      'relational-002/with',
      'relational-002/without',
    ]);
    expect(answers.get('relational-002/without')!.content).toBe(
      `answer to ${items[2]!.userPrompt}`,
    );
  });

  it('refuses a prompt whose hash is not the recorded one', async () => {
    await recordAnswers(options({}));
    const changed = items.map((item) => ({ ...item, systemPrompt: 'Another system prompt.' }));
    expect(() => replayAnswers(JSON.parse(readFileSync(path, 'utf8')), header, changed)).toThrow(
      /relational-001\/without: recorded for another prompt/,
    );
  });

  it('refuses an answer filed under another key', async () => {
    await recordAnswers(options({}));
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    raw.answers['relational-001/with'] = raw.answers['relational-001/without'];
    expect(() => replayAnswers(raw, header, items)).toThrow(
      'relational-001/with: holds the answer for relational-001/without',
    );
  });
});

/**
 * Stubbed transport: the production client, `fetch` replaced, a fake key. No
 * request leaves the process. This is the path the runner records through.
 */
describe('recordAnswers through RunsService.modelDeps().plan.callLlm', () => {
  const fetchStub = vi.fn<typeof fetch>();
  const key = process.env['GOOGLE_API_KEY'];

  beforeEach(() => {
    fetchStub.mockReset();
    vi.stubGlobal('fetch', fetchStub);
    process.env['GOOGLE_API_KEY'] = 'fake-key';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (key === undefined) delete process.env['GOOGLE_API_KEY'];
    else process.env['GOOGLE_API_KEY'] = key;
  });

  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const answered = (text: string): Response =>
    json(200, {
      candidates: [
        { content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 },
      ],
      usageMetadata: { promptTokenCount: 42, candidatesTokenCount: 6, totalTokenCount: 48 },
    });
  const dailyQuotaResponse = (): Response =>
    json(429, {
      error: {
        code: 429,
        message: 'You exceeded your current quota.',
        status: 'RESOURCE_EXHAUSTED',
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
            violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
          },
        ],
      },
    });

  it('records an answer, stops on the first per-day 429 after one request, and resumes', async () => {
    fetchStub
      .mockImplementationOnce(async () => answered('Five business days.'))
      .mockImplementation(async () => dailyQuotaResponse());

    const callLlm = new RunsService(null, null, null, null, null, null).modelDeps().plan.callLlm;
    const outcome = await recordAnswers(options({ callLlm }));

    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(String(fetchStub.mock.calls[0]![0])).toContain(`${CHAT_MODEL}:generateContent`);
    expect(outcome).toMatchObject({
      requested: 2,
      recorded: 1,
      remaining: 5,
      stoppedBy: 'daily-quota',
      detail: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
    });
    expect(onDisk().answers['relational-001/without']!.decision).toMatchObject({
      response: { kind: 'value', value: { content: 'Five business days.' } },
      tokenCounts: { prompt: 42, completion: 6 },
    });

    fetchStub.mockReset();
    fetchStub.mockImplementation(async () => answered('Ask Kestrel Review.'));
    const resumed = await recordAnswers(options({ callLlm }));
    expect(fetchStub).toHaveBeenCalledTimes(5);
    expect(resumed).toMatchObject({ invocation: 2, recorded: 5, stoppedBy: 'complete' });
  });
});
