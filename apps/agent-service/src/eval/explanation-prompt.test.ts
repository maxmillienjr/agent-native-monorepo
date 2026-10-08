import { describe, it, expect } from 'vitest';
import type { ConceptPath } from '@repo/memory-core';
import type { AgentState } from '../agent/graph/state.js';
import { planNode } from '../agent/nodes/plan.node.js';
import {
  renderConceptPath,
  renderExplanationBlock,
  stage2Prompts,
  stage2State,
} from './explanation-prompt.js';

const path = (concepts: string[], edgeTypes: string[]): ConceptPath => ({ concepts, edgeTypes });

const QUERY =
  'How many business days does the prior authorization reviewer for Harbor Mutual Silver take on a standard request?';

const retrieved: AgentState['retrievedContext'] = [
  {
    source: 'pgvector',
    score: 0.91,
    content: 'Harbor Mutual Silver sends prior authorization review to Kestrel Review.',
    contentHash: 'h1',
  },
  {
    source: 'pgvector',
    score: 0.88,
    content: 'Kestrel Review decides a standard request in five business days.',
    contentHash: 'h2',
  },
  { source: 'pgvector', score: 0.7, content: 'Brightwater accepts faxes.', contentHash: 'h3' },
];

const explanations = new Map<string, readonly ConceptPath[]>([
  ['h1', [path(['plan_harbor_mutual_silver'], [])]],
  [
    'h2',
    [
      path(['plan_harbor_mutual_silver', 'vendor_kestrel_review'], ['DELEGATES_REVIEW_TO']),
      path(
        ['plan_harbor_mutual_silver', 'payer_harbor_mutual', 'network_tidewater'],
        ['OFFERED_BY', 'CONTRACTS_WITH'],
      ),
    ],
  ],
  ['h3', []],
]);

describe('renderConceptPath', () => {
  it('joins ids by their edge type, undirected, and writes a length-0 path as its id', () => {
    expect(renderConceptPath(path(['a', 'b', 'c'], ['T', 'U']))).toBe('a -[T]- b -[U]- c');
    expect(renderConceptPath(path(['a'], []))).toBe('a');
  });
});

describe('renderExplanationBlock', () => {
  // Pinned: under keep, P2-E wires this block into plan's prompt as stage 2
  // measured it, and a change after the recording is a different prompt.
  it('writes one line per retrieved fact with a path, numbered as the context lists them', () => {
    expect(renderExplanationBlock(retrieved, explanations)).toBe(
      'Connections in memory:\n' +
        '- context 1: plan_harbor_mutual_silver\n' +
        '- context 2: plan_harbor_mutual_silver -[DELEGATES_REVIEW_TO]- vendor_kestrel_review; ' +
        'plan_harbor_mutual_silver -[OFFERED_BY]- payer_harbor_mutual -[CONTRACTS_WITH]- network_tidewater',
    );
  });

  it('is empty when no retrieved fact has a path, or a fact has no hash', () => {
    expect(renderExplanationBlock(retrieved, new Map())).toBe('');
    expect(
      renderExplanationBlock([{ contentHash: undefined }], new Map([['h1', [path(['a'], [])]]])),
    ).toBe('');
  });
});

describe('stage2Prompts', () => {
  it('makes `without` exactly what planNode sends for the same state', async () => {
    const sent: [string, string][] = [];
    await planNode(
      {
        runId: '550e8400-e29b-41d4-a716-446655440001',
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        correlationId: 'stage-2',
        ...stage2State(QUERY, retrieved),
        toolOutputs: [],
        tokenCounts: { prompt: 0, completion: 0 },
        outcome: 'success',
        stepCount: 0,
        maxSteps: 10,
        topK: 10,
        shouldContinue: true,
      },
      {
        callLlm: async (system, user) => {
          sent.push([system, user]);
          return { content: 'a plan', tokenCounts: { prompt: 1, completion: 1 } };
        },
      },
    );

    const prompts = stage2Prompts(QUERY, retrieved, explanations);
    expect(sent).toEqual([[prompts.system, prompts.without]]);
  });

  it('puts the block after the context and before the instruction, and changes nothing else', () => {
    const prompts = stage2Prompts(QUERY, retrieved, explanations);
    expect(prompts.with).toBe(
      `user: ${QUERY}\n\n` +
        'Relevant context:\n' +
        '- [pgvector] Harbor Mutual Silver sends prior authorization review to Kestrel Review.\n' +
        '- [pgvector] Kestrel Review decides a standard request in five business days.\n' +
        '- [pgvector] Brightwater accepts faxes.\n\n' +
        'Connections in memory:\n' +
        '- context 1: plan_harbor_mutual_silver\n' +
        '- context 2: plan_harbor_mutual_silver -[DELEGATES_REVIEW_TO]- vendor_kestrel_review; ' +
        'plan_harbor_mutual_silver -[OFFERED_BY]- payer_harbor_mutual -[CONTRACTS_WITH]- network_tidewater\n\n' +
        "Based on the above, create a plan to address the user's request.",
    );
    // Removing the block gives `without` back, byte for byte.
    const block = `${renderExplanationBlock(retrieved, explanations)}\n\n`;
    expect(prompts.with.replace(block, '')).toBe(prompts.without);
  });

  it('makes the two prompts identical when there is nothing to explain', () => {
    const prompts = stage2Prompts(QUERY, retrieved, new Map());
    expect(prompts.with).toBe(prompts.without);
  });
});
