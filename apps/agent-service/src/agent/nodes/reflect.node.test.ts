import { createHash } from 'node:crypto';
import { describe, it, expect, expectTypeOf } from 'vitest';
import type { EpisodeWriteInput, EpisodicRepository, PgvectorWriter } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';
import { reflectNode, type ReflectNodeDeps } from './reflect.node.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440000';
const RUN = '550e8400-e29b-41d4-a716-446655440001';
const FACT = 'Alpha Plan delegates review to Bravo Review.';

const state = {
  runId: RUN,
  sessionId: SESSION,
  correlationId: 'test-correlation',
  messages: [
    { role: 'user', content: 'Who reviews Alpha Plan requests?' },
    { role: 'assistant', content: 'Bravo Review does.' },
  ],
  retrievedContext: [],
  toolOutputs: [],
  tokenCounts: { prompt: 0, completion: 0 },
  outcome: 'success',
  stepCount: 1,
  maxSteps: 10,
  topK: 10,
  shouldContinue: false,
  aborted: false,
  pendingApproval: null,
  extraction: { facts: [{ text: FACT }] },
} satisfies AgentState;

/** Writers that record what `reflect` hands them. */
function recordingDeps() {
  const episodes: EpisodeWriteInput[] = [];
  const facts: Parameters<PgvectorWriter['upsertFact']>[0][] = [];
  const episodicRepo = {
    write: async (input: EpisodeWriteInput) => {
      episodes.push(input);
      return { id: '550e8400-e29b-41d4-a716-446655440002' };
    },
  } as unknown as EpisodicRepository;
  const pgvectorWriter: PgvectorWriter = {
    upsertFact: async (fact) => {
      facts.push(fact);
    },
  };
  const deps: ReflectNodeDeps = { episodicRepo, pgvectorWriter, embedText: async () => [0] };
  return { episodes, facts, deps };
}

describe('reflectNode', () => {
  it('writes each turn to episodic memory and each fact to semantic_facts', async () => {
    const { episodes, facts, deps } = recordingDeps();

    await reflectNode(state, deps);

    expect(episodes.map((e) => [e.sessionId, e.runId, e.turnIndex, e.role])).toEqual([
      [SESSION, RUN, 0, 'user'],
      [SESSION, RUN, 1, 'assistant'],
    ]);
    expect(facts).toEqual([
      {
        contentHash: createHash('sha256').update(FACT).digest('hex'),
        text: FACT,
        embedding: [0],
        episodeId: RUN,
        sessionId: SESSION,
      },
    ]);
  });

  it('ignores the entities a cassette recorded before P2-E still carries', async () => {
    // The replay path hands back the recorded extraction unparsed, so until
    // the cassettes are re-recorded `reflect` is given keys it no longer reads.
    const { facts, deps } = recordingDeps();
    const recorded = {
      ...state,
      extraction: {
        facts: [{ text: FACT }],
        entities: [{ id: 'plan_alpha', label: 'Alpha Plan' }],
        relationships: [],
      },
    };

    await reflectNode(recorded, deps);

    expect(facts.map((f) => f.text)).toEqual([FACT]);
  });

  it('takes no graph writer (P2-E)', () => {
    // Semantic memory is `semantic_facts` alone. A writer for a second store
    // added back to the deps is a change this pins.
    expectTypeOf<keyof ReflectNodeDeps>().toEqualTypeOf<
      'episodicRepo' | 'pgvectorWriter' | 'embedText'
    >();
  });
});
