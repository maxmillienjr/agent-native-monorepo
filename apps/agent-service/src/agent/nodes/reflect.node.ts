import { createHash } from 'node:crypto';
import { withNodeSpan } from '@repo/telemetry';
import type { EpisodicRepository, Neo4jWriter, PgvectorWriter } from '@repo/memory-core';
import type { AgentState } from '../graph/state.js';

export interface ReflectNodeDeps {
  episodicRepo: EpisodicRepository;
  neo4jWriter: Neo4jWriter;
  pgvectorWriter: PgvectorWriter;
  embedText: (text: string) => Promise<number[]>;
}

/**
 * The sole writer to Episodic and Semantic memory. Pure I/O over idempotent
 * operations, and a function of `state.extraction` — which `distill` produced
 * — so a retried attempt writes exactly what the first attempt wrote.
 *
 * 1. Write messages to Episodic, keyed on (session_id, turn_index)
 * 2. MERGE entities and relationships into Neo4j
 * 3. Upsert facts into pgvector and the graph, keyed on the same content hash
 *
 * The guarantee is convergence under replay, not atomicity across the two
 * indices. ADR 0001 ruled out the mechanism that would give the latter: a
 * crash between the Neo4j write and the pgvector write leaves them disagreeing
 * until the retry, not permanently.
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

    span.setAttribute('entity_count', extraction.entities.length);
    span.setAttribute('relationship_count', extraction.relationships.length);
    span.setAttribute('fact_count', extraction.facts.length);

    // Step 2: MERGE entities and relationships into Neo4j (idempotent)
    for (const entity of extraction.entities) {
      await deps.neo4jWriter.mergeEntity(entity);
    }

    for (const rel of extraction.relationships) {
      await deps.neo4jWriter.mergeRelationship({
        ...rel,
        episodeId: state.runId,
        sessionId: state.sessionId,
        createdAt: new Date(),
      });
    }

    // Step 3: Upsert distilled facts into both indices, keyed on the same
    // content hash (idempotent). The Neo4j copy is what gives the graph and
    // vector retrievers one candidate universe to fuse over — see ADR 0004.
    const entityIds = extraction.entities.map((entity) => entity.id);

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

      // The session goes to the graph as it goes to pgvector: a graph read is
      // scoped to the facts a session owns and the edges it wrote (P2-D's M1).
      await deps.neo4jWriter.mergeFact({
        contentHash,
        text: fact.text,
        episodeId: state.runId,
        sessionId: state.sessionId,
        entityIds,
      });
    }

    // reflect is a side-effect node — does not modify agent state
    return {};
  });
}
