import { describe, it, expect } from 'vitest';
import { buildRetrievalDataset, type Corpus, type LabelledQuery } from './dataset.js';
import { deriveGoldPaths, type GoldPath } from './explanation-labels.js';
import {
  STAGE1_THRESHOLDS,
  applyAnswerRule,
  applyExplanationRule,
  buildExplanationReport,
  constructionCheck,
  decideStage1,
  explanationOutcome,
  pathsMatch,
  renderExplanationMarkdown,
  scorePair,
  summarizeExplanationCondition,
  type Interval,
  type RawExplanationCondition,
  type ReturnedPath,
} from './explanation.js';
import type { PairedBootstrapResult } from '../stats/paired-bootstrap.js';

const p = (concepts: string[], edgeTypes: string[]): ReturnedPath => ({ concepts, edgeTypes });
const g = (concepts: string[], edgeTypes: string[]): GoldPath => ({ concepts, edgeTypes });

describe('pathsMatch', () => {
  it('matches equal concepts and edge types in either direction', () => {
    expect(pathsMatch(p(['a', 'b'], ['T']), g(['a', 'b'], ['T']))).toBe(true);
    expect(pathsMatch(p(['b', 'a'], ['T']), g(['a', 'b'], ['T']))).toBe(true);
    expect(pathsMatch(p(['c', 'b', 'a'], ['U', 'T']), g(['a', 'b', 'c'], ['T', 'U']))).toBe(true);
  });

  it('does not match another edge type or another concept', () => {
    expect(pathsMatch(p(['a', 'b'], ['U']), g(['a', 'b'], ['T']))).toBe(false);
    expect(pathsMatch(p(['a'], []), g(['a', 'b'], ['T']))).toBe(false);
  });
});

describe('scorePair', () => {
  const gold = [g(['a', 'b'], ['T'])];

  it('scores a gold path among two returned', () => {
    expect(scorePair([p(['a'], []), p(['a', 'b'], ['T'])], gold)).toEqual({
      precision: 0.5,
      recall: 1,
      hit1: 0,
      abstained: false,
    });
  });

  it('scores an empty return as precision 0 when the gold is not empty', () => {
    expect(scorePair([], gold)).toEqual({ precision: 0, recall: 0, hit1: 0, abstained: true });
  });

  it('leaves precision, recall and Hit@1 undefined when both are empty', () => {
    expect(scorePair([], [])).toEqual({
      precision: null,
      recall: null,
      hit1: null,
      abstained: true,
    });
    expect(scorePair([p(['a'], [])], []).precision).toBe(0);
  });

  it('caps the recall denominator at three', () => {
    const many = ['b', 'c', 'd', 'e'].map((x) => g(['a', x], ['T']));
    const returned = ['b', 'c', 'd'].map((x) => p(['a', x], ['T']));
    expect(scorePair(returned, many).recall).toBe(1);
  });
});

const iv = (lower: number, upper: number): Interval => ({
  mean: (lower + upper) / 2,
  sd: 0.4,
  lower,
  upper,
});

describe('applyExplanationRule', () => {
  const { recall: R, precision: P } = STAGE1_THRESHOLDS;

  it('is good at exactly the thresholds', () => {
    expect(applyExplanationRule(iv(R, 0.9), iv(P, 0.9))).toBe('good');
  });

  it('is not good when either upper bound is below its threshold', () => {
    expect(applyExplanationRule(iv(0.5, R - 0.001), iv(0.8, 0.9))).toBe('not good');
    expect(applyExplanationRule(iv(0.8, 0.9), iv(0.3, P - 0.001))).toBe('not good');
  });

  it('is inconclusive when an interval straddles its threshold', () => {
    expect(applyExplanationRule(iv(R - 0.001, 0.9), iv(0.6, 0.9))).toBe('inconclusive');
    expect(applyExplanationRule(iv(0.8, 0.9), iv(P - 0.001, P))).toBe('inconclusive');
  });
});

describe('applyAnswerRule and explanationOutcome', () => {
  const diff = (mean: number, lower: number): PairedBootstrapResult => ({
    n: 38,
    mean,
    sd: 0.3,
    lower,
    upper: mean + 0.1,
    resamples: 10_000,
    seed: 0x5eed,
    confidence: 0.95,
  });

  it('is met at +0.10 with a lower bound above 0, and not met otherwise', () => {
    expect(applyAnswerRule(diff(0.1, 0.01))).toBe('met');
    expect(applyAnswerRule(diff(0.1, 0))).toBe('not met');
    expect(applyAnswerRule(diff(0.099, 0.05))).toBe('not met');
  });

  it('keeps the graph only on good then met', () => {
    expect(explanationOutcome('good', 'met')).toBe('keep the graph for explanation');
    expect(explanationOutcome('good', 'not met')).toBe('option C');
    expect(explanationOutcome('not good', null)).toBe('option C');
    expect(explanationOutcome('inconclusive', null)).toBe('option C');
  });
});

// --- A small dataset, to exercise the condition summary and the report ---------------

const EP1 = '00000000-0000-4000-8000-000000000001';
const EP2 = '00000000-0000-4000-8000-000000000002';
const corpus: Corpus = {
  sessionId: '00000000-0000-4000-8000-0000000000ff',
  episodes: [
    {
      episodeId: EP1,
      entities: [
        { id: 'plan_a', label: 'Alpha Plan', description: '' },
        { id: 'vendor_b', label: 'Bravo Review', description: '' },
      ],
      relationships: [{ fromId: 'plan_a', toId: 'vendor_b', type: 'DELEGATES_TO', confidence: 1 }],
      facts: [{ id: 'e1-f1', text: 'Alpha Plan costs 10 dollars.', mentions: ['plan_a'] }],
    },
    {
      episodeId: EP2,
      entities: [
        { id: 'vendor_b', label: 'Bravo Review', description: '' },
        { id: 'plan_a', label: 'Alpha Plan', description: '' },
      ],
      relationships: [],
      facts: [{ id: 'e2-f1', text: 'Bravo Review decides in two days.', mentions: ['vendor_b'] }],
    },
  ],
};
const queries: LabelledQuery[] = [
  {
    id: 'p1',
    stratum: 'paraphrase',
    text: 'What does Alpha Plan cost?',
    relevant: ['e1-f1'],
    goldSeeds: ['plan_a'],
  },
  {
    id: 'r1',
    stratum: 'relational',
    text: 'How fast is the reviewer for Alpha Plan?',
    relevant: ['e2-f1'],
    goldSeeds: ['plan_a'],
  },
];
const dataset = buildRetrievalDataset(corpus, queries, 'f'.repeat(64));
const labels = deriveGoldPaths(dataset);
const BOOT = { resamples: 1000, seed: 0x5eed };

/** Returns `paths(pair)` for every pair, with the gold seeds as question concepts. */
function condition(
  name: string,
  role: RawExplanationCondition['role'],
  paths: (queryId: string) => ReturnedPath[],
): RawExplanationCondition {
  return {
    name,
    role,
    graphShape: role === 'decisive' ? 'reflect' : 'per-fact',
    questionConcepts: 'gold',
    pairs: labels.map((pair) => ({
      pair,
      questionConcepts: ['plan_a'],
      returned: paths(pair.queryId),
    })),
  };
}

const perfect = condition('explain·per-fact·oracle', 'construction check', (q) =>
  q === 'r1' ? [p(['plan_a', 'vendor_b'], ['DELEGATES_TO'])] : [p(['plan_a'], [])],
);
// The reflect shape: the answer fact is also linked to A, so [A] comes first.
const reflectLike = condition('explain', 'decisive', (q) =>
  q === 'r1'
    ? [p(['plan_a'], []), p(['plan_a', 'vendor_b'], ['DELEGATES_TO'])]
    : [p(['plan_a'], []), p(['plan_a', 'vendor_b'], ['DELEGATES_TO'])],
);

describe('summarizeExplanationCondition', () => {
  it('scores per stratum and counts the relational diagnostics', () => {
    const summary = summarizeExplanationCondition(dataset, reflectLike, BOOT);
    expect(summary.perStratum.relational.precision.mean).toBe(0.5);
    expect(summary.perStratum.relational.recall.mean).toBe(1);
    expect(summary.perStratum.relational.hit1.mean).toBe(0);
    expect(summary.perStratum.paraphrase.recall.mean).toBe(1);
    expect(summary.perStratum['no-entity'].pairs).toBe(0);
    expect(summary.diagnostics).toEqual({
      relationalLinkedA: 1,
      relationalWithDirectMention: 1,
      relationalDirectMentionFirst: 1,
    });
    expect(summary.pairs.find((x) => x.queryId === 'r1')!.returned).toEqual([
      'plan_a',
      'plan_a|DELEGATES_TO|vendor_b',
    ]);
  });
});

describe('constructionCheck', () => {
  it('passes when every relational pair reaches its bound', () => {
    const check = constructionCheck(summarizeExplanationCondition(dataset, perfect, BOOT));
    expect(check).toMatchObject({ passed: true, bound: 1, recall: 1, failures: [] });
  });

  it('fails and names the pair when one does not', () => {
    const broken = condition('explain·per-fact·oracle', 'construction check', () => []);
    const check = constructionCheck(summarizeExplanationCondition(dataset, broken, BOOT));
    expect(check).toMatchObject({ passed: false, failures: ['r1/e2-f1'] });
  });
});

describe('buildExplanationReport', () => {
  const input = {
    dataset,
    labelsSha256: 'e'.repeat(64),
    pairs: labels.length,
    startedAt: '2026-10-08T00:00:00.000Z',
    finishedAt: '2026-10-08T00:00:01.000Z',
    maxHops: 2,
    bootstrap: BOOT,
    explainerChangedAfterFirstRun: false,
    constructionCondition: 'explain·per-fact·oracle',
    decisiveCondition: 'explain',
  };

  it('applies the rule to the decisive condition and does not run stage 2 on a failure', () => {
    const report = buildExplanationReport({ ...input, conditions: [reflectLike, perfect] });
    // One relational pair, so each interval is a point: recall 1 and precision
    // 0.5 meet their thresholds exactly, which is good.
    expect(report.stage1!.outcome).toBe('good');
    expect(report.outcome).toBeNull();
    expect(report.stage2).toMatchObject({ ran: false, generateContentCalls: 0 });

    const worse = condition('explain', 'decisive', () => [p(['plan_a'], [])]);
    const failed = buildExplanationReport({ ...input, conditions: [worse, perfect] });
    expect(failed.stage1!.outcome).toBe('not good');
    expect(failed.outcome).toBe('option C');
    expect(failed.stage2.reason).toBe('stage 1 is not good, so the rule does not run stage 2');
    expect(renderExplanationMarkdown(failed)).toContain('**Outcome: option C.**');
  });

  it('prints no condition when the construction check fails', () => {
    const broken = condition('explain·per-fact·oracle', 'construction check', () => []);
    const report = buildExplanationReport({ ...input, conditions: [reflectLike, broken] });
    expect(report.conditions).toEqual([]);
    expect(report.stage1).toBeNull();
    const markdown = renderExplanationMarkdown(report);
    expect(markdown).toContain('No other condition is printed.');
    expect(markdown).not.toContain('`explain`');
  });

  it('reports pairsToResolve only for an unresolved metric', () => {
    const decision = decideStage1(
      summarizeExplanationCondition(
        dataset,
        condition('explain', 'decisive', () => []),
        BOOT,
      ),
    );
    expect(decision.outcome).toBe('not good');
    expect(decision.pairsToResolve).toEqual({ recall: null, precision: null });
  });
});
