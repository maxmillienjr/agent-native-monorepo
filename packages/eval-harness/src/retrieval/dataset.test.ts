import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildRetrievalDataset,
  datasetProblems,
  datasetSha256,
  graphFacts,
  loadRetrievalDataset,
  STRATA,
  strataProblems,
  textsToEmbed,
  wordJaccard,
  type Corpus,
  type LabelledQuery,
} from './dataset.js';

const EP1 = '00000000-0000-4000-8000-000000000001';
const EP2 = '00000000-0000-4000-8000-000000000002';

/**
 * A two-episode world. `plan_a` is linked to `vendor_b` by an edge; the vendor's
 * own facts live in a second episode that never mentions the plan.
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
      ],
      facts: [
        { id: 'e1-f1', text: 'Alpha Plan has a 100 dollar deductible.', mentions: ['plan_a'] },
        { id: 'e1-f2', text: 'Alpha Plan charges 10 dollars for a visit.', mentions: ['plan_a'] },
        { id: 'e1-f3', text: 'Alpha Plan covers glasses.', mentions: ['plan_a'] },
        { id: 'e1-f4', text: 'Alpha Plan renews in July.', mentions: ['plan_a'] },
        {
          id: 'e1-f5',
          text: 'Alpha Plan uses Bravo Review for reviews.',
          mentions: ['plan_a', 'vendor_b'],
        },
      ],
    },
    {
      episodeId: EP2,
      entities: [{ id: 'vendor_b', label: 'Bravo Review', description: '' }],
      relationships: [],
      facts: [{ id: 'e2-f1', text: 'Bravo Review decides in two days.', mentions: ['vendor_b'] }],
    },
  ],
};

const q = (overrides: Partial<LabelledQuery>): LabelledQuery => ({
  id: 'q',
  stratum: 'paraphrase',
  text: 'How much is the Alpha Plan deductible?',
  relevant: ['e1-f1'],
  goldSeeds: ['plan_a'],
  ...overrides,
});

const build = (queries: LabelledQuery[]) => buildRetrievalDataset(corpus, queries, 'sha');

describe('buildRetrievalDataset', () => {
  it('hashes each fact exactly as reflect does', () => {
    const fact = build([]).facts.get('e2-f1')!;
    expect(fact.contentHash).toBe(
      createHash('sha256').update('Bravo Review decides in two days.').digest('hex'),
    );
    expect(fact.episodeId).toBe(EP2);
  });

  it('records the episode entities a reflect-shaped graph links each fact to', () => {
    const fact = build([]).facts.get('e1-f1')!;
    expect(fact.mentions).toEqual(['plan_a']);
    expect(fact.episodeEntityIds).toEqual(['plan_a', 'vendor_b']);
  });
});

describe('graphFacts', () => {
  it('links every fact to every entity of its episode in the reflect shape', () => {
    const facts = graphFacts(build([]), 'reflect');
    expect(facts.find((f) => f.text.startsWith('Alpha Plan has'))!.entityIds).toEqual([
      'plan_a',
      'vendor_b',
    ]);
  });

  it('links each fact only to what it mentions in the per-fact shape', () => {
    const facts = graphFacts(build([]), 'per-fact');
    expect(facts.find((f) => f.text.startsWith('Alpha Plan has'))!.entityIds).toEqual(['plan_a']);
  });
});

describe('datasetProblems', () => {
  it('accepts a consistent dataset', () => {
    expect(datasetProblems(build([q({})]))).toEqual([]);
  });

  it('reports a relevant handle or gold seed that resolves nowhere', () => {
    const problems = datasetProblems(build([q({ relevant: ['e9-f9'], goldSeeds: ['nobody'] })]));
    expect(problems).toContain('query q: relevant e9-f9 is not a fact');
    expect(problems).toContain('query q: gold seed nobody is not an entity');
  });

  it('reports two facts with the same text, which would share one content hash', () => {
    const dup: Corpus = structuredClone(corpus);
    dup.episodes[1]!.facts.push({
      id: 'e2-f2',
      text: 'Alpha Plan covers glasses.',
      mentions: ['vendor_b'],
    });
    const problems = datasetProblems(buildRetrievalDataset(dup, [], 'sha'));
    expect(problems).toContain('facts e1-f3 and e2-f2 share text');
  });

  it('reports a mention that is not an entity of the fact’s episode', () => {
    const bad: Corpus = structuredClone(corpus);
    bad.episodes[1]!.facts[0]!.mentions = ['plan_a'];
    expect(datasetProblems(buildRetrievalDataset(bad, [], 'sha'))).toContain(
      'fact e2-f1 mentions plan_a, which is not an entity of its episode',
    );
  });

  it('reports one entity id given two labels', () => {
    const bad: Corpus = structuredClone(corpus);
    bad.episodes[1]!.entities[0]!.label = 'Bravo Reviews Inc';
    expect(datasetProblems(buildRetrievalDataset(bad, [], 'sha'))).toContain(
      'entity vendor_b is labelled both "Bravo Review" and "Bravo Reviews Inc"',
    );
  });
});

describe('strataProblems', () => {
  it('accepts a paraphrase that names its entity', () => {
    expect(strataProblems(build([q({})]))).toEqual([]);
  });

  it('rejects a paraphrase that does not name the entity', () => {
    expect(strataProblems(build([q({ text: 'How much is the deductible?' })]))).toEqual([
      'query q (paraphrase): does not name Alpha Plan',
    ]);
  });

  const relational = q({
    stratum: 'relational',
    text: 'How fast does the reviewer for Alpha Plan decide?',
    relevant: ['e2-f1'],
  });

  it('accepts a relational query that names A and reaches B across one edge', () => {
    expect(strataProblems(build([relational]))).toEqual([]);
  });

  it('rejects a relational query that names B', () => {
    expect(
      strataProblems(
        build([{ ...relational, text: 'How fast does Bravo decide for Alpha Plan?' }]),
      ),
    ).toEqual(['query q (relational): names B, Bravo Review']);
  });

  it('rejects a relational answer that mentions A itself', () => {
    expect(strataProblems(build([{ ...relational, relevant: ['e1-f5'] }]))).toContain(
      'query q (relational): relevant e1-f5 mentions A itself',
    );
  });

  it('rejects a relational answer with no edge from A', () => {
    const isolated: Corpus = structuredClone(corpus);
    isolated.episodes[0]!.relationships = [];
    expect(strataProblems(buildRetrievalDataset(isolated, [relational], 'sha'))).toContain(
      'query q (relational): relevant e2-f1 mentions no entity one edge from A',
    );
  });

  it('requires an entity-distractor seed that five or more facts mention', () => {
    const ok = q({
      stratum: 'entity-distractor',
      text: 'Does Alpha Plan cover glasses?',
      relevant: ['e1-f3'],
    });
    expect(strataProblems(build([ok]))).toEqual([]);

    const thin = q({
      stratum: 'entity-distractor',
      text: 'How fast does Bravo Review decide?',
      relevant: ['e2-f1'],
      goldSeeds: ['vendor_b'],
    });
    expect(strataProblems(build([thin]))).toEqual([
      'query q (entity-distractor): vendor_b is mentioned by 2 facts, not 5+',
    ]);
  });

  it('rejects a no-entity query with a capital letter anywhere', () => {
    const ok = q({
      stratum: 'no-entity',
      text: 'which plan covers glasses?',
      relevant: ['e1-f3'],
      goldSeeds: [],
    });
    expect(strataProblems(build([ok]))).toEqual([]);
    expect(strataProblems(build([{ ...ok, text: 'Which plan covers glasses?' }]))).toEqual([
      'query q (no-entity): contains a capital letter',
    ]);
  });
});

describe('datasetSha256', () => {
  it('moves when a single label byte moves', () => {
    const corpusBytes = Buffer.from('{"a":1}');
    expect(datasetSha256(corpusBytes, Buffer.from('{"relevant":["e1-f1"]}'))).not.toBe(
      datasetSha256(corpusBytes, Buffer.from('{"relevant":["e1-f2"]}')),
    );
  });
});

describe('textsToEmbed', () => {
  it('lists every fact and every query', () => {
    expect(textsToEmbed(build([q({})]))).toHaveLength(7);
  });
});

describe('wordJaccard', () => {
  it('is shared words over all words, lowercased', () => {
    expect(wordJaccard('The Alpha plan', 'alpha PLAN covers')).toBeCloseTo(2 / 4, 12);
    expect(wordJaccard('', '')).toBe(0);
    expect(wordJaccard('a b', 'a b')).toBe(1);
  });
});

describe('the shipped retrieval-ablation dataset', () => {
  // Loading runs every referential and stratum check and throws on any.
  const dataset = loadRetrievalDataset();

  it('holds 200 queries, 50 per stratum, fixed before the first run', () => {
    expect(dataset.queries).toHaveLength(200);
    for (const stratum of STRATA) {
      expect(dataset.queries.filter((query) => query.stratum === stratum)).toHaveLength(50);
    }
  });

  it('resolves every relevant handle and every gold seed', () => {
    expect(datasetProblems(dataset)).toEqual([]);
  });

  it('holds each stratum to its construction', () => {
    expect(strataProblems(dataset)).toEqual([]);
  });

  it('gives no two facts the same text, so no two share a content hash', () => {
    const hashes = [...dataset.facts.values()].map((fact) => fact.contentHash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('gives every episode its own id', () => {
    const ids = dataset.episodes.map((episode) => episode.episodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
