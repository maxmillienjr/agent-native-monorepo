import { describe, it, expect } from 'vitest';
import { buildRetrievalDataset, type Corpus } from './dataset.js';
import { adjudicatedLabels, PoolCandidatesFileSchema, renderPoolFiles } from './adjudication.js';

const corpus: Corpus = {
  sessionId: '00000000-0000-4000-8000-0000000000ff',
  episodes: [
    {
      episodeId: '00000000-0000-4000-8000-000000000001',
      entities: [{ id: 'a', label: 'Alpha', description: '' }],
      relationships: [],
      facts: [
        { id: 'e1-f1', text: 'Alpha one.', mentions: ['a'] },
        { id: 'e1-f2', text: 'Alpha two.', mentions: ['a'] },
        { id: 'e1-f3', text: 'Alpha three.', mentions: ['a'] },
      ],
    },
  ],
};
const SHA = 'e'.repeat(64);
const dataset = buildRetrievalDataset(
  corpus,
  [{ id: 'q1', stratum: 'paraphrase', text: 'Alpha?', relevant: ['e1-f1'], goldSeeds: ['a'] }],
  SHA,
);
const hash = (handle: string) => dataset.facts.get(handle)!.contentHash;

const key = {
  datasetSha256: SHA,
  key: [
    { candidateId: 'c0001', queryId: 'q1', handle: 'e1-f2' },
    { candidateId: 'c0002', queryId: 'q1', handle: 'e1-f3' },
  ],
};
const adjudicator = { name: 'a model', kind: 'model' as const };

describe('adjudicatedLabels', () => {
  it('adds what the adjudicator judged relevant to the pre-registered labels', () => {
    const result = adjudicatedLabels(dataset, key, {
      adjudicator,
      decisions: [
        { id: 'c0001', relevant: true },
        { id: 'c0002', relevant: false },
      ],
    });
    expect([...result.labels.get('q1')!].sort()).toEqual([hash('e1-f1'), hash('e1-f2')].sort());
    expect(result).toMatchObject({ judgedRelevant: 1, candidates: 2, adjudicator });
  });

  it('refuses a partial adjudication', () => {
    expect(() =>
      adjudicatedLabels(dataset, key, {
        adjudicator,
        decisions: [{ id: 'c0001', relevant: true }],
      }),
    ).toThrow(/1 candidate\(s\) undecided, first c0002/);
  });

  it('refuses a decision twice over, or for a candidate the key does not hold', () => {
    expect(() =>
      adjudicatedLabels(dataset, key, {
        adjudicator,
        decisions: [
          { id: 'c0001', relevant: true },
          { id: 'c0001', relevant: false },
          { id: 'c0002', relevant: false },
          { id: 'c9999', relevant: true },
        ],
      }),
    ).toThrow(
      /decided twice[\s\S]*unknown candidate c9999|unknown candidate c9999[\s\S]*decided twice/,
    );
  });

  it('refuses a key from another dataset', () => {
    expect(() =>
      adjudicatedLabels(
        dataset,
        { ...key, datasetSha256: 'f'.repeat(64) },
        { adjudicator, decisions: [] },
      ),
    ).toThrow(/belongs to dataset f+/);
  });
});

describe('renderPoolFiles', () => {
  it('writes candidates with instructions and no key, and the key on its own', () => {
    const files = renderPoolFiles(SHA, {
      queries: [{ id: 'q001', text: 'Alpha?', candidates: [{ id: 'c0001', text: 'Alpha two.' }] }],
      key: [{ candidateId: 'c0001', queryId: 'q1', handle: 'e1-f2' }],
    });
    const candidates = PoolCandidatesFileSchema.parse(JSON.parse(files.candidates));
    expect(candidates.instructions).toMatch(/Judge the text alone/);
    expect(files.candidates).not.toContain('e1-f2');
    expect(JSON.parse(files.key)).toEqual({
      datasetSha256: SHA,
      key: [{ candidateId: 'c0001', queryId: 'q1', handle: 'e1-f2' }],
    });
  });
});
