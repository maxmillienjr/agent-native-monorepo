import { describe, it, expect } from 'vitest';
import type { EpisodicRepository, Neo4jWriter, PgvectorWriter } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';
import { reflectNode } from './reflect.node.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const RUN = '550e8400-e29b-41d4-a716-446655440001';

const state = {
  runId: RUN,
  sessionId: SESSION,
  correlationId: 'test-correlation',
  messages: [{ role: 'user', content: 'Who reviews Alpha Plan requests?' }],
  retrievedContext: [],
  toolOutputs: [],
  tokenCounts: { prompt: 0, completion: 0 },
  outcome: 'success',
  stepCount: 1,
  maxSteps: 10,
  topK: 10,
  shouldContinue: false,
  extraction: {
    entities: [
      { id: 'plan_alpha', label: 'Alpha Plan' },
      { id: 'vendor_bravo', label: 'Bravo Review' },
    ],
    relationships: [
      { fromId: 'plan_alpha', toId: 'vendor_bravo', type: 'DELEGATES_TO', confidence: 0.9 },
    ],
    facts: [{ text: 'Alpha Plan delegates review to Bravo Review.' }],
  },
} satisfies AgentState;

/** A writer that records what `reflect` hands it. */
function recordingDeps() {
  const relationships: Parameters<Neo4jWriter['mergeRelationship']>[0][] = [];
  const facts: Parameters<Neo4jWriter['mergeFact']>[0][] = [];
  const neo4jWriter: Neo4jWriter = {
    mergeEntity: async () => {},
    mergeRelationship: async (rel) => {
      relationships.push(rel);
    },
    mergeFact: async (fact) => {
      facts.push(fact);
    },
  };
  const episodicRepo = { write: async () => {} } as unknown as EpisodicRepository;
  const pgvectorWriter: PgvectorWriter = { upsertFact: async () => {} };
  return {
    relationships,
    facts,
    deps: { episodicRepo, neo4jWriter, pgvectorWriter, embedText: async () => [0] },
  };
}

describe('reflectNode', () => {
  it("writes every graph edge and fact under the run's session (M1)", async () => {
    const { relationships, facts, deps } = recordingDeps();

    await reflectNode(state, deps);

    expect(relationships).toHaveLength(1);
    expect(relationships[0]).toMatchObject({ sessionId: SESSION, episodeId: RUN });
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      sessionId: SESSION,
      episodeId: RUN,
      entityIds: ['plan_alpha', 'vendor_bravo'],
    });
  });
});
