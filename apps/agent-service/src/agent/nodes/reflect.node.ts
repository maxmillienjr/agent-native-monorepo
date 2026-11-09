import { createHash } from 'node:crypto';
import { withNodeSpan } from '@repo/telemetry';
import type { EpisodicRepository, PgvectorWriter } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

export interface ReflectNodeDeps {
  episodicRepo: EpisodicRepository;
  pgvectorWriter: PgvectorWriter;
  embedText: (text: string) => Promise<number[]>;
}

/**
 * The sole writer to Episodic and Semantic memory. Pure I/O over idempotent
 * operations, and a function of `state.extraction` — which `distill` produced
 * — so a retried attempt writes exactly what the first attempt wrote.
 *
 * 1. Write messages to Episodic, keyed on (session_id, turn_index)
 * 2. Embed each fact and upsert it into `semantic_facts`, keyed on its content hash
 *
 * Semantic memory is `semantic_facts` alone. The graph this node also used to
 * write was removed by ADR 0012's decision, and P2-E took its writes out of
 * here first.
 */
export async function reflectNode(
  state: AgentState,
  deps: ReflectNodeDeps,
): Promise<Partial<AgentState>> {
  return withNodeSpan('reflect', async (span) => {
    span.setAttribute('run_id', state.runId);
    span.setAttribute('session_id', state.sessionId);
    span.setAttribute('message_count', state.messages.length);

    // Step 1: Write messages to Episodic memory
    for (let i = 0; i < state.messages.length; i++) {
      const message = state.messages[i]!;
      await deps.episodicRepo.write({
        sessionId: state.sessionId,
        runId: state.runId,
        turnIndex: i,
        role: message.role,
        content: message.content,
        metadata: { tokenCounts: state.tokenCounts },
      });
    }

    // `distill` runs immediately before this node and always sets it. An
    // absent extraction means the channel was dropped between nodes — the
    // failure mode of forgetting a key in AgentStateAnnotation — and is
    // worth failing on rather than silently writing nothing.
    const extraction = state.extraction;
    if (!extraction) {
      throw new Error('reflect: state.extraction is missing — distill did not run');
    }

    span.setAttribute('fact_count', extraction.facts.length);

    // Step 2: Upsert distilled facts into semantic memory, keyed on the
    // content hash (idempotent).
    for (const fact of extraction.facts) {
      const contentHash = createHash('sha256').update(fact.text).digest('hex');
      const embedding = await deps.embedText(fact.text);

      await deps.pgvectorWriter.upsertFact({
        contentHash,
        text: fact.text,
        embedding,
        episodeId: state.runId,
        sessionId: state.sessionId,
      });
    }

    // reflect is a side-effect node — does not modify agent state
    return {};
  });
}
