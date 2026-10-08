import { describe, it, expect } from 'vitest';
import { shouldContinueActing } from './edges.js';
import type { AgentState } from './state.js';

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    runId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    correlationId: 'corr-123',
    messages: [],
    retrievedContext: [],
    toolOutputs: [],
    tokenCounts: { prompt: 0, completion: 0 },
    stepCount: 0,
    maxSteps: 10,
    topK: 10,
    shouldContinue: true,
    ...overrides,
  };
}

describe('shouldContinueActing', () => {
  it('returns "act" when under step limit and shouldContinue is true', () => {
    expect(shouldContinueActing(makeState({ stepCount: 3 }))).toBe('act');
  });

  it('returns "reflect" when stepCount reaches maxSteps', () => {
    expect(shouldContinueActing(makeState({ stepCount: 10, maxSteps: 10 }))).toBe('distill');
  });

  it('returns "reflect" when stepCount exceeds maxSteps', () => {
    expect(shouldContinueActing(makeState({ stepCount: 15, maxSteps: 10 }))).toBe('distill');
  });

  it('returns "reflect" when shouldContinue is false', () => {
    expect(shouldContinueActing(makeState({ shouldContinue: false }))).toBe('distill');
  });

  it('returns "reflect" when shouldContinue is false even with steps remaining', () => {
    expect(
      shouldContinueActing(makeState({ shouldContinue: false, stepCount: 1, maxSteps: 10 })),
    ).toBe('distill');
  });
});
