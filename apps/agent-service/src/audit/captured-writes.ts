import { randomUUID } from 'node:crypto';
import type { EpisodeWriteInput, EpisodicRepository, PgvectorWriter } from '@repo/memory-core';

/** One write `reflect` asked for during a replay, which nothing performed. */
export type CapturedWrite =
  | { readonly store: 'episodes'; readonly sessionId: string; readonly turnIndex: number }
  | { readonly store: 'semantic_facts'; readonly contentHash: string };

/**
 * The writers `reflect` takes, capturing instead of writing (P3-B).
 *
 * Replay re-executes a run, and `reflect` is a function of its recorded
 * inputs, so what it asks to write is what the run wrote — derived, not read
 * back from `episodes` or `semantic_facts`, which are first-write-wins and
 * keep the earliest run's provenance rather than this one's. Nothing here
 * holds a pool, so a replay cannot reach a store through it.
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

  readonly pgvectorWriter: PgvectorWriter = {
    upsertFact: async (fact) => {
      this.captured.push({ store: 'semantic_facts', contentHash: fact.contentHash });
    },
  };
}
