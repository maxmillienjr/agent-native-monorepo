import { describe, it, expect } from 'vitest';
import { shouldContinueActing, shouldKeepCompensating } from './edges.js';
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
    aborted: false,
    ...overrides,
  };
}

const applied = {
  toolName: 'request-records',
  input: {},
  output: { requestId: 'RR-000001' },
  tier: 'compensable' as const,
  idempotencyKey: 'run:0',
  effect: 'applied' as const,
};
const failed = {
  toolName: 'request-records',
  input: {},
  output: null,
  error: 'no case PA-999999 on the board',
  tier: 'compensable' as const,
  idempotencyKey: 'run:1',
  effect: 'none' as const,
};

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

  it('leaves the loop on a failed step with nothing to undo, whatever the step bound says', () => {
    expect(shouldContinueActing(makeState({ aborted: true, stepCount: 1 }))).toBe('distill');
  });

  it('compensates a failed step when an effect is applied, even on the last step', () => {
    const toolOutputs = [applied, failed];
    expect(shouldContinueActing(makeState({ aborted: true, toolOutputs }))).toBe('compensate');
    expect(
      shouldContinueActing(makeState({ aborted: true, toolOutputs, stepCount: 10, maxSteps: 10 })),
    ).toBe('compensate');
  });

  it('does not compensate a run that finished cleanly', () => {
    expect(shouldContinueActing(makeState({ shouldContinue: false, toolOutputs: [applied] }))).toBe(
      'distill',
    );
  });
});

describe('shouldKeepCompensating', () => {
  it('loops while an effect is applied, and leaves once none is', () => {
    expect(shouldKeepCompensating(makeState({ toolOutputs: [applied, failed] }))).toBe('compensate');
    expect(
      shouldKeepCompensating(makeState({ toolOutputs: [{ ...applied, effect: 'compensated' }] })),
    ).toBe('distill');
  });
});
