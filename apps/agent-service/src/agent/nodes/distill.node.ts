import { withNodeSpan } from '@repo/telemetry';
import type { AgentState, Extraction } from '../graph/state.js';

export interface DistillNodeDeps {
  extractEntities: (context: string) => Promise<Extraction>;
}

/**
 * One model call, no I/O against a store. Produces the extraction that
 * `reflect` writes.
 *
 * This node exists so that `reflect` can carry a retry policy. Retrying a node
 * is only replay-safe when the node is a function of its input state, and a
 * `reflect` that extracted its own entities was not: attempt 2 would make a
 * second model call and could word a fact differently, which changes its
 * sha256 — so the pgvector upsert would have nothing to collapse onto and the
 * row would land *in addition to* attempt 1's. Same for a `:Concept` id the
 * model renders differently. Idempotency per write is not convergence per
 * node.
 *
 * Split out, `reflect` reads `state.extraction` and attempt n writes exactly
 * what attempt 1 wrote. The checkpoint between the two also means a crash
 * after extraction resumes at `reflect` without paying for the model call
 * again.
 */
export async function distillNode(
  state: AgentState,
  deps: DistillNodeDeps,
): Promise<Partial<AgentState>> {
  return withNodeSpan('distill', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);

    const sessionContext = state.messages.map((m) => `${m.role}: ${m.content}`).join('\n');
    const extraction = await deps.extractEntities(sessionContext);

    span.setAttribute('entity_count', extraction.entities.length);
    span.setAttribute('relationship_count', extraction.relationships.length);
    span.setAttribute('fact_count', extraction.facts.length);

    return { extraction };
  });
}
