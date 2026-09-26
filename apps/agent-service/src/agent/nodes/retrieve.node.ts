import { withNodeSpan } from '@repo/telemetry';
import type { RetrievalFacade } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

/**
 * The seed linker: the graph retriever's only way in from a query.
 *
 * It keeps capitalized words longer than two characters, lowercases them and
 * deletes every character outside `[a-z0-9-]`. It does not match concepts:
 * each word becomes a candidate id on its own, so `Prior Authorization` is
 * `["prior", "authorization"]`, and an id containing `_` — which the live
 * extraction writes for most entities — can never be produced.
 *
 * Exported for P2-B's ablation, which measures this function as deployed. A
 * copy there would measure a linker nobody runs.
 */
export function extractSeedEntityIds(messages: AgentState['messages']): string[] {
  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage) return [];

  const words = lastUserMessage.content.split(/\s+/);
  return words
    .filter((w) => w.length > 2 && /^[A-Z]/.test(w))
    .map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, ''));
}

export interface RetrieveNodeDeps {
  retrievalFacade: RetrievalFacade;
  embedQuery: (text: string) => Promise<number[]>;
}

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
    const seedEntityIds = extractSeedEntityIds(state.messages);

    const candidates = await deps.retrievalFacade.retrieve({
      queryEmbedding,
      seedEntityIds,
      topK: state.topK,
      hopDepth: state.hopDepth,
      sessionId: state.sessionId,
    });

    span.setAttribute('candidateCount', candidates.length);

    return { retrievedContext: candidates };
  });
}
