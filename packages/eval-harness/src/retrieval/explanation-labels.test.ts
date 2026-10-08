import { describe, it, expect } from 'vitest';
import { buildRetrievalDataset, type Corpus, type LabelledQuery } from './dataset.js';
import {
  answerKeyPresent,
  deriveGoldPaths,
  explanationLabelProblems,
  normalizeAnswerText,
  pathKey,
  type ExplanationLabels,
} from './explanation-labels.js';

const EP1 = '00000000-0000-4000-8000-000000000001';
const EP2 = '00000000-0000-4000-8000-000000000002';
const SHA = 'a'.repeat(64);

/**
 * `plan_a` reaches `vendor_b` by two edge types, so a relational pair about the
 * vendor's fact has two gold paths. The vendor's facts live in an episode that
 * never mentions the plan, which is the relational construction.
 */
const corpus: Corpus = {
  sessionId: '00000000-0000-4000-8000-0000000000ff',
  episodes: [
    {
      episodeId: EP1,
      entities: [
        { id: 'plan_a', label: 'Alpha Plan', description: '' },
        { id: 'vendor_b', label: 'Bravo Review', description: '' },
      ],
      relationships: [
        { fromId: 'plan_a', toId: 'vendor_b', type: 'DELEGATES_TO', confidence: 0.9 },
        { fromId: 'vendor_b', toId: 'plan_a', type: 'REVIEWS_FOR', confidence: 0.9 },
      ],
      facts: [
        { id: 'e1-f1', text: 'Alpha Plan has a 1,800 dollar deductible.', mentions: ['plan_a'] },
      ],
    },
    {
      episodeId: EP2,
      entities: [{ id: 'vendor_b', label: 'Bravo Review', description: '' }],
      relationships: [],
      facts: [{ id: 'e2-f1', text: 'Bravo Review decides in five days.', mentions: ['vendor_b'] }],
    },
  ],
};

const queries: LabelledQuery[] = [
  {
    id: 'p1',
    stratum: 'paraphrase',
    text: 'What is the Alpha Plan deductible?',
    relevant: ['e1-f1'],
    goldSeeds: ['plan_a'],
  },
  {
    id: 'r1',
    stratum: 'relational',
    text: 'How fast does the reviewer for Alpha Plan decide?',
    relevant: ['e2-f1'],
    goldSeeds: ['plan_a'],
  },
  {
    id: 'n1',
    stratum: 'no-entity',
    text: 'how long does a review take?',
    relevant: ['e2-f1'],
    goldSeeds: [],
  },
];

const dataset = buildRetrievalDataset(corpus, queries, SHA);

const valid = (): ExplanationLabels => ({
  datasetSha256: SHA,
  pairs: deriveGoldPaths(dataset),
  answerKeys: { r1: ['five days', '5 days'] },
});

describe('deriveGoldPaths', () => {
  it('derives one [A, type, B] per edge type for a relational pair', () => {
    const pair = deriveGoldPaths(dataset).find((p) => p.queryId === 'r1')!;
    expect(pair.factHandle).toBe('e2-f1');
    expect(pair.gold).toEqual([
      { concepts: ['plan_a', 'vendor_b'], edgeTypes: ['DELEGATES_TO'] },
      { concepts: ['plan_a', 'vendor_b'], edgeTypes: ['REVIEWS_FOR'] },
    ]);
  });

  it('derives [A] for a paraphrase pair and nothing for a no-entity pair', () => {
    const pairs = deriveGoldPaths(dataset);
    expect(pairs.find((p) => p.queryId === 'p1')!.gold).toEqual([
      { concepts: ['plan_a'], edgeTypes: [] },
    ]);
    expect(pairs.find((p) => p.queryId === 'n1')!.gold).toEqual([]);
  });

  it('labels every (query, relevant fact) pair, in query order', () => {
    expect(deriveGoldPaths(dataset).map((p) => p.queryId)).toEqual(['p1', 'r1', 'n1']);
  });
});

describe('pathKey', () => {
  it('interleaves concepts and edge types, so the order over paths is total', () => {
    expect(pathKey({ concepts: ['a', 'b', 'c'], edgeTypes: ['X', 'Y'] })).toBe('a|X|b|Y|c');
    expect(pathKey({ concepts: ['a'], edgeTypes: [] })).toBe('a');
  });
});

describe('normalizeAnswerText', () => {
  it('lowercases, collapses whitespace, drops digit-group commas and spells numbers as digits', () => {
    expect(normalizeAnswerText('  Five   Business days ')).toBe('5 business days');
    expect(normalizeAnswerText('about 2,300 physicians')).toBe('about 2300 physicians');
    expect(normalizeAnswerText('the twentieth week')).toBe('the twentieth week');
  });

  it('accepts either spelling of a number in an answer', () => {
    expect(answerKeyPresent('It takes 5 business days.', ['five business days'])).toBe(true);
    expect(answerKeyPresent('It takes FIVE business days.', ['5 business days'])).toBe(true);
    expect(answerKeyPresent('It takes a week.', ['5 business days'])).toBe(false);
  });
});

describe('explanationLabelProblems', () => {
  it('accepts labels derived from the dataset with a fitting answer key', () => {
    expect(explanationLabelProblems(dataset, valid())).toEqual([]);
  });

  it('refuses labels written against another dataset', () => {
    const labels = { ...valid(), datasetSha256: 'b'.repeat(64) };
    expect(explanationLabelProblems(dataset, labels)).toEqual([
      expect.stringContaining('not aaaa'),
    ]);
  });

  it('refuses a pair whose fact is not pre-registered relevant, and reports the pair left unlabelled', () => {
    const labels = valid();
    labels.pairs[0] = { ...labels.pairs[0]!, factHandle: 'e2-f1' };
    const problems = explanationLabelProblems(dataset, labels);
    expect(problems).toContain('pair p1/e2-f1: e2-f1 is not a pre-registered relevant fact');
    expect(problems).toContain('pair p1/e1-f1: not labelled');
  });

  it('refuses a gold concept or edge the corpus does not hold', () => {
    const labels = valid();
    labels.pairs[1] = {
      queryId: 'r1',
      factHandle: 'e2-f1',
      gold: [{ concepts: ['plan_a', 'vendor_z'], edgeTypes: ['OFFERS'] }],
    };
    const problems = explanationLabelProblems(dataset, labels);
    expect(problems).toContain('pair r1/e2-f1: vendor_z is not a corpus entity');
    expect(problems).toContain(
      'pair r1/e2-f1: no OFFERS edge between plan_a and vendor_z in the corpus',
    );
  });

  it('refuses a path whose edge types do not fit its concepts', () => {
    const labels = valid();
    labels.pairs[0] = { ...labels.pairs[0]!, gold: [{ concepts: ['plan_a'], edgeTypes: ['X'] }] };
    expect(explanationLabelProblems(dataset, labels)).toEqual([
      'pair p1/e1-f1: path plan_a|X has the wrong number of edge types',
    ]);
  });

  it('refuses a relational pair with no gold path', () => {
    const labels = valid();
    labels.pairs[1] = { ...labels.pairs[1]!, gold: [] };
    expect(explanationLabelProblems(dataset, labels)).toEqual([
      'pair r1/e2-f1: a relational pair has no gold path',
    ]);
  });

  it('refuses a missing answer key, and one on a query that is not relational', () => {
    const labels = { ...valid(), answerKeys: { p1: ['deductible'] } };
    const problems = explanationLabelProblems(dataset, labels);
    expect(problems).toContain('answer key r1: missing');
    expect(problems).toContain('answer key p1: not a relational query');
  });

  it('refuses an alternative the fact does not contain, or the query already does', () => {
    const labels = { ...valid(), answerKeys: { r1: ['six days', 'Bravo', 'decide'] } };
    expect(explanationLabelProblems(dataset, labels)).toEqual([
      'answer key r1: "six days" is not in the relevant fact',
      'answer key r1: "decide" is in the query itself',
    ]);
  });
});
