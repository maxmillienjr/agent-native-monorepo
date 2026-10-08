import { withNodeSpan } from '@repo/telemetry';
import type { RetrievalFacade } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

export interface RetrieveNodeDeps {
  retrievalFacade: RetrievalFacade;
  embedQuery: (text: string) => Promise<number[]>;
}

/**
 * Semantic recall: the last user turn, embedded and searched in the
 * requesting session's facts.
 *
 * Vector-only since ADR 0009. The node used to derive graph seed ids from the
 * query's capitalized words and pass them to a facade that fused the graph's
 * list with the vector list. P2-B measured that and it did not help, so the
 * seed linker left the request path; it is kept, frozen, only where the
 * ablation reproduces the fused path (`eval/seed-linker.ts`).
 */
export async function retrieveNode(
  state: AgentState,
  deps: RetrieveNodeDeps,
): Promise<Partial<AgentState>> {
  return withNodeSpan('retrieve', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);

    const lastUserMessage = [...state.messages].reverse().find((m) => m.role === 'user');
    if (!lastUserMessage) {
      return { retrievedContext: [] };
    }

    const queryEmbedding = await deps.embedQuery(lastUserMessage.content);

    const candidates = await deps.retrievalFacade.retrieve({
      queryEmbedding,
      topK: state.topK,
      sessionId: state.sessionId,
    });

    span.setAttribute('candidateCount', candidates.length);

    return { retrievedContext: candidates };
  });
}
