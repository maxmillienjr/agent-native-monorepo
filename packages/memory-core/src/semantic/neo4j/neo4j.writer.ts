import { z } from 'zod';
import type { Driver } from 'neo4j-driver';
import { getTracer } from '@repo/telemetry';
import { GEN_AI, GEN_AI_OPERATION } from '@repo/telemetry/genai';

const tracer = getTracer('memory-core');

/**
 * `gen_ai.operation.name` on this file's spans. The span names predate the
 * conventions and stay; the operation is the part a GenAI-aware backend reads.
 */
const UPSERT = {
  attributes: { [GEN_AI.OPERATION_NAME]: GEN_AI_OPERATION.UPSERT_MEMORY },
};

export const EntityWriteSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});

export const RelationshipWriteSchema = z.object({
  fromId: z.string(),
  toId: z.string(),
  type: z.string(),
  confidence: z.number().min(0).max(1),
  episodeId: z.string().uuid(),
  createdAt: z.date().default(() => new Date()),
});

export const FactWriteSchema = z.object({
  contentHash: z.string(),
  text: z.string(),
  episodeId: z.string().uuid(),
  entityIds: z.array(z.string()).default([]),
});

export interface Neo4jWriter {
  mergeEntity(entity: z.infer<typeof EntityWriteSchema>): Promise<void>;
  mergeRelationship(rel: z.infer<typeof RelationshipWriteSchema>): Promise<void>;
  mergeFact(fact: z.infer<typeof FactWriteSchema>): Promise<void>;
}

export class CypherNeo4jWriter implements Neo4jWriter {
  constructor(private readonly driver: Driver) {}

  async mergeEntity(entity: z.infer<typeof EntityWriteSchema>): Promise<void> {
    const validated = EntityWriteSchema.parse(entity);

    return tracer.startActiveSpan('memory.neo4j.mergeEntity', UPSERT, async (span) => {
      try {
        // No id on the span. `distill` extracts it from the conversation, so
        // it is content, and in the payer domain it can be a member's name.
        // ALLOWED_SPAN_ATTRIBUTES in @repo/telemetry is what keeps it off.
        const session = this.driver.session();
        try {
          await session.run(
            `MERGE (c:Concept {id: $id})
             ON CREATE SET c.label = $label, c.description = $description
             ON MATCH SET c.label = $label, c.description = $description`,
            {
              id: validated.id,
              label: validated.label,
              description: validated.description ?? null,
            },
          );
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }

  /**
   * Writes a fact into the graph and links it to the concepts it mentions.
   *
   * This is what makes fusion possible. Before it existed the graph held only
   * `:Concept` nodes while pgvector held facts, so the two retrievers returned
   * different kinds of object and RRF had two disjoint universes to merge —
   * no candidate could appear in both lists, so no score was ever summed and
   * the result was interleaving rather than fusion. Keyed on the same
   * `contentHash` pgvector uses, a fact found by both paths is now one
   * candidate. ADR 0004 records the decision.
   */
  async mergeFact(fact: z.infer<typeof FactWriteSchema>): Promise<void> {
    const validated = FactWriteSchema.parse(fact);

    return tracer.startActiveSpan('memory.neo4j.mergeFact', UPSERT, async (span) => {
      try {
        span.setAttribute('fact.contentHash', validated.contentHash);
        span.setAttribute('fact.entityCount', validated.entityIds.length);

        const session = this.driver.session();
        try {
          // The fact node is merged before the UNWIND, so an extraction that
          // produced facts but no entities still lands the fact — an empty
          // list ends the pipeline after the MERGE, it does not undo it.
          await session.run(
            `MERGE (f:Fact {contentHash: $contentHash})
             ON CREATE SET f.text = $text, f.episodeId = $episodeId
             ON MATCH SET f.text = $text
             WITH f
             UNWIND $entityIds AS eid
             MATCH (c:Concept {id: eid})
             MERGE (f)-[:MENTIONS]->(c)`,
            {
              contentHash: validated.contentHash,
              text: validated.text,
              episodeId: validated.episodeId,
              entityIds: validated.entityIds,
            },
          );
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }

  async mergeRelationship(rel: z.infer<typeof RelationshipWriteSchema>): Promise<void> {
    const validated = RelationshipWriteSchema.parse(rel);

    return tracer.startActiveSpan('memory.neo4j.mergeRelationship', UPSERT, async (span) => {
      try {
        // Neither endpoint nor the type: all three are model output taken
        // from the conversation, like the entity id above.
        const session = this.driver.session();
        try {
          await session.run(
            `MERGE (a:Concept {id: $fromId})
             MERGE (b:Concept {id: $toId})
             MERGE (a)-[r:RELATES_TO {type: $type}]->(b)
             ON CREATE SET r.confidence = $confidence,
                           r.episodeId = $episodeId,
                           r.createdAt = datetime($createdAt)
             ON MATCH SET r.confidence = $confidence,
                          r.episodeId = $episodeId`,
            {
              fromId: validated.fromId,
              toId: validated.toId,
              type: validated.type,
              confidence: validated.confidence,
              episodeId: validated.episodeId,
              createdAt: validated.createdAt.toISOString(),
            },
          );
        } finally {
          await session.close();
        }
      } finally {
        span.end();
      }
    });
  }
}
