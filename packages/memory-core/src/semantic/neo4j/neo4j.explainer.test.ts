import { describe, it, expect } from 'vitest';
import {
  MAX_PATHS_PER_FACT,
  assembleExplanations,
  compareConceptPaths,
  conceptPathKey,
  matchConceptLabels,
  type ConceptPath,
  type ExplanationRow,
} from './neo4j.explainer.js';

const path = (concepts: string[], edgeTypes: string[]): ConceptPath => ({ concepts, edgeTypes });
const row = (
  contentHash: string,
  mentioned: string | null,
  p: ConceptPath | null,
): ExplanationRow => ({ contentHash, mentioned, path: p });

describe('conceptPathKey and compareConceptPaths', () => {
  it('orders by length, then by concepts and edge types interleaved', () => {
    const paths = [
      path(['q', 'b', 'c'], ['X', 'Y']),
      path(['q', 'c'], ['Z']),
      path(['q', 'c'], ['A']),
      path(['q'], []),
    ];
    expect([...paths].sort(compareConceptPaths).map(conceptPathKey)).toEqual([
      'q',
      'q|A|c',
      'q|Z|c',
      'q|X|b|Y|c',
    ]);
  });
});

describe('assembleExplanations', () => {
  it('keeps only the shortest paths to each mentioned concept', () => {
    const explanations = assembleExplanations(
      ['h'],
      [
        row('h', 'b', path(['q', 'b'], ['T'])),
        row('h', 'b', path(['q', 'x', 'b'], ['U', 'V'])),
        row('h', 'c', path(['q', 'x', 'c'], ['U', 'W'])),
      ],
    );
    expect(explanations.get('h')).toEqual([
      path(['q', 'b'], ['T']),
      path(['q', 'x', 'c'], ['U', 'W']),
    ]);
  });

  it('ranks a fact that mentions a question concept first, at length 0', () => {
    const explanations = assembleExplanations(
      ['h'],
      [row('h', 'q', path(['q'], [])), row('h', 'b', path(['q', 'b'], ['T']))],
    );
    expect(explanations.get('h')!.map(conceptPathKey)).toEqual(['q', 'q|T|b']);
  });

  it(`returns at most ${MAX_PATHS_PER_FACT} paths per fact, in a total order`, () => {
    const rows = ['e', 'd', 'c', 'b', 'a'].map((m) => row('h', m, path(['q', m], ['T'])));
    expect(assembleExplanations(['h'], rows).get('h')!.map(conceptPathKey)).toEqual([
      'q|T|a',
      'q|T|b',
      'q|T|c',
    ]);
  });

  it('counts one path over the same concepts and types once, whichever edge it crossed', () => {
    const rows = [row('h', 'b', path(['q', 'b'], ['T'])), row('h', 'b', path(['q', 'b'], ['T']))];
    expect(assembleExplanations(['h'], rows).get('h')).toEqual([path(['q', 'b'], ['T'])]);
  });

  it('gives an owned fact with no path an empty list, and an unowned fact no entry', () => {
    const explanations = assembleExplanations(
      ['owned', 'unmentioned', 'unowned'],
      [row('owned', 'b', null), row('unmentioned', null, null)],
    );
    expect(explanations.get('owned')).toEqual([]);
    expect(explanations.get('unmentioned')).toEqual([]);
    expect(explanations.has('unowned')).toBe(false);
  });
});

describe('matchConceptLabels', () => {
  const concepts = [
    { id: 'payer_harbor_mutual', label: 'Harbor Mutual' },
    { id: 'plan_harbor_mutual_silver', label: 'Harbor Mutual Silver' },
    { id: 'code_e11_9', label: 'E11.9' },
    { id: 'vendor_kestrel', label: 'Kestrel Review Services' },
  ];

  it('takes the longest match and drops the shorter one inside it', () => {
    expect(matchConceptLabels('Who reviews for Harbor Mutual Silver?', concepts)).toEqual([
      'plan_harbor_mutual_silver',
    ]);
  });

  it('matches regardless of case, in text order', () => {
    expect(
      matchConceptLabels('does kestrel review services work for harbor mutual?', concepts),
    ).toEqual(['vendor_kestrel', 'payer_harbor_mutual']);
  });

  it('matches whole words only', () => {
    expect(matchConceptLabels('Harbor Mutualism is not a payer.', concepts)).toEqual([]);
    expect(matchConceptLabels('members coded E11.9?', concepts)).toEqual(['code_e11_9']);
    expect(matchConceptLabels('members coded E11.95', concepts)).toEqual([]);
  });

  it('lists a concept once however often it is named', () => {
    expect(matchConceptLabels('Harbor Mutual, and again Harbor Mutual', concepts)).toEqual([
      'payer_harbor_mutual',
    ]);
  });

  it('resolves two concepts with one label to the smaller id', () => {
    expect(
      matchConceptLabels('Ask Acme.', [
        { id: 'b_acme', label: 'Acme' },
        { id: 'a_acme', label: 'Acme' },
      ]),
    ).toEqual(['a_acme']);
  });
});
