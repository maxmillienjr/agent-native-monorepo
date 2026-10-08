import { randomUUID } from 'node:crypto';
import type {
  EpisodeWriteInput,
  EpisodicRepository,
  Neo4jWriter,
  PgvectorWriter,
} from '@repo/memory-core';

/** One write `reflect` asked for during a replay, which nothing performed. */
export type CapturedWrite =
  | { readonly store: 'episodes'; readonly sessionId: string; readonly turnIndex: number }
  | { readonly store: 'neo4j.concept'; readonly id: string }
  | {
      readonly store: 'neo4j.relationship';
      readonly fromId: string;
      readonly toId: string;
      readonly type: string;
    }
  | { readonly store: 'neo4j.fact'; readonly contentHash: string }
  | { readonly store: 'semantic_facts'; readonly contentHash: string };

/**
 * The three writers `reflect` takes, capturing instead of writing (P3-B).
 *
 * Replay re-executes a run, and `reflect` is a function of its recorded
 * inputs, so what it asks to write is what the run wrote — derived, not read
 * back from `episodes` or `semantic_facts`, which are first-write-wins and
 * keep the earliest run's provenance rather than this one's. Nothing here
 * holds a pool or a driver, so a replay cannot reach a store through it.
 *
 * Only keys are kept: a turn's content and a fact's text are content, and the
 * report that lists these is printed.
 */
export class CapturedWrites {
  private readonly captured: CapturedWrite[] = [];

  get writes(): readonly CapturedWrite[] {
    return this.captured;
  }

  readonly episodicRepo: EpisodicRepository = {
    write: async (input: EpisodeWriteInput) => {
      this.captured.push({
        store: 'episodes',
        sessionId: input.sessionId,
        turnIndex: input.turnIndex,
      });
      return { id: randomUUID() };
    },
    findBySession: async () => {
      throw new Error('a replay read episodic memory, which no node does and replay cannot serve');
    },
  };

  readonly neo4jWriter: Neo4jWriter = {
    mergeEntity: async (entity) => {
      this.captured.push({ store: 'neo4j.concept', id: entity.id });
    },
    mergeRelationship: async (relationship) => {
      this.captured.push({
        store: 'neo4j.relationship',
        fromId: relationship.fromId,
        toId: relationship.toId,
        type: relationship.type,
      });
    },
    mergeFact: async (fact) => {
      this.captured.push({ store: 'neo4j.fact', contentHash: fact.contentHash });
    },
  };

  readonly pgvectorWriter: PgvectorWriter = {
    upsertFact: async (fact) => {
      this.captured.push({ store: 'semantic_facts', contentHash: fact.contentHash });
    },
  };
}
