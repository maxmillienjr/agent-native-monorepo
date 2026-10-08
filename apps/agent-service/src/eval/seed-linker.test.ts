import { describe, it, expect } from 'vitest';
import { extractSeedEntityIds } from './seed-linker.js';

const user = (content: string) => [{ role: 'user' as const, content }];

describe('extractSeedEntityIds', () => {
  it('turns each capitalized word longer than two characters into a lowercased id', () => {
    expect(extractSeedEntityIds(user('What do my notes say about LangGraph?'))).toEqual([
      'what',
      'langgraph',
    ]);
  });

  it('splits a multi-word name into one candidate per word', () => {
    expect(extractSeedEntityIds(user('Explain Prior Authorization rules'))).toEqual([
      'explain',
      'prior',
      'authorization',
    ]);
  });

  it('deletes underscores, so a snake_case id can never be produced', () => {
    // The live extraction writes ids like `tech_pgvector`; a query that types
    // the id itself still cannot reach it.
    expect(extractSeedEntityIds(user('Tell me about Tech_pgvector'))).toEqual([
      'tell',
      'techpgvector',
    ]);
  });

  it('reads only the last user message and ignores lowercase text', () => {
    expect(
      extractSeedEntityIds([
        { role: 'user' as const, content: 'About LangGraph' },
        { role: 'assistant' as const, content: 'Sure' },
        { role: 'user' as const, content: 'what about pgvector?' },
      ]),
    ).toEqual([]);
  });
});
