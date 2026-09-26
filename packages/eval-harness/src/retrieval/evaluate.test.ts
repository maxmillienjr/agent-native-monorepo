import { describe, it, expect } from 'vitest';
import { rrfMerge, type RetrievalCandidate } from '@repo/memory-core';
import { buildRetrievalDataset, sha256Hex, type Corpus, type LabelledQuery } from './dataset.js';
import {
  applyDecisionRule,
  buildPool,
  fusionReproduced,
  limitCut,
  meanScores,
  percentile,
  provenance,
  queryIndex,
  reachableFacts,
  resortTies,
  scoreList,
  summarizeCondition,
  type RawCondition,
} from './evaluate.js';
import { buildAblationReport, renderAblationMarkdown } from './report.js';
import type { PairedBootstrapResult } from '../stats/paired-bootstrap.js';

const EP1 = '00000000-0000-4000-8000-000000000001';
const EP2 = '00000000-0000-4000-8000-000000000002';
const EP3 = '00000000-0000-4000-8000-000000000003';

/** a — b — c in a chain; each episode's facts are about one concept, and e1 also names b. */
const corpus: Corpus = {
  sessionId: '00000000-0000-4000-8000-0000000000ff',
  episodes: [
    {
      episodeId: EP1,
      entities: [
        { id: 'a', label: 'Alpha', description: '' },
        { id: 'b', label: 'Bravo', description: '' },
      ],
      relationships: [{ fromId: 'a', toId: 'b', type: 'R', confidence: 1 }],
      facts: [
        { id: 'e1-f1', text: 'Alpha one.', mentions: ['a'] },
        { id: 'e1-f2', text: 'Alpha and Bravo.', mentions: ['a', 'b'] },
      ],
    },
    {
      episodeId: EP2,
      entities: [
        { id: 'b', label: 'Bravo', description: '' },
        { id: 'c', label: 'Charlie', description: '' },
      ],
      relationships: [{ fromId: 'b', toId: 'c', type: 'R', confidence: 1 }],
      facts: [{ id: 'e2-f1', text: 'Bravo one.', mentions: ['b'] }],
    },
    {
      episodeId: EP3,
      entities: [{ id: 'c', label: 'Charlie', description: '' }],
      relationships: [],
      facts: [{ id: 'e3-f1', text: 'Charlie one.', mentions: ['c'] }],
    },
  ],
};

const queries: LabelledQuery[] = [
  { id: 'q1', stratum: 'paraphrase', text: 'About Alpha?', relevant: ['e1-f1'], goldSeeds: ['a'] },
  { id: 'q2', stratum: 'relational', text: 'Via Alpha?', relevant: ['e2-f1'], goldSeeds: ['a'] },
];
const dataset = buildRetrievalDataset(corpus, queries, 'f'.repeat(64));
const h = (handle: string): string => dataset.facts.get(handle)!.contentHash;
const cand = (handle: string, score: number, source: 'neo4j' | 'pgvector'): RetrievalCandidate => ({
  source,
  score,
  content: dataset.facts.get(handle)!.text,
  contentHash: h(handle),
});
const labels = new Map(queries.map((q) => [q.id, new Set(q.relevant.map(h))]));

describe('scoreList and meanScores', () => {
  it('cuts at topK before scoring, so MRR is MRR@topK', () => {
    const scores = scoreList(['x', 'y', 'a'], new Set(['a']), 2);
    expect(scores.rr).toBe(0);
    expect(scores.recall[10]).toBe(0);
  });

  it('averages each metric over queries', () => {
    const mean = meanScores([
      scoreList(['a'], new Set(['a']), 10),
      scoreList(['x'], new Set(['a']), 10),
    ]);
    expect(mean.n).toBe(2);
    expect(mean.recall[1]).toBe(0.5);
    expect(mean.mrr).toBe(0.5);
  });
});

describe('percentile', () => {
  it('is nearest-rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBe(0);
  });
});

describe('resortTies', () => {
  const list = ['e1-f1', 'e1-f2', 'e2-f1'].map((handle) => cand(handle, 0.5, 'neo4j'));
  const withFar = [...list, cand('e3-f1', 0.25, 'neo4j')];

  it('keeps every score group in place and only reorders within one', () => {
    for (const salt of ['s1', 's2', 's3']) {
      const resorted = resortTies(withFar, salt);
      expect(resorted.map((c) => c.score)).toEqual([0.5, 0.5, 0.5, 0.25]);
      expect(resorted[3]!.contentHash).toBe(h('e3-f1'));
    }
  });

  it('is a function of the salt', () => {
    expect(resortTies(list, 's1')).toEqual(resortTies(list, 's1'));
    const orders = new Set(
      Array.from({ length: 12 }, (_, i) =>
        resortTies(list, `s${i}`)
          .map((c) => c.contentHash)
          .join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(1);
  });
});

describe('reachableFacts', () => {
  it('puts facts linked to a seed at 1 and adds one per RELATES_TO hop', () => {
    const perFact = reachableFacts(dataset, 'per-fact', ['a'], 2);
    expect(perFact.get(h('e1-f1'))).toBe(1);
    expect(perFact.get(h('e2-f1'))).toBe(2);
    expect(perFact.get(h('e3-f1'))).toBe(3);
    expect(reachableFacts(dataset, 'per-fact', ['a'], 1).has(h('e3-f1'))).toBe(false);
  });

  it('links a fact to every entity of its episode in the reflect shape', () => {
    // e2-f1 is about b only, but its episode names c, so from c it is at 1.
    expect(reachableFacts(dataset, 'reflect', ['c'], 1).get(h('e2-f1'))).toBe(1);
    expect(reachableFacts(dataset, 'per-fact', ['c'], 1).get(h('e2-f1'))).toBe(2);
  });

  it('reaches nothing from an id that is not a concept, as the linker’s ids do', () => {
    expect(reachableFacts(dataset, 'reflect', ['alpha'], 3).size).toBe(0);
  });
});

/** A hybrid condition whose ranked list is what the facade would have returned. */
function hybridCondition(): RawCondition {
  const vector = [cand('e3-f1', 0.9, 'pgvector'), cand('e1-f1', 0.8, 'pgvector')];
  const graph = [
    cand('e1-f1', 0.5, 'neo4j'),
    cand('e1-f2', 0.5, 'neo4j'),
    cand('e2-f1', 0.333, 'neo4j'),
  ];
  return {
    name: 'hybrid·oracle',
    table: 'diagnostic',
    kind: 'hybrid',
    seeds: 'gold',
    graphShape: 'per-fact',
    hopDepth: 2,
    results: queries.map((q) => ({
      queryId: q.id,
      ranked: rrfMerge([vector, graph], 10),
      latencyMs: 1,
      fusionInputs: { vector, graph },
    })),
  };
}

describe('provenance', () => {
  it('splits each relevant fact by the fused list that held it', () => {
    const split = provenance(hybridCondition(), labels, queryIndex(dataset))!;
    // q1's e1-f1 is in both lists; q2's e2-f1 is in the graph list only.
    expect(split.overall).toMatchObject({ both: 1, graphOnly: 1, vectorOnly: 0, neither: 0 });
    expect(split.overall.unionRecall).toBe(1);
    expect(split.perStratum.relational.graphOnly).toBe(1);
  });
});

describe('fusionReproduced and summarizeCondition', () => {
  it('confirms re-fusion reproduces the facade list', () => {
    expect(fusionReproduced(hybridCondition(), 10)).toBe(true);
    const tampered = hybridCondition();
    const broken: RawCondition = {
      ...tampered,
      results: tampered.results.map((r) => ({ ...r, ranked: [...r.ranked].reverse() })),
    };
    expect(fusionReproduced(broken, 10)).toBe(false);
  });

  it('reports a tie range that contains the production value', () => {
    const summary = summarizeCondition(hybridCondition(), labels, queryIndex(dataset), 10);
    const [min, max] = summary.tieRange!.mrr;
    expect(summary.overall.mrr).toBeGreaterThanOrEqual(min);
    expect(summary.overall.mrr).toBeLessThanOrEqual(max);
    expect(summary.emptyFraction).toBe(0);
    expect(summary.contextChars).toBeGreaterThan(0);
  });
});

describe('limitCut', () => {
  it('agrees with a store that returned exactly the reachable set', () => {
    const reach = reachableFacts(dataset, 'per-fact', ['a'], 2);
    const graph = [...reach.entries()]
      .sort(([ha, da], [hb, db]) => da - db || (ha < hb ? -1 : 1))
      .map(([hash, d]) => ({
        source: 'neo4j' as const,
        score: 1 / (1 + d),
        content: '',
        contentHash: hash,
      }));
    const condition: RawCondition = {
      ...hybridCondition(),
      kind: 'graph',
      results: [
        { queryId: 'q1', ranked: graph, latencyMs: 1, fusionInputs: { vector: [], graph } },
      ],
    };
    expect(limitCut(dataset, condition, () => ['a'])).toEqual({
      queriesAtLimit: 0,
      factsCut: 0,
      tiedAtCut: 0,
      storeAgrees: 1,
      queries: 1,
    });
  });
});

describe('applyDecisionRule', () => {
  const interval = (mean: number, lower: number, upper: number): PairedBootstrapResult => ({
    n: 200,
    mean,
    sd: 0.3,
    lower,
    upper,
    resamples: 10_000,
    seed: 1,
    confidence: 0.95,
  });

  it('says earns its keep only at the margin with the lower bound above 0', () => {
    expect(applyDecisionRule(interval(0.05, 0.01, 0.09))).toBe('earns-its-keep');
    expect(applyDecisionRule(interval(0.049, 0.01, 0.09))).toBe('inconclusive');
    expect(applyDecisionRule(interval(0.08, 0, 0.16))).toBe('inconclusive');
  });

  it('says does not when the whole interval is below the margin', () => {
    expect(applyDecisionRule(interval(0, 0, 0))).toBe('does-not');
    expect(applyDecisionRule(interval(0.03, 0.01, 0.049))).toBe('does-not');
  });

  it('never rounds an interval straddling the margin toward either side', () => {
    expect(applyDecisionRule(interval(0.04, -0.01, 0.09))).toBe('inconclusive');
  });
});

describe('buildPool', () => {
  const pool = buildPool(dataset, [hybridCondition()], 10);

  it('pools unlabelled members of every top ten, and nothing labelled', () => {
    const pooledFor = (queryId: string) =>
      pool.key
        .filter((k) => k.queryId === queryId)
        .map((k) => k.handle)
        .sort();
    expect(pooledFor('q1')).toEqual(['e1-f2', 'e2-f1', 'e3-f1']);
    expect(pooledFor('q2')).toEqual(['e1-f1', 'e1-f2', 'e3-f1']);
  });

  it('strips source, condition, stratum and query id from what the adjudicator sees', () => {
    const seen = JSON.stringify(pool.queries);
    for (const hidden of [
      'neo4j',
      'pgvector',
      'hybrid',
      'oracle',
      'relational',
      'paraphrase',
      '"q1"',
      '"q2"',
      'e1-f',
    ]) {
      expect(seen).not.toContain(hidden);
    }
    expect(pool.queries.flatMap((q) => q.candidates)).toHaveLength(pool.key.length);
  });

  it('is the same pool on every run', () => {
    expect(buildPool(dataset, [hybridCondition()], 10)).toEqual(pool);
  });
});

describe('buildAblationReport', () => {
  const vector: RawCondition = {
    name: 'vector',
    table: 'primary',
    kind: 'vector',
    seeds: 'none',
    graphShape: null,
    hopDepth: null,
    results: queries.map((q) => ({
      queryId: q.id,
      ranked: [cand('e3-f1', 0.9, 'pgvector'), cand('e1-f1', 0.8, 'pgvector')],
      latencyMs: 2,
    })),
  };
  const input = {
    dataset,
    conditions: [
      vector,
      {
        ...hybridCondition(),
        name: 'graph·oracle',
        kind: 'graph' as const,
        results: hybridCondition().results.map((r) => ({ ...r, ranked: r.fusionInputs!.graph })),
      },
      hybridCondition(),
    ],
    labelSets: [{ name: 'pre-registered' as const, labels }],
    startedAt: '2026-09-26T00:00:00.000Z',
    finishedAt: '2026-09-26T00:00:01.000Z',
    axes: { memory: 'live' as const, embeddings: 'recorded' as const },
    embeddings: {
      model: 'm',
      dimensions: 768,
      recordedAt: '2026-09-26T00:00:00.000Z',
      gitSha: 'a'.repeat(40),
    },
    vectorPlan: [
      'Limit',
      '  ->  Sort',
      "        Sort Key: ((embedding <=> '[0.1,0.2,0.3]'::vector)), content_hash",
      '        ->  Seq Scan on semantic_facts',
    ],
    linkerIds: new Map([
      ['q1', ['about', 'alpha']],
      ['q2', ['via', 'alpha']],
    ]),
    goldSeeds: new Map(queries.map((q) => [q.id, q.goldSeeds])),
    topK: 10,
    hopDepth: 2,
    hopDepths: [1, 2, 3],
    bootstrap: { resamples: 1000, seed: 1 },
    adjudication: null,
    applyRule: false,
  };

  it('withholds the rule’s outcome until it may be applied', () => {
    const report = buildAblationReport(input);
    const comparisons = report.labelSets[0]!.comparisons;
    expect(comparisons.map((c) => c.system)).toEqual(['hybrid·oracle']);
    expect(comparisons.every((c) => c.outcome === null)).toBe(true);
    expect(report.vectorPlanUsesIndex).toBe(false);
    expect(report.linker).toEqual({ queriesWithIds: 2, queriesReachingGraph: 0 });
    expect(report.dataset.sha256).toBe('f'.repeat(64));
    expect(renderAblationMarkdown(report)).toContain('pending adjudication');
  });

  it('applies the rule once it may, against the better baseline', () => {
    const [comparison] = buildAblationReport({ ...input, applyRule: true }).labelSets[0]!
      .comparisons;
    expect(comparison!.outcome).not.toBeNull();
    expect(['vector', 'graph·oracle']).toContain(comparison!.baseline);
  });

  it('prints the dataset sha256, both axes and the embedding provenance', () => {
    const markdown = renderAblationMarkdown(buildAblationReport(input));
    expect(markdown).toContain('f'.repeat(64));
    expect(markdown).toContain('memory `live`, embeddings `recorded`');
    expect(markdown).toContain(`at \`${'a'.repeat(40)}\``);
    expect(markdown).toContain('sequential scan');
    // The inlined query vector is elided to its length.
    expect(markdown).toContain("'[3 values]'::vector");
    expect(markdown).not.toContain('0.1,0.2');
  });

  it('hashes fact text the way the fixture expects', () => {
    expect(h('e1-f1')).toBe(sha256Hex('Alpha one.'));
  });
});
