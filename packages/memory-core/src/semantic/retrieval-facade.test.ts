import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { EMBEDDING_DIMENSIONS } from './embedding.js';
import type { PgvectorReader, PgvectorSearchScope } from './pgvector/pgvector.reader.js';
import {
  RetrievalQuerySchema,
  VectorRetrievalFacade,
  type RetrievalCandidate,
} from './retrieval-facade.js';

const SESSION = '550e8400-e29b-41d4-a716-446655440001';
const queryEmbedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0.1);

const listed: RetrievalCandidate[] = [
  { source: 'pgvector', score: 0.91, content: 'first', contentHash: 'h1' },
  { source: 'pgvector', score: 0.87, content: 'second', contentHash: 'h2' },
];

/** A reader that records what it was asked and answers with `listed`. */
function recordingReader() {
  const calls: { topK: number; scope: PgvectorSearchScope | undefined }[] = [];
  const reader: PgvectorReader = {
    searchByCosine: async (_embedding, topK, scope) => {
      calls.push({ topK, scope });
      return listed;
    },
  };
  return { reader, calls };
}

describe('VectorRetrievalFacade', () => {
  it('returns the vector reader’s list unchanged: its order, its scores, no fusion', async () => {
    const { reader } = recordingReader();
    const result = await new VectorRetrievalFacade(reader).retrieve({
      queryEmbedding,
      sessionId: SESSION,
    });
    expect(result).toEqual(listed);
  });

  it('asks the reader for topK, not the 2 × topK the fused path over-fetched', async () => {
    const { reader, calls } = recordingReader();
    await new VectorRetrievalFacade(reader).retrieve({
      queryEmbedding,
      topK: 3,
      sessionId: SESSION,
    });
    expect(calls.map((c) => c.topK)).toEqual([3]);
  });

  it('passes the session scope through, and defaults crossSession to false', async () => {
    const { reader, calls } = recordingReader();
    const facade = new VectorRetrievalFacade(reader);
    await facade.retrieve({ queryEmbedding, sessionId: SESSION });
    await facade.retrieve({ queryEmbedding, sessionId: SESSION, crossSession: true });
    expect(calls.map((c) => c.scope)).toEqual([
      { sessionId: SESSION, crossSession: false },
      { sessionId: SESSION, crossSession: true },
    ]);
  });

  it('rejects an embedding of the wrong width before it reaches the reader', async () => {
    const { reader, calls } = recordingReader();
    await expect(
      new VectorRetrievalFacade(reader).retrieve({
        queryEmbedding: [0.1, 0.2],
        sessionId: SESSION,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});

describe('RetrievalQuerySchema, the scope a query must carry (P4-B, M2)', () => {
  it('rejects a query that has neither sessionId nor crossSession: true', () => {
    const result = RetrievalQuerySchema.safeParse({ queryEmbedding });
    expect(result.success).toBe(false);
    // A ZodError, which IO_RETRY does not retry, naming the field and the opt-out.
    expect(result.error).toBeInstanceOf(ZodError);
    expect(result.error?.issues[0]?.path).toEqual(['sessionId']);
    expect(result.error?.issues[0]?.message).toContain('crossSession: true');
  });

  it('rejects crossSession: false without a sessionId, the open default spelled out', () => {
    expect(RetrievalQuerySchema.safeParse({ queryEmbedding, crossSession: false }).success).toBe(
      false,
    );
  });

  it('accepts a sessionId, an explicit crossSession: true, or both', () => {
    for (const scope of [
      { sessionId: SESSION },
      { crossSession: true },
      { sessionId: SESSION, crossSession: true },
    ]) {
      expect(RetrievalQuerySchema.safeParse({ queryEmbedding, ...scope }).success).toBe(true);
    }
  });

  it('refuses an unscoped query before it reaches the reader', async () => {
    const { reader, calls } = recordingReader();
    await expect(new VectorRetrievalFacade(reader).retrieve({ queryEmbedding })).rejects.toThrow(
      ZodError,
    );
    expect(calls).toEqual([]);
  });
});
