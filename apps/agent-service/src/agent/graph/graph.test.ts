import { describe, it, expect } from 'vitest';
import { EMBEDDING_DIMENSIONS } from '@repo/memory-core';
import { CassetteMissError } from '@repo/agent-cassette';
import { buildAgentGraph, type GraphDeps } from './graph.js';
import { NO_USAGE } from '../model/usage.js';
import { RunRecordWriteError } from '../../audit/persisting-deck.js';

/**
 * The graph is assembled at request time, so a construction error surfaces as a
 * 500 rather than a startup failure. The specific error this guards against —
 * a state channel colliding with a node name — is thrown by `addNode` and is
 * invisible to a type check. Nothing but calling `buildAgentGraph` catches it.
 */
function makeDeps(): GraphDeps {
  const embedding = () => Promise.resolve(new Array(EMBEDDING_DIMENSIONS).fill(0));

  return {
    retrieve: {
      retrievalFacade: { retrieve: async () => [] },
      embedQuery: embedding,
    },
    plan: {
      callLlm: async () => ({ content: 'a plan', tokenCounts: { prompt: 0, completion: 0 } }),
    },
    act: { tools: [], selectTool: async () => ({ selection: null, tokenCounts: NO_USAGE }) },
    distill: {
      extractEntities: async () => ({
        extraction: { entities: [], relationships: [], facts: [] },
        tokenCounts: NO_USAGE,
      }),
    },
    reflect: {
      episodicRepo: {
        write: async () => ({ id: '550e8400-e29b-41d4-a716-446655440002' }),
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

describe('buildAgentGraph', () => {
  it('compiles without throwing', () => {
    expect(() => buildAgentGraph(makeDeps(), {}, 'corr-123')).not.toThrow();
  });

  it('returns an invocable compiled graph', () => {
    const compiled = buildAgentGraph(makeDeps(), {}, 'corr-123');

    expect(typeof compiled.invoke).toBe('function');
    expect(typeof compiled.stream).toBe('function');
  });

  it('registers all seven nodes without colliding with a state channel', () => {
    const compiled = buildAgentGraph(makeDeps(), {}, 'corr-123');
    const nodes = Object.keys(compiled.getGraph().nodes)
      .filter((name) => !name.startsWith('__'))
      .sort();

    // `distill` is the seventh. `extraction` is the channel it writes and
    // `distill` is the node — the separation P0-A's rename established, and
    // the collision this test exists to catch.
    expect(nodes).toEqual(['act', 'distill', 'egress', 'ingress', 'plan', 'reflect', 'retrieve']);
  });

  it('carries `extraction` as a state channel, so reflect can read it', async () => {
    // A key present in AgentStateSchema but absent from AgentStateAnnotation
    // is dropped between nodes, and the failure mode is a `reflect` that
    // silently writes nothing.
    const written: string[] = [];
    const deps = makeDeps();
    deps.distill = {
      extractEntities: async () => ({
        extraction: {
          entities: [{ id: 'langgraph', label: 'LangGraph' }],
          relationships: [],
          facts: [{ text: 'A fact worth keeping.' }],
        },
        tokenCounts: NO_USAGE,
      }),
    };
    deps.reflect.neo4jWriter = {
      mergeEntity: async (entity) => {
        written.push(entity.id);
      },
      mergeRelationship: async () => {},
      mergeFact: async () => {},
    };

    const compiled = buildAgentGraph(
      deps,
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      },
      'corr-123',
    );
    await compiled.invoke({ runId: '550e8400-e29b-41d4-a716-446655440003' });

    expect(written).toEqual(['langgraph']);
  });

  it('retries an I/O node that fails twice and succeeds on the third attempt', async () => {
    // A transient Neo4j error used to fail the run outright — retryPolicy
    // occurred zero times in source. IO_RETRY allows three attempts.
    let attempts = 0;
    const deps = makeDeps();
    deps.retrieve.retrievalFacade = {
      retrieve: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('ServiceUnavailable: connection refused');
        return [];
      },
    };

    const compiled = buildAgentGraph(
      deps,
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      },
      'corr-123',
    );
    const result = (await compiled.invoke({
      runId: '550e8400-e29b-41d4-a716-446655440004',
    })) as { outcome?: string };

    expect(attempts).toBe(3);
    expect(result.outcome).toBe('success');
  });

  it('does not retry a client error', async () => {
    // Retrying a 4xx spends latency to reach the same answer, so retryOn
    // excludes it. Observed live: a 403 from embedContent failed immediately
    // rather than three times.
    let attempts = 0;
    const deps = makeDeps();
    deps.retrieve.embedQuery = async () => {
      attempts += 1;
      throw Object.assign(new Error('embedContent failed: 403'), { status: 403 });
    };

    const compiled = buildAgentGraph(
      deps,
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      },
      'corr-123',
    );

    await expect(
      compiled.invoke({ runId: '550e8400-e29b-41d4-a716-446655440005' }),
    ).rejects.toThrow('403');
    expect(attempts).toBe(1);
  });

  it('does not retry a cassette miss', async () => {
    // A miss consumes no entry, so a retry asks the same deck the same question
    // and misses again. It used to be tried three times, 400ms and 800ms apart,
    // before the diff it carries reached anyone.
    let attempts = 0;
    const deps = makeDeps();
    deps.plan.callLlm = async () => {
      attempts += 1;
      throw new CassetteMissError('plan.callLlm', undefined, 'abc123', '- old\n+ new');
    };

    const compiled = buildAgentGraph(
      deps,
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      },
      'corr-123',
    );

    await expect(
      compiled.invoke({ runId: '550e8400-e29b-41d4-a716-446655440006' }),
    ).rejects.toThrow(CassetteMissError);
    expect(attempts).toBe(1);
  });

  it('does not retry a run record that could not be written', async () => {
    // On the fail-closed path a retried node would make the model call again,
    // and its answer could not be recorded either (P3-B).
    let attempts = 0;
    const deps = makeDeps();
    deps.plan.callLlm = async () => {
      attempts += 1;
      throw new RunRecordWriteError('decision 2 could not be recorded');
    };

    const compiled = buildAgentGraph(
      deps,
      {
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        messages: [{ role: 'user', content: 'What is LangGraph?' }],
      },
      'corr-123',
    );

    await expect(
      compiled.invoke({ runId: '550e8400-e29b-41d4-a716-446655440007' }),
    ).rejects.toThrow(RunRecordWriteError);
    expect(attempts).toBe(1);
  });
});
