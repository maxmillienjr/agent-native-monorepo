import { describe, it, expect } from 'vitest';
import { RunRequestSchema } from './run-request.schema.js';

describe('RunRequestSchema', () => {
  const validRequest = {
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    messages: [{ role: 'user' as const, content: 'What is LangGraph?' }],
  };

  it('accepts a valid request with defaults', () => {
    const result = RunRequestSchema.safeParse(validRequest);
    expect(result.success).toBe(true);
  });

  it('accepts a request with custom config', () => {
    const result = RunRequestSchema.safeParse({
      ...validRequest,
      config: { maxSteps: 5, topK: 20 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config?.maxSteps).toBe(5);
    }
  });

  it('rejects a request without messages', () => {
    const result = RunRequestSchema.safeParse({
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid sessionId', () => {
    const result = RunRequestSchema.safeParse({
      sessionId: 'not-a-uuid',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(result.success).toBe(false);
  });

  it('strips hopDepth, which nothing reads since retrieval became vector-only', () => {
    const result = RunRequestSchema.safeParse({
      ...validRequest,
      config: { hopDepth: 5 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.config).not.toHaveProperty('hopDepth');
    }
  });
});
