import { describe, it, expect } from 'vitest';
import { RunResponseSchema } from '@repo/agent-contracts';
import type { AdverseDetermination } from '@repo/determination';
import type { AgentState } from '../graph/state.js';
import { buildRunResponse } from './egress.node.js';

const state = {
  runId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  correlationId: 'test-correlation',
  messages: [
    { role: 'user', content: 'What is LangGraph?' },
    { role: 'assistant', content: 'A framework for stateful agents.' },
  ],
  retrievedContext: [{ source: 'pgvector', score: 0.9, content: 'LangGraph is a framework.' }],
  toolOutputs: [],
  tokenCounts: { prompt: 10, completion: 5 },
  outcome: 'success',
  stepCount: 1,
  maxSteps: 10,
  topK: 10,
  shouldContinue: false,
  aborted: false,
} satisfies AgentState;

/**
 * Forged the only way code outside `@repo/determination/clinician` can make
 * one: a cast. Every field is fabricated and labelled so.
 */
const forgedDenial = {
  kind: 'denial',
  specificReason: 'Synthetic fixture: forged outside the clinician entry point.',
  attestation: {
    reviewerId: 'synthetic-reviewer-001',
    credential: { type: 'synthetic-physician', jurisdiction: 'synthetic-jurisdiction' },
    attestedAt: '2026-09-26T14:00:00+00:00',
  },
} as unknown as AdverseDetermination;

describe('buildRunResponse', () => {
  it('returns the response when the state meets the contract', () => {
    const response = buildRunResponse(state);
    expect(response).toEqual({
      runId: state.runId,
      sessionId: state.sessionId,
      messages: state.messages,
      outcome: 'success',
      tokenCounts: state.tokenCounts,
      retrievedContext: state.retrievedContext,
    });
  });

  it('throws when a retrieved item breaks the contract, as a cast state can', () => {
    const broken = {
      ...state,
      retrievedContext: [{ source: 'pgvector', score: 0.9, content: 'x', episodeId: 'not-a-uuid' }],
    } as unknown as AgentState;
    expect(() => buildRunResponse(broken)).toThrow(/uuid/i);
  });

  it('throws when a message has a role the contract does not name', () => {
    const broken = {
      ...state,
      messages: [{ role: 'system', content: 'x' }],
    } as unknown as AgentState;
    expect(() => buildRunResponse(broken)).toThrow();
  });
});

describe('RunResponseSchema at egress', () => {
  it('refuses a denial carried under a key it does not declare, rather than stripping it', () => {
    const response = { ...buildRunResponse(state), disposition: forgedDenial };
    const result = RunResponseSchema.safeParse(response);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});
