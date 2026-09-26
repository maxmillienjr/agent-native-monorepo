import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFloat32Base64 } from '@repo/agent-cassette';
import { EmbeddingRequestError } from '../agent/model/gemini-embedder.js';
import {
  EmbeddingFileRefusedError,
  readEmbeddingsMode,
  recordEmbeddings,
  replayEmbeddings,
  textKey,
  type EmbeddingFile,
  type EmbeddingExpectation,
} from './embedding-file.js';

const DIMS = 4;
const SHA = 'a'.repeat(64);
const GIT = 'b'.repeat(40);
const expected: EmbeddingExpectation = {
  embeddingModel: 'model-x',
  embeddingDimensions: DIMS,
  datasetSha256: SHA,
};

/** A deterministic stand-in embedder that counts its calls. */
function fakeEmbedder(): { embed: (text: string) => Promise<number[]>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    embed: async (text) => {
      calls.push(text);
      return [text.length, 0.5, 0.25, 0.125];
    },
  };
}

const file = (
  overrides: Partial<EmbeddingFile['header']> = {},
  texts = ['one', 'two'],
): EmbeddingFile => ({
  header: {
    formatVersion: 1,
    embeddingModel: 'model-x',
    embeddingDimensions: DIMS,
    recordedAt: '2026-09-26T00:00:00.000Z',
    gitSha: GIT,
    datasetSha256: SHA,
    ...overrides,
  },
  vectors: Object.fromEntries(texts.map((t) => [textKey(t), encodeFloat32Base64([1, 2, 3, 4])])),
});

describe('replayEmbeddings', () => {
  it('serves the recorded vector for each text', () => {
    const { embed } = replayEmbeddings(file(), expected, ['one', 'two']);
    expect(embed('one')).toEqual([1, 2, 3, 4]);
  });

  it('refuses a file recorded with a different embedding model', () => {
    expect(() => replayEmbeddings(file({ embeddingModel: 'model-y' }), expected, ['one'])).toThrow(
      /embeddingModel is model-y, running model-x/,
    );
  });

  it('refuses a file recorded at a different width', () => {
    expect(() => replayEmbeddings(file({ embeddingDimensions: 8 }), expected, ['one'])).toThrow(
      /embeddingDimensions is 8, running 4/,
    );
  });

  it('refuses a file recorded against a different dataset', () => {
    expect(() =>
      replayEmbeddings(file({ datasetSha256: 'c'.repeat(64) }), expected, ['one']),
    ).toThrow(/datasetSha256 is c+, the dataset is a+/);
  });

  it('refuses a file missing any vector the run needs', () => {
    expect(() => replayEmbeddings(file(), expected, ['one', 'three'])).toThrow(
      EmbeddingFileRefusedError,
    );
    expect(() => replayEmbeddings(file(), expected, ['one', 'three'])).toThrow(
      /missing 1 vector\(s\), first: "three"/,
    );
  });
});

describe('recordEmbeddings', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'embedding-file-'));
    path = join(dir, 'recorded', 'embeddings.json');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes a vector for every distinct text, in a file replay accepts', async () => {
    const fake = fakeEmbedder();
    const outcome = await recordEmbeddings({
      path,
      texts: ['one', 'two', 'one'],
      embed: fake.embed,
      expected,
      gitSha: GIT,
    });

    expect(outcome).toEqual({ requested: 2, alreadyRecorded: 0, remaining: 0, rateLimited: false });
    expect(fake.calls).toEqual(['one', 'two']);
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    expect(replayEmbeddings(raw, expected, ['one', 'two']).embed('two')).toEqual([
      3, 0.5, 0.25, 0.125,
    ]);
  });

  it('resumes without re-embedding what is already recorded', async () => {
    await recordEmbeddings({
      path,
      texts: ['one'],
      embed: fakeEmbedder().embed,
      expected,
      gitSha: GIT,
    });

    const fake = fakeEmbedder();
    const outcome = await recordEmbeddings({
      path,
      texts: ['one', 'two'],
      embed: fake.embed,
      expected,
      gitSha: GIT,
    });

    expect(fake.calls).toEqual(['two']);
    expect(outcome).toMatchObject({ requested: 1, alreadyRecorded: 1, remaining: 0 });
  });

  it('writes the same bytes whether recorded in one pass or resumed', async () => {
    const now = () => new Date('2026-09-26T12:00:00.000Z');
    await recordEmbeddings({
      path,
      texts: ['two', 'one'],
      embed: fakeEmbedder().embed,
      expected,
      gitSha: GIT,
      now,
    });
    const single = readFileSync(path, 'utf8');

    rmSync(path);
    await recordEmbeddings({
      path,
      texts: ['one'],
      embed: fakeEmbedder().embed,
      expected,
      gitSha: GIT,
      now,
    });
    await recordEmbeddings({
      path,
      texts: ['two', 'one'],
      embed: fakeEmbedder().embed,
      expected,
      gitSha: GIT,
      now,
    });
    expect(readFileSync(path, 'utf8')).toBe(single);
  });

  it('stops on the first 429 and reports how many texts remain', async () => {
    const calls: string[] = [];
    const outcome = await recordEmbeddings({
      path,
      texts: ['one', 'two', 'three', 'four'],
      embed: async (text) => {
        calls.push(text);
        if (text === 'two') {
          throw new EmbeddingRequestError(
            'embedContent failed: 429 {"error":{"details":[{"violations":[' +
              '{"quotaId": "EmbedContentRequestsPerMinutePerProjectPerModel"}]}]}}',
            429,
          );
        }
        return [1, 1, 1, 1];
      },
      expected,
      gitSha: GIT,
    });

    expect(outcome).toEqual({
      requested: 2,
      alreadyRecorded: 0,
      remaining: 3,
      rateLimited: true,
      // Named, because a per-minute wall is a pause and a per-day wall is a day.
      rateLimitDetail: 'EmbedContentRequestsPerMinutePerProjectPerModel',
    });
    // Nothing after the 429 was attempted, and what came before it was kept.
    expect(calls).toEqual(['one', 'two']);
    const kept = JSON.parse(readFileSync(path, 'utf8')) as EmbeddingFile;
    expect(Object.keys(kept.vectors)).toEqual([textKey('one')]);
  });

  it('throws any other failure after keeping what it recorded', async () => {
    await expect(
      recordEmbeddings({
        path,
        texts: ['one', 'two'],
        embed: async (text) => {
          if (text === 'two') throw new EmbeddingRequestError('embedContent failed: 500', 500);
          return [1, 1, 1, 1];
        },
        expected,
        gitSha: GIT,
      }),
    ).rejects.toThrow(/500/);
    const kept = JSON.parse(readFileSync(path, 'utf8')) as EmbeddingFile;
    expect(Object.keys(kept.vectors)).toEqual([textKey('one')]);
  });

  it('refuses to resume into a file recorded against a different dataset', async () => {
    await recordEmbeddings({
      path,
      texts: ['one'],
      embed: fakeEmbedder().embed,
      expected,
      gitSha: GIT,
    });
    await expect(
      recordEmbeddings({
        path,
        texts: ['one'],
        embed: fakeEmbedder().embed,
        expected: { ...expected, datasetSha256: 'd'.repeat(64) },
        gitSha: GIT,
      }),
    ).rejects.toThrow(/refusing to resume/);
  });

  it('refuses a vector of the wrong width', async () => {
    await expect(
      recordEmbeddings({ path, texts: ['one'], embed: async () => [1, 2], expected, gitSha: GIT }),
    ).rejects.toThrow(/returned 2 values, expected 4/);
  });
});

describe('readEmbeddingsMode', () => {
  it('defaults to replay, the recorded axis', () => {
    expect(readEmbeddingsMode({})).toBe('replay');
    expect(readEmbeddingsMode({ EVAL_EMBEDDINGS_MODE: '' })).toBe('replay');
    expect(readEmbeddingsMode({ EVAL_EMBEDDINGS_MODE: 'record' })).toBe('record');
    expect(readEmbeddingsMode({ EVAL_EMBEDDINGS_MODE: 'live' })).toBe('live');
  });

  it('refuses a value it does not know rather than picking an axis', () => {
    expect(() => readEmbeddingsMode({ EVAL_EMBEDDINGS_MODE: 'recorded' })).toThrow(
      /replay, record or live/,
    );
  });
});
