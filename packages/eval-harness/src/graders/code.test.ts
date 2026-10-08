import { describe, it, expect } from 'vitest';
import {
  entityMerged,
  episodicRowWritten,
  factsPersistedToBothIndices,
  outcomeMustBe,
  retrievedContextMinLength,
  tokenCountsPositive,
} from './code.js';
import type { MemoryOutcome } from '../outcome.js';
import type { Transcript } from '../types.js';

function transcript(overrides: Partial<Transcript> = {}): Transcript {
  return {
    runId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [],
    nodeSequence: [],
    toolCalls: [],
    retrievedContext: [{ source: 'pgvector', content: 'a seeded fact', score: 0.9 }],
    tokenCounts: { prompt: 150, completion: 45 },
    outcome: 'success',
    latencyMs: 10,
    ...overrides,
  };
}

function outcome(overrides: Partial<MemoryOutcome> = {}): MemoryOutcome {
  return {
    runId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    episodeRowsForRun: 2,
    factRowsForRun: 1,
    factNodesForRun: 1,
    extractedConceptIds: ['langgraph'],
    mergedConceptIds: ['langgraph'],
    ...overrides,
  };
}

describe('the three assertions migrated from run-fixture-001.json', () => {
  it('grades retrieved context against the declared minimum', async () => {
    const grader = retrievedContextMinLength(1);
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');
    expect((await grader.grade(transcript({ retrievedContext: [] }), outcome())).label).toBe(
      'fail',
    );
  });

  it('grades the outcome the agent reported', async () => {
    const grader = outcomeMustBe('success');
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');
    expect((await grader.grade(transcript({ outcome: 'partial' }), outcome())).label).toBe('fail');
  });

  it('requires both token counts to be positive', async () => {
    const grader = tokenCountsPositive();
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');
    const noCompletion = transcript({ tokenCounts: { prompt: 150, completion: 0 } });
    expect((await grader.grade(noCompletion, outcome())).label).toBe('fail');
  });

  it('does not require a live memory axis for any of them', () => {
    // They read the transcript, so they are meaningful on either axis. Marking
    // them otherwise would refuse a suite that can legitimately run.
    for (const grader of [
      retrievedContextMinLength(1),
      outcomeMustBe('success'),
      tokenCountsPositive(),
    ]) {
      expect(grader.requires).toBeUndefined();
    }
  });
});

describe('outcome graders', () => {
  it('assert against persisted state and demand a live memory axis', () => {
    for (const grader of [episodicRowWritten(1), entityMerged(1), factsPersistedToBothIndices(1)]) {
      expect(grader.requires).toEqual({ memory: 'live' });
    }
  });

  it('fails when reflect wrote no episodic row for the run', async () => {
    const grader = episodicRowWritten(1);
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');
    expect((await grader.grade(transcript(), outcome({ episodeRowsForRun: 0 }))).label).toBe(
      'fail',
    );
  });

  it('fails when the concepts distill produced are not in the graph', async () => {
    const grader = entityMerged(1);
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');

    // Extracted but absent: `reflect` produced an extraction and wrote none of
    // it. A grader that counted `:Concept` nodes instead would report a pass
    // here on the seeded concepts alone.
    const wroteNothing = outcome({ extractedConceptIds: ['langgraph'], mergedConceptIds: [] });
    const score = await grader.grade(transcript(), wroteNothing);
    expect(score.label).toBe('fail');
    expect(score.explanation).toContain('0 of 1');
  });

  it('reports both indices for a fact', async () => {
    const grader = factsPersistedToBothIndices(1);
    expect((await grader.grade(transcript(), outcome())).label).toBe('pass');
    expect((await grader.grade(transcript(), outcome({ factNodesForRun: 0 }))).label).toBe('fail');
  });
});
