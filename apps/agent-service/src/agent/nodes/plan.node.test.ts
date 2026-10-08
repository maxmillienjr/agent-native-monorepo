import { describe, it, expect } from 'vitest';
import type { AgentState } from '../graph/state.js';
import { PLAN_SYSTEM_PROMPT, buildPlanPrompt, planNode } from './plan.node.js';

const state = {
  runId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  correlationId: 'test-correlation',
  messages: [{ role: 'user', content: 'Who reviews Alpha Plan requests?' }],
  retrievedContext: [
    { source: 'pgvector', score: 0.9, content: 'Alpha Plan delegates review to Bravo Review.' },
    { source: 'pgvector', score: 0.8, content: 'Bravo Review answers in five business days.' },
  ],
  toolOutputs: [],
  tokenCounts: { prompt: 0, completion: 0 },
  outcome: 'success',
  stepCount: 0,
  maxSteps: 10,
  topK: 10,
  shouldContinue: true,
} satisfies AgentState;

describe('buildPlanPrompt', () => {
  // The bytes are pinned because both committed cassettes key `plan.callLlm`
  // on them: a change here is a re-record, and it should be a visible one.
  it('writes the transcript, the context and the instruction', () => {
    expect(buildPlanPrompt(state)).toBe(
      'user: Who reviews Alpha Plan requests?\n\n' +
        'Relevant context:\n' +
        '- [pgvector] Alpha Plan delegates review to Bravo Review.\n' +
        '- [pgvector] Bravo Review answers in five business days.\n\n' +
        "Based on the above, create a plan to address the user's request.",
    );
  });

  it('leaves the context heading out when nothing was retrieved', () => {
    expect(buildPlanPrompt({ ...state, retrievedContext: [] })).toBe(
      'user: Who reviews Alpha Plan requests?\n\n' +
        "Based on the above, create a plan to address the user's request.",
    );
  });
});

describe('planNode', () => {
  it('asks the model exactly what buildPlanPrompt writes', async () => {
    const seen: [string, string][] = [];
    await planNode(state, {
      callLlm: async (system, user) => {
        seen.push([system, user]);
        return { content: 'a plan', tokenCounts: { prompt: 1, completion: 1 } };
      },
    });
    expect(seen).toEqual([[PLAN_SYSTEM_PROMPT, buildPlanPrompt(state)]]);
  });
});
