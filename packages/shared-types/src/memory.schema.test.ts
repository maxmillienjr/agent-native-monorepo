import { describe, it, expect } from 'vitest';
import {
  MessageSchema,
  RetrievedContextItemSchema,
  TokenCountsSchema,
  OutcomeSchema,
} from './memory.schema.js';

describe('MessageSchema', () => {
  it('accepts a valid user message', () => {
    const result = MessageSchema.safeParse({ role: 'user', content: 'hello' });
    expect(result.success).toBe(true);
  });

  it('accepts all valid roles', () => {
    for (const role of ['user', 'assistant', 'tool'] as const) {
      const result = MessageSchema.safeParse({ role, content: 'test' });
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid role', () => {
    const result = MessageSchema.safeParse({ role: 'system', content: 'hello' });
    expect(result.success).toBe(false);
  });

  it('rejects a missing content field', () => {
    const result = MessageSchema.safeParse({ role: 'user' });
    expect(result.success).toBe(false);
  });
});

describe('RetrievedContextItemSchema', () => {
  it('accepts a valid neo4j item', () => {
    const result = RetrievedContextItemSchema.safeParse({
      source: 'neo4j',
      score: 0.85,
      content: 'LangGraph is a framework for building stateful agents.',
      entityId: 'langgraph',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid pgvector item with episodeId', () => {
    const result = RetrievedContextItemSchema.safeParse({
      source: 'pgvector',
      score: 0.72,
      content: 'Agents use memory tiers for persistence.',
      episodeId: '550e8400-e29b-41d4-a716-446655440000',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid source', () => {
    const result = RetrievedContextItemSchema.safeParse({
      source: 'pinecone',
      score: 0.5,
      content: 'test',
    });
    expect(result.success).toBe(false);
  });
});

describe('TokenCountsSchema', () => {
  it('accepts valid token counts', () => {
    const result = TokenCountsSchema.safeParse({ prompt: 100, completion: 50 });
    expect(result.success).toBe(true);
  });

  it('rejects negative token counts', () => {
    const result = TokenCountsSchema.safeParse({ prompt: -1, completion: 50 });
    expect(result.success).toBe(false);
  });
});

describe('OutcomeSchema', () => {
  it('accepts all valid outcomes', () => {
    for (const outcome of ['success', 'error', 'partial', 'awaiting-approval'] as const) {
      const result = OutcomeSchema.safeParse(outcome);
      expect(result.success).toBe(true);
    }
  });

  it('rejects an invalid outcome', () => {
    const result = OutcomeSchema.safeParse('timeout');
    expect(result.success).toBe(false);
  });
});
