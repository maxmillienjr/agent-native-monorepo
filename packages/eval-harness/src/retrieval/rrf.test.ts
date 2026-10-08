import { describe, it, expect } from 'vitest';
import type { RetrievalCandidate } from '@repo/memory-core';
import { rrfMerge } from './rrf.js';

describe('rrfMerge', () => {
  const pgvectorResults: RetrievalCandidate[] = [
    { source: 'pgvector', score: 0.95, content: 'LangGraph enables stateful agents.' },
    { source: 'pgvector', score: 0.88, content: 'Agents use memory tiers.' },
    { source: 'pgvector', score: 0.75, content: 'pgvector stores embeddings.' },
  ];

  const neo4jResults: RetrievalCandidate[] = [
    { source: 'neo4j', score: 0.9, content: 'Agents use memory tiers.', entityId: 'memory-tiers' },
    { source: 'neo4j', score: 0.8, content: 'Neo4j enables graph traversal.', entityId: 'neo4j' },
    { source: 'neo4j', score: 0.6, content: 'RRF merges ranked lists.', entityId: 'rrf' },
  ];

  it('returns results sorted by RRF score descending', () => {
    const merged = rrfMerge([pgvectorResults, neo4jResults], 10);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]!.score).toBeLessThanOrEqual(merged[i - 1]!.score);
    }
  });

  it('boosts candidates appearing in both lists', () => {
    const merged = rrfMerge([pgvectorResults, neo4jResults], 10);
    // "Agents use memory tiers." appears in both lists and should be ranked highly
    const sharedCandidate = merged.find((c) => c.content === 'Agents use memory tiers.');
    const uniqueCandidate = merged.find((c) => c.content === 'pgvector stores embeddings.');
    expect(sharedCandidate).toBeDefined();
    expect(uniqueCandidate).toBeDefined();
    expect(sharedCandidate!.score).toBeGreaterThan(uniqueCandidate!.score);
  });

  it('respects the topK limit', () => {
    const merged = rrfMerge([pgvectorResults, neo4jResults], 2);
    expect(merged.length).toBe(2);
  });

  it('handles empty lists gracefully', () => {
    const merged = rrfMerge([[], []], 10);
    expect(merged).toEqual([]);
  });

  it('handles a single list', () => {
    const merged = rrfMerge([pgvectorResults], 10);
    expect(merged.length).toBe(pgvectorResults.length);
    expect(merged[0]!.content).toBe(pgvectorResults[0]!.content);
  });

  it('produces monotonically decreasing scores', () => {
    const merged = rrfMerge([pgvectorResults, neo4jResults], 10);
    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]!.score).toBeLessThanOrEqual(merged[i - 1]!.score);
    }
  });
});
