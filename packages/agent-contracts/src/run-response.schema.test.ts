import { describe, it, expect } from 'vitest';
import { RunResponseSchema, StreamEventSchema } from './run-response.schema.js';

describe('RunResponseSchema', () => {
  const validResponse = {
    runId: '550e8400-e29b-41d4-a716-446655440001',
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [
      { role: 'user' as const, content: 'What is LangGraph?' },
      {
        role: 'assistant' as const,
        content: 'LangGraph is a framework for building stateful agents.',
      },
    ],
    outcome: 'success' as const,
    tokenCounts: { prompt: 120, completion: 45 },
    retrievedContext: [
      {
        source: 'pgvector' as const,
        score: 0.85,
        content: 'LangGraph enables stateful workflows.',
      },
    ],
  };

  it('accepts a valid response', () => {
    const result = RunResponseSchema.safeParse(validResponse);
    expect(result.success).toBe(true);
  });

  it('rejects a response with missing outcome', () => {
    const { outcome: _, ...partial } = validResponse;
    const result = RunResponseSchema.safeParse(partial);
    expect(result.success).toBe(false);
  });

  it('rejects a key it does not declare instead of stripping it', () => {
    const result = RunResponseSchema.safeParse({ ...validResponse, undeclared: true });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.code).toBe('unrecognized_keys');
  });
});

describe('StreamEventSchema', () => {
  it('accepts a node event with delta', () => {
    const result = StreamEventSchema.safeParse({
      node: 'plan',
      delta: 'Analyzing the query...',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a node event with state', () => {
    const result = StreamEventSchema.safeParse({
      node: 'egress',
      state: {
        outcome: 'success',
        tokenCounts: { prompt: 100, completion: 50 },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a minimal node event', () => {
    const result = StreamEventSchema.safeParse({ node: 'ingress' });
    expect(result.success).toBe(true);
  });
});
