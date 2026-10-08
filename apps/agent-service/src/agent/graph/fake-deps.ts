import { EMBEDDING_DIMENSIONS } from '@repo/memory-core';
import { NO_USAGE } from '../model/usage.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolSelection, ToolSelectionRequest } from '../tools/selection.js';
import type { GraphDeps } from './graph.js';

/**
 * A dependency set for the pure axis: no store, no network, and a model whose
 * selections are a script.
 *
 * Fakes stand in for the model here because the tests that use this check the
 * loop, the saga and the gate, not the agent's choices; those are checked on
 * the live and replay axes. Every request `act` sends is kept, in order.
 */
export function scriptedDeps(
  registry: ToolRegistry,
  script: readonly (ToolSelection | null)[],
): { deps: GraphDeps; requests: ToolSelectionRequest[] } {
  const requests: ToolSelectionRequest[] = [];
  const remaining = [...script];
  const embedding = () => Promise.resolve(new Array<number>(EMBEDDING_DIMENSIONS).fill(0));

  return {
    requests,
    deps: {
      retrieve: { retrievalFacade: { retrieve: async () => [] }, embedQuery: embedding },
      plan: { callLlm: async () => ({ content: 'a plan', tokenCounts: NO_USAGE }) },
      act: {
        registry,
        selectTool: async (request) => {
          requests.push(request);
          return { selection: remaining.shift() ?? null, tokenCounts: NO_USAGE };
        },
      },
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
    },
  };
}

/** A request body for a run of up to `maxSteps` act steps. */
export const runBody = (maxSteps = 5) => ({
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  messages: [{ role: 'user', content: 'Ask for the missing records on the case.' }],
  config: { maxSteps },
});
