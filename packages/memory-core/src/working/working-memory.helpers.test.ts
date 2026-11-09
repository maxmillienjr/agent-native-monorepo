import { describe, it, expect } from 'vitest';
import {
  WorkingMemorySchema,
  seedWorkingMemory,
  mergeRetrievedContext,
  appendToolOutput,
  addTokenCounts,
} from './working-memory.helpers.js';

const baseSeed = {
  runId: '550e8400-e29b-41d4-a716-446655440001',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  correlationId: 'corr-abc-123',
  messages: [{ role: 'user' as const, content: 'What is LangGraph?' }],
};

describe('seedWorkingMemory', () => {
  it('initializes with empty arrays and zero token counts', () => {
    const result = seedWorkingMemory(baseSeed);
    expect(result.retrievedContext).toEqual([]);
    expect(result.toolOutputs).toEqual([]);
    expect(result.tokenCounts).toEqual({ prompt: 0, completion: 0 });
    expect(result.outcome).toBeUndefined();
  });

  it('preserves input fields', () => {
    const result = seedWorkingMemory(baseSeed);
    expect(result.runId).toBe(baseSeed.runId);
    expect(result.sessionId).toBe(baseSeed.sessionId);
    expect(result.correlationId).toBe(baseSeed.correlationId);
    expect(result.messages).toEqual(baseSeed.messages);
  });

  it('throws on invalid input', () => {
    expect(() => seedWorkingMemory({ ...baseSeed, runId: 'not-a-uuid' })).toThrow();
  });
});

describe('mergeRetrievedContext', () => {
  it('replaces retrieved context with new candidates', () => {
    const state = seedWorkingMemory(baseSeed);
    const candidates = [
      { source: 'pgvector' as const, score: 0.9, content: 'fact 1' },
      { source: 'pgvector' as const, score: 0.8, content: 'fact 2' },
    ];
    const updated = mergeRetrievedContext(state, candidates);
    expect(updated.retrievedContext).toEqual(candidates);
    expect(updated.messages).toEqual(state.messages);
  });
});

describe('appendToolOutput', () => {
  it('appends to the tool outputs array', () => {
    const state = seedWorkingMemory(baseSeed);
    const updated = appendToolOutput(state, { tool: 'search', result: 'found it' });
    expect(updated.toolOutputs).toHaveLength(1);
    expect(state.toolOutputs).toHaveLength(0);
  });
});

describe('addTokenCounts', () => {
  it('accumulates token counts', () => {
    const state = seedWorkingMemory(baseSeed);
    const after1 = addTokenCounts(state, { prompt: 100, completion: 50 });
    const after2 = addTokenCounts(after1, { prompt: 80, completion: 30 });
    expect(after2.tokenCounts).toEqual({ prompt: 180, completion: 80 });
  });
});

describe('WorkingMemorySchema', () => {
  it('validates a complete working memory object', () => {
    const state = seedWorkingMemory(baseSeed);
    const result = WorkingMemorySchema.safeParse(state);
    expect(result.success).toBe(true);
  });

  it('rejects an object with invalid UUID fields', () => {
    const result = WorkingMemorySchema.safeParse({
      ...seedWorkingMemory(baseSeed),
      runId: 'bad',
    });
    expect(result.success).toBe(false);
  });
});
