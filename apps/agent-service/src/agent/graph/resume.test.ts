import { describe, it, expect } from 'vitest';
import { MemorySaver } from '@langchain/langgraph';
import { EMBEDDING_DIMENSIONS } from '@repo/memory-core';
import { buildAgentGraph, type GraphDeps } from './graph.js';
import { NO_USAGE } from '../model/usage.js';

/**
 * The reason `distill` is a separate node.
 *
 * A crash between extraction and the writes must resume at `reflect` without
 * paying for the model call again — and, more importantly, without re-deriving
 * what to write. Attempt 2 of a combined node could word a fact differently,
 * which changes its sha256, so the pgvector upsert would have nothing to
 * collapse onto and the row would land in addition to the first attempt's.
 *
 * `MemorySaver` stands in for `PostgresSaver` here because what is being
 * asserted is a property of the graph and the checkpoint, not of the storage
 * backend. The Postgres path is exercised at boot and asserted by the
 * checkpoints-per-thread criterion.
 */
function makeDeps(onDistill: () => void, reflect: { fail: boolean }): GraphDeps {
  const embedding = async () => new Array(EMBEDDING_DIMENSIONS).fill(0);

  return {
    retrieve: { retrievalFacade: { retrieve: async () => [] }, embedQuery: embedding },
    plan: {
      callLlm: async () => ({ content: 'a plan', tokenCounts: { prompt: 0, completion: 0 } }),
    },
    act: { tools: [], selectTool: async () => ({ selection: null, tokenCounts: NO_USAGE }) },
    distill: {
      extractEntities: async () => {
        onDistill();
        return {
          extraction: {
            entities: [{ id: 'langgraph', label: 'LangGraph' }],
            relationships: [],
            facts: [{ text: 'A fact worth keeping.' }],
          },
          tokenCounts: NO_USAGE,
        };
      },
    },
    reflect: {
      episodicRepo: {
        write: async () => {
          if (reflect.fail) throw new Error('EHOSTUNREACH: postgres went away');
          return { id: '550e8400-e29b-41d4-a716-446655440002' };
        },
        findBySession: async () => [],
      },
      neo4jWriter: {
        mergeEntity: async () => {},
        mergeRelationship: async () => {},
        mergeFact: async () => {},
      },
      pgvectorWriter: { upsertFact: async () => {} },
      embedText: embedding,
    },
  };
}

describe('resuming a run on the same thread_id', () => {
  it('does not re-run distill after a failure in reflect', async () => {
    const checkpointer = new MemorySaver();
    const runId = '550e8400-e29b-41d4-a716-446655440007';
    const config = { configurable: { thread_id: runId } };
    const body = {
      sessionId: '550e8400-e29b-41d4-a716-446655440000',
      messages: [{ role: 'user', content: 'What is LangGraph?' }],
    };

    let distillCalls = 0;
    const count = () => {
      distillCalls += 1;
    };

    // First attempt: reflect's store is unreachable. IO_RETRY exhausts its
    // three attempts and the run fails with the checkpoint intact.
    const failing = buildAgentGraph(
      makeDeps(count, { fail: true }),
      body,
      'corr-123',
      checkpointer,
    );
    await expect(failing.invoke({ runId }, config)).rejects.toThrow('EHOSTUNREACH');

    const afterFirst = distillCalls;
    expect(afterFirst).toBe(1);

    // Second attempt on the same thread: the store is back.
    const recovered = buildAgentGraph(
      makeDeps(count, { fail: false }),
      body,
      'corr-123',
      checkpointer,
    );
    const result = (await recovered.invoke(null, config)) as { outcome?: string };

    expect(result.outcome).toBe('success');
    expect(distillCalls).toBe(1);
  }, 20_000);
});
