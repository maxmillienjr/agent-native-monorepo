import { withNodeSpan } from '@repo/telemetry';
import type { RetrievalFacade } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

/**
 * Lightweight entity extraction from query text.
 * In production, this would use an NER model; here we extract
 * capitalized multi-word phrases as candidate entity IDs.
 */
function extractSeedEntityIds(messages: AgentState['messages']): string[] {
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
